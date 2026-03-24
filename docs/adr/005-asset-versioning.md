# ADR-005: Asset Versioning

- **Status:** Proposed
- **Date:** 2026-03-25
- **Deciders:** @rot1024

## Context

Re:Earth Serve currently treats assets as immutable — once uploaded, an asset's file cannot be replaced. The only way to update content is to delete the old asset and upload a new one, which changes the asset ID and breaks any existing URLs.

Users need the ability to "overwrite" an asset's content while keeping the same asset ID and public URL stable. This is critical for workflows such as:
- Updating a tileset package (new tiles, same URL)
- Replacing a GeoJSON dataset with fresh data
- Correcting an uploaded file without breaking downstream consumers (Re:Earth Visualizer, embedded maps, external links)

The ROADMAP (Phase 8) and the domain model already define the `Asset → Version → File` relationship. This ADR specifies the concrete design for implementing asset versioning.

## Decision

### Core Concept

Introduce a **Version** entity as the unit that owns files. An Asset becomes a container of ordered Versions.

- **Overwrite upload**: uploading to an existing asset creates a new Version under that asset. The asset ID remains stable.
- **File ownership moves to Version**: a Version holds one or more Files (single file or extracted archive contents). The Asset itself no longer directly owns files.
- **Active version**: each Asset may have an explicitly set "active" version. If none is set, the latest version is used.
- **URL routing**: `/files/:id/:filename` resolves `:id` as an asset ID (serving the active/latest version) or as a version ID (serving that specific version).

### Data Model

#### New `asset_versions` Table (D1)

```sql
CREATE TABLE asset_versions (
  id          TEXT PRIMARY KEY,
  asset_id    TEXT NOT NULL,
  version     INTEGER NOT NULL,       -- monotonically increasing per asset (1, 2, 3, ...)
  filename    TEXT NOT NULL,
  content_type TEXT NOT NULL,
  size        INTEGER NOT NULL,
  created_at  INTEGER NOT NULL,
  type        TEXT,                    -- "file" | "archive"
  status      TEXT,                    -- "pending" | "ready" | "extracting" | "failed"
  meta        TEXT,                    -- JSON: system-managed (contentEncoding, originalSize, archiveFormat, fileCount, extractedSize, jobId)
  user_meta   TEXT,                    -- JSON: caller-defined key-value data
  UNIQUE(asset_id, version)
);
CREATE INDEX idx_versions_asset ON asset_versions(asset_id);
```

#### Modified `assets` Table

The `assets` table is simplified — file-level fields move to `asset_versions`:

```sql
-- Fields removed from assets: filename, content_type, size, type, status, meta (file-related fields)
-- Fields added to assets:
ALTER TABLE assets ADD COLUMN active_version_id TEXT;  -- NULL = use latest
```

The `assets` table retains: `id`, `created_at`, `expires_at`, `session_id`, `project_id`, `active_version_id`, `description`, `meta`, `user_meta`.

```sql
ALTER TABLE assets ADD COLUMN description TEXT;  -- human-readable description for UI display
ALTER TABLE assets ADD COLUMN user_meta TEXT;     -- caller-defined key-value data
```

`description` is a free-text field for UI display — distinct from `user_meta` (machine-readable KV) and `meta` (system-internal). It allows users to understand what an asset is for at a glance, even when the asset has no versions yet (e.g., an empty DerivedAsset showing "GeoJSON → FGB conversion output").

#### Migration Strategy

A D1 migration script will:
1. Create the `asset_versions` table.
2. For each existing asset, insert a row into `asset_versions` with `version = 1`, copying `filename`, `content_type`, `size`, `type`, `status`, and file-related `meta` fields from the asset.
3. Add `active_version_id` column to `assets` (default `NULL`).
4. Remove the migrated columns from `assets` (or retain them as deprecated, to be dropped in a subsequent migration).

Since D1 (SQLite) does not support `DROP COLUMN` cleanly, the practical approach is:
- Phase A: Add `asset_versions` table + `active_version_id` to `assets`. Application reads from `asset_versions` but falls back to `assets` columns for unmigrated rows.
- Phase B: Background migration populates `asset_versions` for all existing assets.
- Phase C: Drop old columns via table rebuild in a future migration.

### System Metadata and User-Defined Metadata

Assets and asset versions each carry **two** JSON columns with distinct ownership:

| Column | Owner | API behavior | Purpose |
|--------|-------|-------------|---------|
| `meta` | System (serve) | Read-only for callers | Internal fields: `contentEncoding`, `originalSize`, `archiveFormat`, `fileCount`, `extractedSize`, `jobId`, etc. |
| `user_meta` | Caller | Read-write via PATCH | Arbitrary user-defined key-value data |

This separation ensures that user updates can never accidentally overwrite system-managed fields, and serve can freely evolve `meta` without worrying about user data collisions.

**Rules:**
- `user_meta` is a JSON object. Serve validates it is valid JSON but imposes no schema.
- `user_meta` is fully replaceable on update (PUT semantics — the entire object is replaced, not merged).
- `meta` is managed exclusively by serve. The API exposes it as read-only in responses.

### R2 Key Layout

Current layout stores files under the asset ID:

```
assets/{assetId}/{filename}
assets/{assetId}/files/{path}        -- extracted archive files
```

New layout introduces version scoping:

```
assets/{assetId}/v/{versionId}/{filename}
assets/{assetId}/v/{versionId}/files/{path}   -- extracted archive files
assets/{assetId}/v/{versionId}/_archive/...   -- extraction artifacts
```

The old layout (`assets/{assetId}/{filename}`) remains readable for pre-migration assets. New uploads always use the versioned layout.

### Repository Interface

```typescript
interface AssetVersion {
  id: string;
  assetId: string;
  version: number;
  filename: string;
  contentType: string;
  size: number;
  createdAt: number;
  type?: AssetType;
  status?: AssetStatus;
  archiveFormat?: ArchiveFormat;
  fileCount?: number;
  extractedSize?: number;
  jobId?: string;
  contentEncoding?: string;
  originalSize?: number;
  userMeta?: Record<string, unknown>;
}

interface VersionStore {
  save(version: AssetVersion): Promise<void>;
  find(id: string): Promise<AssetVersion | null>;
  findByAssetId(assetId: string, options?: { limit?: number; cursor?: string }): Promise<ListResult<AssetVersion>>;
  findLatest(assetId: string): Promise<AssetVersion | null>;
  update(id: string, patch: Partial<Pick<AssetVersion, 'userMeta'>>): Promise<void>;
  delete(id: string): Promise<void>;
  deleteByAssetId(assetId: string): Promise<void>;
}
```

The existing `MetadataStore` is renamed to `AssetStore` to better reflect its domain responsibility. Instead of adding per-field methods (e.g., `setActiveVersion`), a general `update` method accepts a partial patch of mutable fields:

```typescript
interface AssetStore {
  save(asset: Asset, ttlSeconds: number): Promise<void>;
  find(id: string): Promise<Asset | null>;
  update(id: string, patch: Partial<Pick<Asset, 'activeVersionId' | 'expiresAt' | 'description' | 'userMeta'>>): Promise<void>;
  delete(id: string): Promise<void>;
  list(options?: { limit?: number; cursor?: string; sessionId?: string; projectId?: string; type?: AssetType }): Promise<ListResult<Asset>>;
}
```

`update` uses `Partial<Pick<Asset, ...>>` to restrict updates to explicitly mutable fields, preventing accidental modification of immutable fields like `id` or `createdAt`.

### Version Resolution

When serving files at `/files/:id/:filename`:

1. Look up `:id` as an **asset ID** first.
   - If found, resolve the active version: `asset.activeVersionId ?? latestVersion(assetId)`.
   - Use that version's R2 prefix to locate the file.
2. If not found as an asset ID, look up `:id` as a **version ID**.
   - If found, use that version's R2 prefix directly.
3. **Legacy fallback**: if no version rows exist for the asset (pre-migration), fall back to the old R2 key layout (`assets/{assetId}/{filename}`).

### API Changes

#### Upload (Overwrite)

```
POST /api/v1/assets/:id
```

Uploads a new version to an existing asset via streaming. Same headers as the current upload endpoint (`X-Filename`, `Content-Length`, etc.). Returns the new version metadata.

The existing `POST /api/v1/assets` (create new asset) still works and creates the first version automatically.

#### Presigned Upload (Overwrite)

```
POST /api/v1/assets/:id/uploads
```

Creates a presigned upload session for a new version of an existing asset. Same request body as `POST /api/v1/assets/uploads`, but scoped to an existing asset. The completion endpoint remains the same:

```
POST /api/v1/assets/uploads/:uploadId/complete
```

The `UploadSession` model gains an optional `assetId` field. When `assetId` is present, completing the upload creates a new version under that asset instead of creating a new asset. This keeps the completion flow unified — the only difference is whether the session was created for a new asset or an existing one.

Both streaming upload (`POST /api/v1/assets/:id`) and presigned upload (`POST /api/v1/assets/:id/uploads`) support overwrite. Large file overwrites benefit from presigned multipart upload the same way new uploads do.

#### Asset Update

```
PATCH /api/v1/assets/:id
{
  "description": "PLATEAU 2026 building dataset",
  "userMeta": { "department": "urban-planning" }
}
```

Updates mutable asset fields. Supported fields: `description`, `userMeta`, `activeVersionId`, `expiresAt`. Returns the updated asset.

#### Version Management

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/api/v1/assets/:id/versions` | List versions of an asset (newest first) |
| `GET` | `/api/v1/assets/:id/versions/:versionId` | Get version metadata |
| `PATCH` | `/api/v1/assets/:id/versions/:versionId` | Update version fields (`userMeta`) |
| `DELETE` | `/api/v1/assets/:id/versions/:versionId` | Delete a specific version |
| `PUT` | `/api/v1/assets/:id/active-version` | Set the active version (`{ "versionId": "..." }` or `null` for latest) |

Updating version user_meta:

```
PATCH /api/v1/assets/:id/versions/:versionId
{ "userMeta": { "note": "fixed projection", "source": "PLATEAU 2026" } }
```

#### Asset Metadata Response

The asset metadata response is extended:

```json
{
  "id": "asset-abc",
  "createdAt": 1710000000000,
  "expiresAt": 0,
  "projectId": "proj-1",
  "activeVersionId": null,
  "description": "PLATEAU 2026 building dataset",
  "userMeta": { "department": "urban-planning" },
  "currentVersion": {
    "id": "ver-xyz",
    "version": 3,
    "filename": "data.geojson",
    "contentType": "application/geo+json",
    "size": 45678,
    "createdAt": 1710100000000,
    "type": "file",
    "status": "ready",
    "userMeta": { "note": "fixed projection" }
  },
  "versionCount": 3
}
```

`currentVersion` is the resolved version (active if set, otherwise latest). `versionCount` indicates how many versions exist.

### Asset Deletion

Asset deletion is a two-phase process:

1. **Synchronous (on DELETE request)**:
   - Delete the `assets` row and all associated `asset_versions` rows from D1.
   - Decrement storage usage counters by the sum of all versions' `size`.
   - Return success to the client immediately.

2. **Asynchronous (cleanup job)**:
   - R2 objects under `assets/{assetId}/` are **not** deleted synchronously — deleting many files (multiple versions × extracted archives) could be slow and risk timeout.
   - The existing scheduled cleanup job detects orphaned R2 prefixes (objects whose asset ID no longer exists in D1) and deletes them in the background.

Individual version deletion (`DELETE /api/v1/assets/:id/versions/:versionId`) follows the same pattern: the `asset_versions` row is deleted synchronously, R2 objects for that version are cleaned up asynchronously. If the deleted version was the active version, `activeVersionId` is reset to `NULL` (falls back to latest).

### Storage Usage Tracking

Storage usage (ADR-004) counts bytes stored in R2. With versioning:

- **On version upload**: increment project/workspace counters by the new version's `size`.
- **On version delete**: decrement by the deleted version's `size`.
- **On asset delete**: decrement by the sum of all versions' `size`.

Each version's storage is counted independently — keeping old versions consumes additional storage.

### Archive Extraction

Archive extraction works at the version level:

- When an archive is uploaded as a new version, extraction runs against that version.
- The extraction job references the version ID, not the asset ID.
- Extracted files are stored under the version's R2 prefix.
- The `jobs` table already has an `asset_id` column; a `version_id` column is added.

### Access Control

No changes to the access control model. Version operations inherit the asset's access control:

- If a user can write to an asset, they can create new versions.
- If a user can read an asset, they can list and read all versions.
- If a user can delete an asset, they can delete individual versions.

### ID Format

Version IDs use the same format as asset IDs (ULID or similar). The `version` field (integer) provides a human-readable sequence number, while `id` is the globally unique identifier.

## Alternatives Considered

### Versions as Separate Assets with a "Parent" Reference

Each version would be a full asset with a `parentAssetId` field. The file URL would use the parent's ID.

Rejected because:
- Pollutes the asset list — users see every version as a separate asset.
- Requires complex query logic to filter "root" vs "version" assets.
- URL routing for "latest" requires scanning all child assets by `createdAt`.

### In-Place Overwrite (No Version History)

Simply replace the file in R2 and update metadata. No version tracking.

Rejected because:
- Loses the ability to rollback to a previous version.
- R2 overwrites are not atomic — a failed overwrite could leave the asset in a broken state.
- No audit trail of what changed and when.

### External Versioning (Git-like Object Store)

Content-addressable storage where each file is stored by hash, and versions are pointers.

Rejected because:
- Over-engineered for the current use case — we need simple "replace file, keep URL stable" semantics.
- Adds deduplication complexity with minimal benefit (assets are typically unique binary files).

### Version Tags Instead of Active Version

Allow naming versions with tags (e.g., `latest`, `stable`, `v2`).

Deferred. The current design uses a single `activeVersionId` which covers the primary use case. Tags can be added later if needed (e.g., for staging/production workflows).

### CLI

#### Asset Management

```bash
# Upload a new version to an existing asset
<cli> asset upload asset-1 ./updated-data.geojson

# Update asset description and user_meta
<cli> asset update asset-1 \
  --description "PLATEAU 2026 building dataset" \
  --user-meta '{"department":"urban-planning"}'
```

#### Version Management

```bash
# List versions
<cli> asset versions asset-1

# Show specific version details
<cli> asset version show asset-1 ver-xyz

# Set active version
<cli> asset set-version asset-1 --version ver-abc

# Reset to latest
<cli> asset set-version asset-1 --latest

# Delete a specific version
<cli> asset version delete asset-1 ver-xyz

# Update version user_meta
<cli> asset version update asset-1 ver-xyz \
  --user-meta '{"note":"fixed projection"}'
```

## Consequences

- Asset URLs remain stable across version updates — downstream consumers are not affected.
- Users can overwrite assets without losing previous versions, enabling rollback.
- Storage usage increases with each version kept — a future retention policy or version limit may be needed.
- The file serving path adds one extra D1 query (version resolution) — mitigated by caching the resolved version.
- Pre-migration assets continue to work via the legacy fallback path.
- Archive extraction becomes version-scoped, so old extracted files remain accessible if the old version is still present.
- The `jobs` table gains a `version_id` column to link extraction jobs to specific versions.
