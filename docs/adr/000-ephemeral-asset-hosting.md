# ADR-000: Ephemeral Asset Hosting

- **Status:** Accepted
- **Date:** 2026-03-11
- **Deciders:** @rot1024

## Context

Re:Earth Serve is a spatial data delivery layer for the Re:Earth ecosystem. The first milestone is a minimal viable file hosting service — no UI, no auth, no tile processing — that validates the Cloudflare-native architecture and provides immediate utility for sharing spatial data files.

Key requirements:
- Upload arbitrary files and receive a public URL
- Serve files with correct `Content-Type`, `Content-Encoding`, and HTTP Range support
- Auto-expire assets after 1 hour (ephemeral / demo mode)
- Support large files (multi-GB) without Worker CPU/memory limits blocking upload
- Compress compressible files (JSON, GeoJSON, CSV) to reduce storage and transfer costs

## Decision

### Cloudflare Workers + R2 + KV

| Component | Role |
|---|---|
| Cloudflare Workers | HTTP API runtime (Hono framework) |
| Cloudflare R2 | Object storage (zero egress cost) |
| Cloudflare KV | Asset metadata with TTL-based auto-expiration |

R2's zero egress pricing is critical for tile delivery workloads where bandwidth costs dominate. KV provides built-in TTL expiration, eliminating the need for a separate cleanup mechanism for ephemeral assets.

### Streaming upload (direct)

`POST /api/v1/assets` accepts a raw body stream. The Worker pipes the request body directly to R2 via `put()` — no buffering the entire file in memory. This keeps Worker memory usage constant regardless of file size.

```
Client → Worker (stream) → R2.put()
```

Headers `X-Filename` and `Content-Type` provide metadata. The response includes an asset ID and public file URL.

### Presigned URL upload (S3 multipart)

For large files or when clients need direct-to-storage upload:

1. `POST /api/v1/assets/uploads` — Worker creates an S3 multipart upload via R2's S3-compatible API, returns presigned URLs for each part
2. Client uploads parts directly to R2 (bypassing the Worker)
3. `POST /api/v1/assets/uploads/:id/complete` — Worker completes the multipart upload and creates the asset metadata

This avoids Worker CPU time limits for large uploads. The S3-compatible API requires `aws4fetch` for request signing.

### Gzip compression strategy

Compression is the **uploader's responsibility**, not the server's:

- The CLI detects compressible content types (JSON, GeoJSON, CSV, XML, 3D Tiles, glTF, MVT, etc.) and files above a size threshold (1 KB), compresses with gzip locally, and uploads with `Content-Encoding: gzip` and `X-Original-Size` headers
- The server stores the compressed bytes as-is in R2
- On download, if the client sends `Accept-Encoding: gzip`, the server passes through the compressed bytes with `Content-Encoding: gzip`
- If the client does not accept gzip, the server decompresses on-the-fly via `DecompressionStream`

This approach was chosen over server-side compression because:
- Worker CPU time is limited and expensive for compression
- The CLI has no CPU constraints
- Presigned uploads bypass the Worker entirely, so server-side compression is impossible for that path

The compressible-extension list is provided by [`@reearth/compressible`](https://github.com/reearth/compressible), a small library curated from `jshttp/mime-db` with geospatial/3D extras (3D Tiles `.b3dm`/`.i3dm`/`.pnts`/`.cmpt`/`.subtree`, Cesium `.terrain`, `.mvt`, `.ndjson`/`.jsonl`, `.wkt`, etc.) and exclusions for already-compressed or archive formats (`.tar`, `.svgz`, `.psd`, VM disk images, etc.). The TypeScript side uses `isCompressiblePath()` from the `@reearth/compressible` npm package; the archive-extractor container uses `compressible.Path()` from `github.com/reearth/compressible/go`. To change which extensions are gzipped, contribute to the upstream library rather than diverging here.

### Immutable assets

Assets are write-once. Once uploaded, the content cannot be overwritten — only deleted. This simplifies caching (no invalidation needed), enables aggressive `Cache-Control` headers, and aligns with the future versioning model (Phase 8).

### File serving with Range support

`GET /files/:id/:filename` serves files with:
- Correct `Content-Type` from asset metadata
- `Content-Encoding: gzip` passthrough when client supports it
- HTTP Range requests (206 Partial Content) for seeking in large files
- `Cache-Control: public, max-age=3600, immutable`
- CORS `Access-Control-Allow-Origin: *`

For gzip-stored files with Range requests from non-gzip clients, the server decompresses the full stream and slices to the requested byte range. This is acceptable because Range requests on compressed files are rare in practice.

### KV metadata model

```
Key:   asset:{id}
Value: {
  id, filename, contentType, size, createdAt, expiresAt,
  contentEncoding?, originalSize?
}
TTL:   3600s (auto-expire)
```

KV's built-in TTL handles ephemeral asset cleanup. A scheduled worker (`Cron Trigger`) cleans up orphaned R2 objects whose KV entries have already expired.

### Cron cleanup for expired R2 objects

KV's built-in TTL handles metadata expiration, but R2 objects persist after their KV entries expire. A Cron Trigger (`*/10 * * * *`) runs a scheduled worker that:

1. Scans `R2Bucket.list({ prefix: "assets/" })` to enumerate asset ID prefixes
2. For each asset ID, checks `KV.get("asset:{id}")` — if null (TTL expired), the asset is orphaned
3. Deletes all R2 keys under `assets/{id}/` (main file, archive artifacts, extracted files)
4. Deletes the corresponding `job:{id}` from KV
5. Limits to 100 assets per invocation with cursor-based pagination to stay within Worker CPU limits (30 seconds)

R2 and KV both return max 1000 keys per page. The cleanup worker processes incrementally across cron invocations rather than attempting to clean everything in one pass.

This approach (R2 scan → KV existence check) was chosen over maintaining a separate expiry index because:
- It requires no additional state — the KV TTL is the source of truth
- R2 `list()` is efficient with prefix filtering
- Incremental processing fits naturally within Worker CPU limits

### CLI

The CLI (`npx tsx cli/index.ts`) provides:
- `<file>` — upload a file, print the public URL
- `--direct` — force direct upload (skip presigned)
- `--json` — structured JSON output for scripting and AI agents
- `--endpoint` — custom server endpoint

The CLI auto-detects compressible files and applies gzip compression before upload.

## API

### Public API (`/api/v1`)

| Method | Path | Description |
|---|---|---|
| `GET` | `/api/v1/health` | Health check |
| `POST` | `/api/v1/assets` | Upload a file (raw body streaming) |
| `GET` | `/api/v1/assets/:id` | Get asset metadata |
| `DELETE` | `/api/v1/assets/:id` | Delete an asset |
| `POST` | `/api/v1/assets/uploads` | Create presigned upload session |
| `POST` | `/api/v1/assets/uploads/:id/complete` | Complete presigned upload |

### File Delivery

| Method | Path | Description |
|---|---|---|
| `GET` | `/files/:id/:filename` | Download file |

## Alternatives considered

### Server-side compression

Rejected because: Worker CPU time is limited (10ms on free plan, 30s on paid), compression of large files would hit limits. Presigned uploads bypass the Worker entirely, making server-side compression impossible for that path.

### D1 (SQLite) for metadata

Rejected because: KV's built-in TTL is a perfect fit for ephemeral assets. D1 would require manual expiration logic and adds complexity for simple key-value metadata.

### Durable Objects for upload sessions

Considered for presigned upload state tracking. Deferred — KV is sufficient for the current session model. May revisit if upload sessions need stronger consistency guarantees.

### R2 lifecycle rules for cleanup

R2 doesn't support object-level TTL or lifecycle policies (unlike S3). A Cron Trigger worker is needed to scan and delete expired objects.

## Consequences

- Files up to several GB can be uploaded via presigned multipart upload
- Compressible files are stored 60–90% smaller, reducing R2 storage costs
- Ephemeral assets auto-expire via KV TTL — no manual cleanup needed for metadata
- R2 object cleanup is handled by a Cron Trigger scheduled worker (every 10 minutes)
- The CLI provides immediate utility for sharing spatial data without a UI
- The architecture validates Cloudflare Workers + R2 + KV as viable for the full roadmap
