# ADR-001: Archive Extraction Architecture

- **Status:** Accepted
- **Date:** 2026-03-12
- **Deciders:** @rot1024

## Context

Re:Earth Serve needs to support uploading archive files (ZIP, tar, tar.gz) containing spatial data (3D Tiles, vector tiles, GeoJSON collections, etc.) and serving individual extracted files via HTTP. Archives can be multi-GB with hundreds of thousands of files.

Key constraints:
- Cloudflare Workers have limited CPU time and no filesystem
- Extraction must handle container timeouts gracefully
- Disk consumption during extraction must be bounded
- Archives created on Windows may contain backslash path separators

Reference: https://reearth.engineering/posts/unzip-100gb-go-gcs/

## Decision

### Container implementation in Go

We chose Go for the extraction container over Node.js for the following reasons:

| Factor | Go |
|---|---|
| Proven reference | The reference blog post uses Go for 100GB zip → GCS extraction |
| Standard library | `archive/zip` (Central Directory aware), `archive/tar`, `compress/gzip` |
| Docker image size | Static binary → `FROM scratch`, a few MB |
| Concurrency model | goroutine + semaphore fits parallel extract-and-upload naturally |

Go's `archive/zip.NewReader` requires `io.ReaderAt`. Since R2 has no random access, we implement a ~30-line adapter that issues HTTP Range requests via the S3-compatible API:

```go
func (r *R2ReaderAt) ReadAt(p []byte, off int64) (int, error) {
    rangeHeader := fmt.Sprintf("bytes=%d-%d", off, off+int64(len(p))-1)
    out, _ := r.client.GetObject(ctx, &s3.GetObjectInput{
        Bucket: &r.bucket, Key: &r.key, Range: &rangeHeader,
    })
    return io.ReadFull(out.Body, p)
}
```

This allows `archive/zip` to read the Central Directory (a few Range GETs) without downloading the entire file.

### 3-phase extraction with checkpoint-based resume

Extraction runs in three phases, with checkpoints persisted to R2 (not KV) so the container is self-contained with only S3 API access:

```
Phase A: entries_listing → entries_listed
  List all entries from the archive, save to R2 as _entry_list.jsonl

Phase B: extracting
  Extract entries in parallel (goroutine + semaphore), upload each to R2
  Checkpoint every N entries (default: 100)

Phase C: completing → completed
  Merge manifest chunks into final _manifest.jsonl
  Update job status via Worker API
```

On timeout/crash, the container restarts and resumes from the last checkpoint. R2 PUT is idempotent, so re-processing up to 100 entries is safe.

### ObjectStorage interface for testability

All storage access goes through an `ObjectStorage` interface:

```go
type ObjectStorage interface {
    GetObject(ctx context.Context, key string) (io.ReadCloser, error)
    GetObjectRange(ctx context.Context, key string, offset, length int64) (io.ReadCloser, error)
    HeadObject(ctx context.Context, key string) (int64, error)
    PutObject(ctx context.Context, key string, body io.Reader, contentType string, opts *PutOptions) error
    DeleteObject(ctx context.Context, key string) error
}
```

`R2Client` implements this for production; `MemoryStorage` implements it for tests. Integration tests generate ZIP/tar archives in-memory with Go's `archive/zip.Writer`, store them in `MemoryStorage`, run the full extraction pipeline, and verify results.

### Container → Worker communication

The container cannot access Worker bindings (`env.STORAGE`, `env.KV`), so:

| Concern | Approach |
|---|---|
| R2 file I/O | S3-compatible API directly (`aws-sdk-go-v2`) |
| Checkpoint persistence | JSON file in R2 (no KV dependency) |
| Job status updates | HTTP POST to Worker API (`/jobs/:id/status`) |

### Path normalization

- Backslash separators are converted to forward slashes
- Root folder auto-stripping: if all entries share a single root folder matching the archive name (with or without extension), that prefix is removed

```
data.zip containing data/tileset.json → tileset.json
data.zip containing data/tiles/0/0/0.pbf → tiles/0/0/0.pbf
```

Detection runs at the end of Phase A. The logic checks that all entries share the same first path segment and that it matches the archive filename.

### Disk consumption control

A semaphore limits concurrent uploads (default: 48). Files are streamed from the archive directly to R2 — no intermediate disk writes. For ZIP, `archive/zip` reads via Range requests; for tar/tar.gz, the stream is read sequentially.

## R2 storage layout

```
assets/{assetId}/{filename}                       # Single-file asset (unchanged)
assets/{assetId}/_archive/_checkpoint.json        # Resume checkpoint
assets/{assetId}/_archive/_entry_list.jsonl       # Entry list (during extraction, deleted on completion)
assets/{assetId}/_archive/_manifest.jsonl          # Final file manifest
assets/{assetId}/_archive/_manifest_chunks/       # Manifest chunks (during extraction)
assets/{assetId}/files/{path}                     # Extracted files
```

### Manifest format (`_manifest.jsonl`)

```jsonl
{"path":"tiles/0/0/0.pbf","size":1234,"contentType":"application/x-protobuf"}
{"path":"tileset.json","size":456,"contentType":"application/json","contentEncoding":"gzip"}
```

JSONL allows streaming read/write without loading all entries into memory.

## API changes

### New endpoints

| Method | Path | Description |
|---|---|---|
| `GET` | `/jobs/:id` | Job progress |
| `POST` | `/jobs/:id/retry` | Restart a stalled job |
| `POST` | `/jobs/:id/status` | Internal: container → Worker status update |

### Modified endpoints

| Method | Path | Change |
|---|---|---|
| `GET` | `/assets/:id` | Added `type`, `status`, `archiveFormat`, `fileCount`, `extractedSize`, `jobId` fields |
| `GET` | `/files/:id/*path` | Subpath routing for extracted archive files |

## Alternatives considered

### Node.js container
Rejected because: no `archive/zip` equivalent with Central Directory support, heavier Docker images, worse concurrency primitives for this workload.

### Cloud Run Jobs instead of Cloudflare Containers
Kept as a fallback for 100GB+ archives where Cloudflare Container limits may be reached. The Go code is portable — only the R2 endpoint configuration changes.

### KV for checkpoints
Rejected because: using R2 keeps the container self-contained (S3 API only, no Worker API needed for checkpoint reads/writes).

### Full-file download for ZIP
Rejected because: Range request adapter enables Central Directory reading with minimal bandwidth. For a 10GB ZIP, only a few KB are read to list all entries.

## Consequences

- Archives up to ~50GB / ~500K files can be processed with resume support
- The extraction container is independently testable via `MemoryStorage` mock
- Path normalization handles Windows-created archives transparently
- Compressible files (JSON, GeoJSON, CSV, etc.) are gzip-compressed before upload, saving storage and transfer costs
- Container restart detection requires a Cron Trigger or manual retry via `/jobs/:id/retry` (not yet implemented)
