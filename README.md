# Re:Earth Serve

Spatial Data Delivery — an asset hosting and tile delivery service built on Cloudflare Workers + R2.

## Quick Start

```bash
npm install
npm run dev        # Start dev server (React Router + Cloudflare Workers)
```

### Upload a file (CLI)

```bash
npm run cli -- myfile.geojson
# → http://localhost:5173/files/abc123/myfile.geojson
```

### Upload a file (API)

```bash
curl -X POST http://localhost:5173/assets \
  -H "Content-Type: application/geo+json" \
  -H "X-Filename: myfile.geojson" \
  -H "Content-Length: $(wc -c < myfile.geojson)" \
  --data-binary @myfile.geojson
```

## Architecture

| Component | Technology |
|-----------|-----------|
| Runtime | Cloudflare Workers |
| Storage | Cloudflare R2 (zero egress) |
| Metadata | Cloudflare KV |
| API | Hono |
| UI | React Router (SSR) + Tailwind CSS |
| CLI | tsx |

### Project Structure

| Directory | Description |
|-----------|-------------|
| `worker/` | Cloudflare Worker (Hono routes, domain logic, infra adapters) |
| `app/` | React Router frontend |
| `cli/` | CLI client |
| `e2e/` | E2E tests |

## API

| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/assets` | Upload a file (multipart/form-data) |
| `GET` | `/assets/:id` | Get asset metadata |
| `DELETE` | `/assets/:id` | Delete an asset |
| `POST` | `/assets/uploads` | Create presigned upload session |
| `POST` | `/assets/uploads/:id/complete` | Complete upload session |
| `GET` | `/files/:id/:filename` | Download file (CORS `*`, Range support) |
| `GET` | `/health` | Health check |

Assets are **immutable** (upload or delete, no overwrite) and **ephemeral** (auto-expire after 1 hour).

### Presigned URL Uploads

For large files (>100MB or multi-GB), presigned URL uploads bypass the Worker body size limit. When S3 credentials are configured, the server generates presigned URLs for direct-to-R2 uploads. Files >100MB are automatically split into multipart uploads.

The CLI automatically uses presigned URLs when available, falling back to direct upload.

### Gzip Compression

Compression is the **uploader's responsibility** — the server never buffers or compresses on the upload path.

- **Presigned URL upload**: For compressible files (JSON, GeoJSON, CSV, XML, KML, GML, SVG, etc.) over 1KB, the server returns `contentEncoding: "gzip"` in the session response. The CLI compresses locally before uploading
- **Direct upload** (`POST /assets`): Files are stored as-is without server-side compression
- **Download**: If the file is stored with gzip encoding and the client sends `Accept-Encoding: gzip`, the compressed data is passed through directly. Otherwise, the server decompresses on the fly via streaming
- **Range requests**: Supported on gzip-stored files — the server decompresses, seeks to the requested byte offset, and streams the range

## Scripts

| Command | Description |
|---------|-------------|
| `npm run dev` | Start dev server with HMR |
| `npm run build` | Production build |
| `npm run deploy` | Build + deploy to Cloudflare |
| `npm run check` | Type check + unit tests |
| `npm run test` | Unit tests only |
| `npm run test:e2e` | E2E tests (requires running dev server) |
| `npm run typecheck` | TypeScript type check |
| `npm run typegen` | Generate Wrangler + React Router types |
| `npm run cli -- <file>` | Upload a file via CLI |

### Running E2E Tests

```bash
# Terminal 1
npm run dev

# Terminal 2
E2E_ENDPOINT=http://localhost:5173 npm run test:e2e
```

## Deployment

Deployment is handled via GitHub Actions on push to `main`.

### Prerequisites

Add the following secrets to your GitHub repository:

| Secret | Description |
|--------|-------------|
| `CLOUDFLARE_API_TOKEN` | Cloudflare API token with Workers + R2 + KV permissions |
| `CLOUDFLARE_ACCOUNT_ID` | Your Cloudflare account ID |

### Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `ASSET_TTL_SECONDS` | Yes | Asset expiry time in seconds (default: 3600) |
| `BASE_URL` | Yes | Public base URL for file download links |
| `R2_S3_ENDPOINT` | No | R2 S3-compatible endpoint for presigned URLs |
| `R2_ACCESS_KEY_ID` | No | R2 API token access key ID |
| `R2_SECRET_ACCESS_KEY` | No | R2 API token secret access key |
| `R2_BUCKET_NAME` | No | R2 bucket name for presigned URLs |

When `R2_S3_ENDPOINT`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, and `R2_BUCKET_NAME` are all set, presigned URL uploads and S3 multipart uploads are enabled.

### Initial Setup

```bash
# Create R2 bucket
wrangler r2 bucket create reearth-serve-assets

# Create KV namespace
wrangler kv namespace create KV
# → Update the KV namespace ID in wrangler.jsonc
```

## Roadmap

See [ROADMAP.md](./ROADMAP.md) for the full development roadmap.
