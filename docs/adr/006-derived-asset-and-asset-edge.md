# ADR-006: Derived Asset and Asset Edge

- **Status:** Proposed
- **Date:** 2026-03-25
- **Deciders:** @rot1024

## Context

Re:Earth Serve was initially designed as "S3 with zip extraction and access control." However, as GIS data delivery requirements deepen, the need to manage transformation, composition, and dependency relationships between assets has become clear.

Specific challenges:

- **Format conversion**: Converting arbitrary formats (GeoJSON, CityGML, Shapefile, etc.) to optimized delivery formats (FGB, COG) — where do the results live?
- **Dependency tracking**: Tilesets composed from multiple assets need dependency tracking so changes propagate correctly.
- **Automatic invalidation**: When a source asset is updated, derived outputs must be invalidated and regenerated.
- **Auditability**: Government and municipal users (PLATEAU) require traceability — which version of the source data produced which output.

Re:Earth Serve manages the asset lifecycle and dependency graph. Actual transformation processing is handled by external engines (e.g., reearth-untiled for tile generation, GDAL containers for format conversion). This separation of concerns allows both systems to evolve independently.

## Decision

### 1. Asset Subtypes

The `Asset` base model (ADR-005) is extended with a `type` field that distinguishes four subtypes. All subtypes share the same versioning infrastructure — only the trigger for version creation differs.

```
Asset (base — ADR-005)
  id
  type: uploaded | derived | composite | external
  activeVersionId
  versions[]  (via asset_versions table)
```

#### UploadedAsset

User-uploaded assets. Version creation is triggered by explicit user upload (ADR-005). This is the existing asset type.

#### DerivedAsset

Generated from a **single** parent asset via transformation (e.g., GeoJSON → FGB, GeoTIFF → COG). Version creation is triggered by dirty propagation from the parent.

```
DerivedAsset additional fields (stored in asset meta):
  sourceAssetId: string
  sourceVersionId: string    -- which parent version produced this output
  transformType: "fgb" | "cog" | "overview" | ...
```

`sourceVersionId` is recorded when the derived version is generated, creating a permanent link from the output back to the exact source snapshot. This enables full auditability: "this FGB was generated from version 3 of asset X."

#### CompositeAsset

Generated from **multiple** parent assets via composition (e.g., merged tilesets, attribute-joined datasets). Version creation is triggered when any parent becomes dirty.

```
CompositeAsset additional fields (stored in asset meta):
  sources: Array<{
    assetId: string
    versionId: string       -- which version of this parent was used
  }>
```

`sources[].versionId` is recorded at generation time — each composite version captures the exact snapshot of every parent that was used. This is critical for reproducibility: re-generating from the same set of parent versions must produce the same output.

**Relationship between asset-level meta and version-level meta:**

- **Asset meta** stores the _current_ dependency declaration: `sourceAssetId` / `sources[].assetId` — "this asset depends on these parents."
- **Version meta** stores the _resolved_ snapshot: `sourceVersionId` / `sources[].versionId` — "this specific version was built from these specific parent versions."

This separation means that when a parent updates, the asset-level dependency is unchanged, but the next generated version records the new parent version it was built from.

#### ExternalAsset

A cache of an external source. Version creation is triggered by TTL expiration or manual invalidation. Carries redistribution constraints for license compliance.

```
ExternalAsset additional fields (stored in asset meta):
  sourceUrl: string
  ttl: number
  cachedAt: number
  redistributable: boolean
```

### 2. Asset Edge — Dependency DAG

`AssetEdge` represents directed dependencies between assets as a DAG (Directed Acyclic Graph).

#### D1 Schema

```sql
CREATE TABLE asset_edges (
  from_asset_id   TEXT NOT NULL,   -- parent (depended upon)
  to_asset_id     TEXT NOT NULL,   -- child (depends on parent)
  from_version_id TEXT,            -- pinned parent version (NULL = track latest)
  meta            TEXT,            -- JSON: system-managed metadata (read-only for callers)
  user_meta       TEXT,            -- JSON: caller-defined key-value metadata
  PRIMARY KEY (from_asset_id, to_asset_id)
);
CREATE INDEX idx_edges_to ON asset_edges(to_asset_id);
```

Re:Earth Serve manages the DAG structure and state only — it does **not** execute transformations.

### 3. Status State Machine

Asset versions gain an additional status `dirty` to signal that re-generation is needed:

```
dirty
  ↓  (transformation engine picks up job)
pending
  ↓  (success)              ↓  (failure)
ready                     failed
                            ↓  (retry)
                          dirty
```

Invalid transitions are rejected at the API level.

**Dirty propagation rules:**

- When a parent asset becomes dirty (or a new version is uploaded to an UploadedAsset), traverse the DAG downward and mark all descendants as `dirty`.
- A CompositeAsset can transition from `dirty` to `pending` only when **all** of its parents are `ready`.
- Propagation is breadth-first to avoid redundant traversals.

### 4. User-Defined Metadata

Assets and asset versions carry `meta` (system-managed, read-only) and `user_meta` (caller-defined, read-write) columns as defined in ADR-005. Asset edges follow the same pattern — the `user_meta` column on `asset_edges` allows callers to attach arbitrary semantics to each dependency:

```json
// Edge user_meta — caller defines the meaning
{ "role": "geometry", "priority": 1 }
```

See ADR-005 for the full `meta` / `user_meta` design, rules, and API behavior.

### 5. Archive Handling

Archives (zip, tar, tar.gz) remain an **intra-asset** concept as defined in ADR-005 and ADR-001. Uploading an archive does **not** create multiple assets — the extracted files are stored as files within the same asset version.

This means:
- `POST /api/v1/assets` with a zip file creates **one** UploadedAsset with one version. Extraction produces files within that version.
- Archive extraction is orthogonal to the Derived/Composite model. A DerivedAsset can be derived from an archive-type UploadedAsset — it references the parent asset, not individual extracted files.
- Bulk management (delete, re-upload) operates on the single asset, not on individual extracted files.

### 6. API

#### Asset CRUD (extended from ADR-005)

Existing asset endpoints are extended with `type` and `user_meta` support:

| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/api/v1/assets` | Create asset (UploadedAsset with file upload, or empty DerivedAsset/CompositeAsset/ExternalAsset via JSON body) |
| `GET` | `/api/v1/assets/:id` | Get asset metadata (includes `type`, `currentVersion`, `user_meta`) |
| `PATCH` | `/api/v1/assets/:id` | Update asset fields (`user_meta`, `activeVersionId`, `expiresAt`) |
| `DELETE` | `/api/v1/assets/:id` | Delete asset and all versions |
| `GET` | `/api/v1/assets` | List assets (filterable by `?type=`, `?projectId=`) |

Filtering by type: `GET /api/v1/assets?type=derived&projectId=proj-1` returns only DerivedAssets in the specified project.

Creating a non-uploaded asset:

```
POST /api/v1/assets
Content-Type: application/json

{
  "type": "derived",
  "projectId": "proj-1",
  "description": "GeoJSON → FGB conversion output",
  "userMeta": { "transformType": "fgb", "projection": "EPSG:4326" }
}
→ 201 { "id": "asset-derived-1", "type": "derived", "description": "GeoJSON → FGB conversion output", "status": "dirty", ... }
```

#### Version CRUD

See ADR-005 for the full version management API (upload, list, get, update, delete, set active version, presigned upload).

For DerivedAsset/CompositeAsset, the transformation engine uploads the result as a new version. The source provenance (which parent versions were used) is recorded in the version's `user_meta`:

```
POST /api/v1/assets/:id
X-Filename: output.fgb

<binary body>
→ 201 { "id": "ver-xyz", "version": 2, ... }

PATCH /api/v1/assets/:id/versions/ver-xyz
{ "userMeta": { "sourceVersions": { "parent-1": "ver-abc", "parent-2": "ver-def" } } }
```

#### Edge Management

| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/api/v1/assets/:id/edges` | Add edges (dependencies) to this asset |
| `GET` | `/api/v1/assets/:id/edges` | List edges where this asset is the child (its parents) |
| `DELETE` | `/api/v1/assets/:id/edges/:fromAssetId` | Remove a specific edge |
| `PUT` | `/api/v1/assets/:id/edges` | Replace all edges for this asset |

Adding edges:

```
POST /api/v1/assets/derived-1/edges
{
  "edges": [
    { "fromAssetId": "parent-1", "userMeta": { "role": "geometry" } },
    { "fromAssetId": "parent-2", "userMeta": { "role": "attribute" } }
  ]
}
→ 201 { "edges": [...], "asset": { "id": "derived-1", "status": "dirty", ... } }
```

Adding edges automatically marks the child asset as `dirty` if any parent has a newer version than what was last used.

#### DAG Traversal

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/api/v1/assets/:id/dependents` | List all downstream descendants (breadth-first) |
| `GET` | `/api/v1/assets/:id/dependencies` | List all upstream ancestors |

```
GET /api/v1/assets/parent-1/dependents
→ 200 {
  "dependents": [
    { "id": "derived-1", "type": "derived", "depth": 1, "status": "ready" },
    { "id": "composite-1", "type": "composite", "depth": 2, "status": "dirty" }
  ]
}
```

#### Status Transitions and Dirty Propagation

| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/api/v1/assets/:id/dirty` | Mark asset as dirty and propagate to descendants |
| `PATCH` | `/api/v1/assets/:id/versions/:vid/status` | Transition version status (optimistic locking) |

**Dirty marking:**

```
POST /api/v1/assets/parent-1/dirty
→ 200 {
  "asset": { "id": "parent-1", "status": "dirty" },
  "propagated": [
    { "id": "derived-1", "status": "dirty" },
    { "id": "composite-1", "status": "dirty" }
  ]
}
```

This traverses the DAG downward and marks all descendants as `dirty`. The response includes the full list of affected assets so the caller knows the blast radius. When an UploadedAsset receives a new version, dirty propagation is triggered automatically.

**Status transition (optimistic locking):**

```
PATCH /api/v1/assets/derived-1/versions/ver-xyz/status
{
  "expectedStatus": "dirty",
  "newStatus": "pending"
}
→ 200 { "id": "ver-xyz", "status": "pending" }
→ 409 if current status ≠ expectedStatus
```

Valid transitions: `dirty → pending → ready`, `dirty → pending → failed`, `failed → dirty` (retry).

For CompositeAssets, `dirty → pending` is rejected with `422` if any parent is not `ready`.

#### Webhook / Event Emission

Serve emits events on status changes. External engines subscribe to react:

| Event | Trigger | Payload |
|-------|---------|---------|
| `asset.dirty` | `POST /dirty` or new version on parent | `{ assetId, propagated: [...] }` |
| `asset.version.ready` | Status → `ready` | `{ assetId, versionId }` |
| `asset.version.failed` | Status → `failed` | `{ assetId, versionId, error }` |

Webhook endpoints are configured per project. Event delivery uses at-least-once semantics with retry.

### 7. CLI

#### Asset Management (extended)

```bash
# Create a derived asset with description
<cli> asset create --type derived --project my-project \
  --description "GeoJSON → FGB conversion output" \
  --user-meta '{"transformType":"fgb"}'

# Create with edges in one command
<cli> asset create --type derived --project my-project \
  --description "Merged tileset from building + road data" \
  --from parent-1 --from parent-2 \
  --user-meta '{"transformType":"fgb"}'

# Create an external asset
<cli> asset create --type external --project my-project \
  --user-meta '{"sourceUrl":"https://example.com/tiles","ttl":86400}'

# Update user_meta
<cli> asset update asset-1 --user-meta '{"projection":"EPSG:4326"}'
```

#### Version Management

See ADR-005 for version CLI commands (list, upload, set-version, delete, update user_meta).

#### Edge Management

```bash
# Add edges
<cli> asset link derived-1 --from parent-1 --from parent-2

# List edges (parents of this asset)
<cli> asset edges derived-1

# Remove an edge
<cli> asset unlink derived-1 --from parent-2

# Replace all edges
<cli> asset link derived-1 --from parent-3 --replace
```

#### DAG Operations

```bash
# Show what would be invalidated
<cli> asset dependents parent-1

# Show what this asset depends on
<cli> asset dependencies derived-1

# Mark dirty and propagate
<cli> asset dirty parent-1

# Transition status (for transformation engines)
<cli> asset status derived-1 ver-xyz --from dirty --to pending
<cli> asset status derived-1 ver-xyz --from pending --to ready
```

### 8. Responsibility Boundary: serve vs. untiled

| Concern | Re:Earth Serve | reearth-untiled |
|---------|---------------|-----------------|
| Asset version history | Owns | Reads |
| Dependency graph (AssetEdge) | Owns | Reads |
| Status state machine | Owns | Transitions via API |
| Derived/Composite file storage | Stores results | Writes via API |
| Transformation execution | Does not execute | Owns (GDAL, tippecanoe, etc.) |
| Tile response cache | Unaware | Owns (writes to KV/CDN directly) |
| Dirty event emission | Emits webhook/event | Subscribes and reacts |

Tile caches are written directly to KV/CDN by untiled, bypassing serve. Serve does not know about the cache's existence.

## Alternatives Considered

### Embed Transformation Logic in Serve

Run GDAL/tippecanoe inside Cloudflare Containers as part of serve.

Rejected because:
- Tight coupling makes it impossible to evolve transformation and delivery independently.
- Container resource requirements vary wildly by transformation type — mixing them with the serving layer complicates scaling.
- reearth-untiled already exists as a separate system with established transformation capabilities.

### Flat Asset List with External Dependency Tracking

Keep serve as a pure file store; track dependencies in untiled or a separate service.

Rejected because:
- Dirty propagation requires knowledge of asset state, which lives in serve.
- Auditability (which source version produced which output) is a core serve concern — spreading it across services makes tracing harder.
- Access control on derived assets should be co-located with the source asset's access control.

### Separate Tables per Asset Subtype

Create distinct tables for each subtype (`uploaded_assets`, `derived_assets`, `composite_assets`, `external_assets`) instead of a single `assets` table with a `type` discriminator.

Rejected because:
- Asset IDs must be globally unique across all subtypes for AssetEdge to work. With separate tables, `from_asset_id` / `to_asset_id` in `asset_edges` would need to specify which table to join against, turning every edge traversal into a multi-table lookup or UNION query.
- File serving (`/files/:id/:filename`) resolves an asset ID to a version — splitting tables means the resolution path must check multiple tables to find the asset.
- Access control, versioning, and storage usage tracking all operate on "any asset regardless of subtype." A single table with a `type` column keeps these queries simple and avoids N-way joins.
- Subtype-specific fields (sourceAssetId, transformType, sourceUrl, etc.) are stored in the `meta` JSON column, which avoids schema changes when adding new subtypes or subtype-specific fields.

### Event Sourcing for Status Transitions

Store every status change as an append-only event log rather than mutable state.

Deferred. Event sourcing provides excellent auditability but adds complexity. The current status field with optimistic locking is sufficient. An event log can be layered on top later if audit requirements demand it.

## Consequences

- **Traceability**: Full record of which source version produced which derived output — critical for government/municipal accountability.
- **Automatic invalidation**: Source updates cascade through the DAG, ensuring derived assets are never stale without explicit action.
- **Fallback**: When a transformation fails, the source asset remains servable — no disruption to end users.
- **Separation of concerns**: Transformation engines (untiled) and lifecycle management (serve) evolve independently.
- **DAG complexity**: Deep graphs may slow dirty propagation. Mitigation: breadth-first traversal with batch D1 updates. Monitor DAG depth in production and set a practical limit if needed.

## Open Questions

- Concrete implementation of ExternalAsset license/terms-of-use management (low priority).
- Performance characteristics of dirty propagation on deep DAGs — may need async queue-based propagation for large graphs.
- Cyclic dependency detection — enforce at edge creation time via DFS check on the DAG.
