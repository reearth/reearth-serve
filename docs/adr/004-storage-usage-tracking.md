# ADR-004: Storage Usage Tracking per Project and Workspace

- **Status:** Accepted
- **Date:** 2026-03-17
- **Deciders:** @rot1024

## Context

With Phase 2 (projects, workspaces, persistent assets) complete, Re:Earth Serve needs to track storage consumption per project and per workspace. This enables:
- Displaying storage usage on dashboards
- Enforcing storage quotas (future)
- Usage metering for billing integration (Phase 8)

The system runs on Cloudflare KV, which is eventually consistent and does not support atomic read-modify-write operations.

## Decision

### KV Key Design

Store usage counters as separate KV keys, independent of project/workspace entity records:

```
storage_usage:project:{projectId}     → { totalSize, assetCount, updatedAt }
storage_usage:workspace:{workspaceId} → { totalSize, assetCount, updatedAt }
```

**Why separate keys?**
- Avoids read-modify-write on the project/workspace record for every upload/delete
- Follows the existing pattern of index keys being separate from entity keys (e.g., `asset_list:project:*`)
- Allows independent cache/TTL tuning if needed

**What `totalSize` counts:**
- The sum of `size` (bytes stored in R2) for all assets in the scope
- For archives, this is the original upload size, not `extractedSize` — extracted files are stored separately
- `extractedSize` tracking can be added later if needed

### Repository Interface

```typescript
interface StorageUsage {
  totalSize: number;
  assetCount: number;
  updatedAt: number;
}

interface StorageUsageStore {
  get(scope: string): Promise<StorageUsage | null>;
  increment(scope: string, sizeBytes: number): Promise<void>;
  decrement(scope: string, sizeBytes: number): Promise<void>;
  recalculate(scope: string, totalSize: number, assetCount: number): Promise<void>;
}
```

The `scope` parameter is the full KV key (e.g., `storage_usage:project:{id}`).

### Increment/Decrement Points

There are three mutation points where counters are updated:

| Event | Operation | Location |
|-------|-----------|----------|
| Asset upload (streaming) | increment project + workspace | `worker/asset/usecase/upload.ts` |
| Presigned upload complete | increment project + workspace | `worker/asset/usecase/complete-upload-session.ts` |
| Asset delete | decrement project + workspace | `worker/asset/usecase/delete.ts` |

Each mutation point:
1. Updates the project counter using `asset.projectId`
2. Looks up the project to find `workspaceId`, then updates the workspace counter

**Skipped for anonymous assets:** Demo-mode assets without `projectId` are excluded from tracking.

### Handling KV Eventual Consistency

Cloudflare KV does not support atomic read-modify-write. The increment/decrement operations perform a read → modify → write cycle, which can lose updates under concurrent writes from different edge locations.

**Mitigation strategy: optimistic updates + periodic reconciliation.**

- **Same-location safety:** KV writes from the same Cloudflare location are serialized, so concurrent requests hitting the same edge do not race.
- **Cross-location drift is rare:** A single user's requests typically route to the same edge.
- **Periodic reconciliation** corrects any accumulated drift (see below).
- **Fail-safe for quotas:** A small over-count is safer than under-count — quota enforcement should use the counter value as-is, accepting that it may be slightly inflated.

### Reconciliation Job (Cron Trigger)

A scheduled job recalculates all counters from the source of truth (asset metadata):

1. Iterate all workspaces
2. For each workspace, iterate its projects via `project_list_ws:{workspaceId}`
3. For each project, read `asset_list:project:{projectId}` and sum `size` from each asset
4. Call `recalculate()` to overwrite the counter with the correct value
5. Sum project totals for the workspace counter

This runs on an existing Cloudflare Cron Trigger (e.g., every 6 hours), added to the `scheduled` handler in `worker/index.ts`.

**This also serves as the migration strategy:** On first deployment, the reconciliation job populates counters for all existing assets with no manual migration.

### Cleanup of Expired Assets

When the cleanup job deletes orphaned R2 objects for expired assets, the asset's KV metadata (including `projectId` and `size`) has already expired. Rather than adding complexity to recover this information, the reconciliation job handles the correction — expired assets are simply absent from the asset list, so the next reconciliation produces the correct total.

### Project/Workspace Deletion

- **Project deletion:** Delete `storage_usage:project:{id}` and decrement the workspace counter by the project's `totalSize`.
- **Workspace deletion:** Delete `storage_usage:workspace:{id}`.

### API Exposure

Embed `storageUsage` in existing GET responses (no new endpoints needed initially):

```json
// GET /api/v1/projects/:id
{
  "id": "...", "name": "...",
  "storageUsage": { "totalSize": 1234567, "assetCount": 5, "updatedAt": 1710000000000 }
}

// GET /api/v1/workspaces/:id
{
  "id": "...", "name": "...",
  "storageUsage": { "totalSize": 9876543, "assetCount": 42, "updatedAt": 1710000000000 }
}
```

If `storageUsage` has not been calculated yet (pre-reconciliation), the field is `null`.

## Alternatives Considered

### Embed counters in project/workspace KV records

Rejected because: Every upload/delete would require read-modify-write on the project or workspace record itself, increasing contention and the blast radius of concurrent-write data loss.

### D1 (SQLite) for counters

Deferred. D1 supports atomic `UPDATE ... SET size = size + ?` which would eliminate the consistency concern. However, D1 adds a new infrastructure dependency. KV counters with reconciliation are sufficient for the current scale. D1 can be adopted later if drift becomes a real problem.

### Real-time recalculation on every GET request

Rejected because: Reading all assets to sum sizes on every API request is too slow (O(n) KV reads). Cached counters with periodic refresh are the right trade-off.

### Durable Objects for atomic counters

Rejected because: Durable Objects provide strong consistency and atomic operations, but add cost and complexity. The eventual-consistency model with reconciliation is acceptable for storage usage display and soft quota enforcement.

## Consequences

- Storage usage is visible per project and per workspace via existing GET endpoints
- Counters may drift slightly between reconciliation runs under concurrent cross-location writes, but this is acceptable for display and soft quotas
- The reconciliation job doubles as a migration mechanism — no manual data backfill needed
- Anonymous/demo-mode assets are excluded from tracking
- Future quota enforcement can read the counter and reject uploads that would exceed the limit
- `extractedSize` tracking can be added later by incrementing counters in the extraction job handler

## Appendix: KV→D1 Migration Candidates

This ADR uses KV with reconciliation for storage usage counters. Investigating the broader codebase, several other KV usage patterns would also benefit from a future D1 migration. This section documents them as a reference for future planning.

### 1. Storage Usage Counters (this ADR)

**Current pain:** KV lacks atomic increment — read-modify-write races can lose updates under concurrent cross-location writes. Requires a separate reconciliation cron job to correct drift.

**D1 benefit:** `UPDATE storage_usage SET total_size = total_size + ? WHERE scope = ?` is atomic. Eliminates the reconciliation job entirely, and enables hard quota enforcement (reject upload if `total_size + new_size > quota` in a single transaction).

**Priority:** Medium — reconciliation is an acceptable workaround for now.

### 2. Index Lists (`addToList` / `removeFromList`)

**Current pain:** Asset, job, project, and member lists are stored as JSON arrays in a single KV key (e.g., `asset_list:project:{id}` → `["a1","a2",...]`). Every add/remove requires reading the full array, modifying it, and writing back. This has two problems:
- **Race conditions:** Two concurrent uploads to the same project can both read `["a1"]`, each append their ID, and one write overwrites the other — losing an entry from the index.
- **Scaling limit:** As arrays grow large (thousands of assets per project), the read-modify-write becomes slow and the JSON payload approaches KV's 25 MiB value limit.

**D1 benefit:** A simple `assets` table with a `project_id` column replaces all index keys. `INSERT` and `DELETE` are atomic. Listing is `SELECT * FROM assets WHERE project_id = ? ORDER BY created_at DESC LIMIT ? OFFSET ?` — no index maintenance code needed. Filtering, sorting, and pagination come free with SQL.

**Affected stores:** `KVMetadataStore`, `KVJobStore`, `KVProjectStore`, `KVMemberStore` — all use `addToList`/`removeFromList`.

**Priority:** High — this is the most fragile part of the current KV design. A concurrent-write bug here can silently drop assets from listings.

### 3. Member & Workspace Inverse Indices

**Current pain:** The member model maintains two manually-synchronized index lists:
- `member_list:{workspaceId}` → `[userId, ...]` (members of a workspace)
- `user_workspaces:{userId}` → `[wsId, ...]` (workspaces a user belongs to)

These are essentially a many-to-many join table implemented as two separate KV arrays. Adding or removing a member requires updating both lists, and a failure between the two writes leaves them inconsistent.

**D1 benefit:** A single `members` table with `(workspace_id, user_id, role)` replaces both index keys. Querying either direction is a simple `WHERE` clause. Referential integrity and atomic insert/delete are built-in.

**Priority:** Medium — current cardinality is low (few members per workspace), so the risk is manageable.

### 4. Job Status Updates

**Current pain:** Jobs are updated frequently (status transitions: `pending` → `running` → `completed`/`failed`, progress percentage updates). Each update overwrites the full JSON blob in KV. KV's eventual consistency means a rapid sequence of status updates (e.g., progress 10% → 20% → 30%) from a container may not be visible to a polling client at a different edge location for several seconds.

**D1 benefit:** Atomic `UPDATE jobs SET status = ?, progress = ? WHERE id = ?`. D1 is strongly consistent (single-writer SQLite), so a status update is immediately visible to subsequent reads. This also enables queries like "list all failed jobs in the last 24 hours" without maintaining additional index keys.

**Priority:** Low — job status polling already tolerates eventual consistency; clients retry.

### 5. Asset Metadata Queries

**Current pain:** There is no way to query assets by metadata fields (e.g., "find all assets larger than 100 MB", "find assets expiring in the next hour", "find assets by content type"). Each query pattern would require a new KV index key. Sorting (by size, date, name) is not possible without reading all entries.

**D1 benefit:** Ad-hoc queries with `WHERE`, `ORDER BY`, and aggregate functions (`SUM`, `COUNT`) become trivial. Useful for admin dashboards, usage analytics, and the reconciliation job itself (which currently must read every asset individually).

**Priority:** Low — not needed for current features, but becomes valuable for admin/analytics use cases.

### Migration Strategy Notes

- All KV stores already use **repository interfaces** (`MetadataStore`, `JobStore`, `ProjectStore`, etc.), so D1 implementations can be swapped in without changing business logic.
- A phased migration is possible — migrate high-priority stores (index lists, counters) first while keeping simple key-value lookups (sessions, upload sessions) on KV where TTL auto-expiration is a natural fit.
- KV remains the better choice for data that benefits from **edge caching** (asset metadata on the hot read path) and **TTL auto-expiration** (sessions, ephemeral assets). D1 is better for data that requires **consistency**, **relational queries**, or **atomic updates**.
