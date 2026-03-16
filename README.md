# Re:Earth Serve

Spatial Data Delivery — an asset hosting and tile delivery service built on Cloudflare Workers + R2.

## Quick Start

```bash
npm install
npm run dev        # Start dev server (React Router + Cloudflare Workers)
```

### Upload a file (CLI)

```bash
npm run cli -- upload myfile.geojson
# → http://localhost:5173/files/abc123/myfile.geojson
```

### Upload a file (API)

```bash
curl -X POST http://localhost:5173/api/v1/assets \
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
| Containers | Cloudflare Containers (Go) |
| API | Hono |
| UI | React Router (SSR) + Tailwind CSS |
| CLI | Commander.js + tsx |

### Project Structure

| Directory | Description |
|-----------|-------------|
| `worker/` | Cloudflare Worker (Hono routes, domain logic, infra adapters) |
| `shared/` | Shared types (Zod schemas) and API path constants |
| `app/` | React Router frontend |
| `cli/` | CLI client (Commander.js) |
| `container/archive-extractor/` | Archive extraction container (Go) — ZIP/tar/tar.gz → R2 |
| `e2e/` | E2E tests |

## API

### Public API (`/api/v1`)

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/api/v1/health` | Health check |
| `POST` | `/api/v1/assets` | Upload a file (streaming) |
| `GET` | `/api/v1/assets` | List assets (`?limit=&cursor=`) |
| `GET` | `/api/v1/assets/:id` | Get asset metadata |
| `GET` | `/api/v1/assets/:id/files` | List files (NDJSON stream, `?prefix=` filter) |
| `DELETE` | `/api/v1/assets/:id` | Delete an asset |
| `POST` | `/api/v1/assets/uploads` | Create presigned upload session |
| `POST` | `/api/v1/assets/uploads/:id/complete` | Complete upload session |
| `GET` | `/api/v1/jobs` | List jobs (`?limit=&cursor=`) |
| `GET` | `/api/v1/jobs/:id` | Get extraction job status |
| `POST` | `/api/v1/jobs/:id/retry` | Retry a failed extraction job |
| `GET` | `/api/v1/me` | Get current user info + workspace list |
| `GET` | `/api/v1/projects` | List projects (`?workspaceId=` filter) |
| `POST` | `/api/v1/projects` | Create project |
| `GET` | `/api/v1/projects/:id` | Get project |
| `DELETE` | `/api/v1/projects/:id` | Delete project |
| `POST` | `/api/v1/workspaces` | Create workspace |
| `GET` | `/api/v1/workspaces/:id` | Get workspace |
| `DELETE` | `/api/v1/workspaces/:id` | Delete workspace |
| `GET` | `/api/v1/workspaces/:id/members` | List workspace members |
| `POST` | `/api/v1/workspaces/:id/members` | Add member |
| `PATCH` | `/api/v1/workspaces/:id/members/:userId` | Update member role |
| `DELETE` | `/api/v1/workspaces/:id/members/:userId` | Remove member |

### Internal API (`/api/internal`)

| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/api/internal/jobs/:id/status` | Container → Worker job status update |

### File Delivery

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/files/:id/:filename` | Download file (CORS `*`, Range support) |
| `GET` | `/files/:id/:filename/*` | Download extracted archive file |

Assets are **immutable** (upload or delete, no overwrite) and **ephemeral** (auto-expire after 1 hour).

### Archive Extraction

When an archive file (ZIP, tar, tar.gz) is uploaded, it is automatically extracted in a Cloudflare Container. Individual files are stored in R2 and served via `/files/:id/:filename/*`.

- Supports ZIP (random access via Range requests), tar, and tar.gz formats
- Handles multi-GB archives with hundreds of thousands of files
- Resume support via checkpoints — survives container restarts
- Windows path separators (`\`) are normalized to `/`
- Root folder auto-stripping (e.g., `data.zip/data/...` → strips `data/`)
- Compressible files (JSON, GeoJSON, CSV, etc.) are gzip-compressed on upload

### Presigned URL Uploads

For large files (>100MB or multi-GB), presigned URL uploads bypass the Worker body size limit. When S3 credentials are configured, the server generates presigned URLs for direct-to-R2 uploads. Files >100MB are automatically split into multipart uploads.

The CLI automatically uses presigned URLs when available, falling back to direct upload.

### Gzip Compression

Compression is the **uploader's responsibility** — the server never buffers or compresses on the upload path.

- **Presigned URL upload**: For compressible files (JSON, GeoJSON, CSV, XML, KML, GML, SVG, etc.) over 1KB, the server returns `contentEncoding: "gzip"` in the session response. The CLI compresses locally before uploading
- **Direct upload** (`POST /api/v1/assets`): Files are stored as-is without server-side compression
- **Download**: If the file is stored with gzip encoding and the client sends `Accept-Encoding: gzip`, the compressed data is passed through directly. Otherwise, the server decompresses on the fly via streaming
- **Range requests**: Supported on gzip-stored files — the server decompresses, seeks to the requested byte offset, and streams the range

### CLI

The CLI (`npm run cli --`) provides subcommands for managing assets and files. Set `REEARTH_SERVE_ENDPOINT` to change the target server (default: `http://localhost:8787`).

```bash
# Upload
npm run cli -- upload myfile.geojson
npm run cli -- upload --direct myfile.geojson   # skip presigned URLs

# Asset management
npm run cli -- asset list
npm run cli -- asset list --limit 50 --cursor <cursor>
npm run cli -- asset show <id>
npm run cli -- asset delete <id>

# File operations
npm run cli -- file ls <id>                     # list files
npm run cli -- file ls -l <id> tiles/           # detailed list with prefix filter
npm run cli -- file cp <id>:tileset.json .       # download single file
npm run cli -- file cp -r <id>:tiles/ ./out     # recursive download
npm run cli -- file cp -rf <id>:tiles/ ./out    # recursive + overwrite
npm run cli -- file sync <id> ./local           # hash-based diff sync
npm run cli -- file sync --delete <id> ./local  # sync + remove extra local files

# Job management
npm run cli -- job list
npm run cli -- job show <id>
npm run cli -- job retry <id>

# Project management
npm run cli -- project list
npm run cli -- project create <name>
npm run cli -- project show <id>
npm run cli -- project delete <id>
npm run cli -- project use <id>                 # set default project

# Workspace management
npm run cli -- workspace list
npm run cli -- workspace create <name>
npm run cli -- workspace show <id>
npm run cli -- workspace delete <id>
npm run cli -- workspace use <id>               # set default workspace
npm run cli -- workspace member list
npm run cli -- workspace member add <userId> --role editor
npm run cli -- workspace member update <userId> --role admin
npm run cli -- workspace member remove <userId>

# Authentication
npm run cli -- login --issuer <url> --client-id <id>
npm run cli -- whoami
npm run cli -- logout

# Global options
npm run cli -- --endpoint https://example.com upload myfile.geojson
npm run cli -- --json asset show <id>           # JSON output
```

`file sync` uses MD5 hash comparison (matching R2 ETags) to skip unchanged files. When no hash is available, it falls back to size comparison.

## Scripts

| Command | Description |
|---------|-------------|
| `npm run dev` | Start dev server with HMR |
| `npm run build` | Production build |
| `npm run deploy` | Build + deploy to Cloudflare |
| `npm run check` | Type check + unit tests |
| `npm run test` | Unit tests only |
| `npm run test:e2e` | E2E tests (requires running dev server) |
| `npm run test:e2e:dev` | Start dev server, run E2E tests, and shut down |
| `cd container/archive-extractor && go test ./...` | Container unit tests |
| `npm run typecheck` | TypeScript type check |
| `npm run typegen` | Generate Wrangler + React Router types |
| `npm run cli -- upload <file>` | Upload a file via CLI |
| `npm run cli -- file ls <id>` | List files in an asset |
| `npm run cli -- file cp <id> <dest>` | Download a file |
| `npm run cli -- file sync <id> <dir>` | Sync asset files to local directory |
| `npm run cli -- --help` | Show all commands |

### Running E2E Tests

```bash
# One-liner: starts dev server, runs tests, shuts down
npm run test:e2e:dev

# Or manually in two terminals:
# Terminal 1
npm run dev

# Terminal 2
E2E_ENDPOINT=http://localhost:5173 npm run test:e2e
```

## Deployment

CI runs on every push/PR to `main`: TypeScript type check + unit tests, production build, and Go lint + tests for containers. Deployment to Cloudflare is triggered on push to `main` via `scripts/deploy.sh`.

### Local deploy

```bash
cp .env.example .env
# Fill in the values
npm run deploy
```

### Prerequisites

Add the following secrets to your GitHub repository:

| Secret | Description |
|--------|-------------|
| `CLOUDFLARE_API_TOKEN` | Cloudflare API token with Workers + Containers + R2 + KV permissions |
| `CLOUDFLARE_ACCOUNT_ID` | Your Cloudflare account ID |
| `CLOUDFLARE_KV_NAMESPACE_ID` | KV namespace ID |
| `CLOUDFLARE_R2_BUCKET_NAME` | R2 bucket name |

### Worker Secrets (wrangler)

Set these via `npx wrangler secret put <NAME>`:

| Variable | Required | Description |
|----------|----------|-------------|
| `ASSET_TTL_SECONDS` | Yes | Asset expiry time in seconds (default: 3600, set in wrangler.toml) |
| `BASE_URL` | Yes | Public base URL for file download links (set in wrangler.toml) |
| `R2_S3_ENDPOINT` | Yes* | R2 S3-compatible endpoint (`https://<account-id>.r2.cloudflarestorage.com`) |
| `R2_ACCESS_KEY_ID` | Yes* | R2 API token access key ID |
| `R2_SECRET_ACCESS_KEY` | Yes* | R2 API token secret access key |
| `R2_BUCKET_NAME` | Yes* | R2 bucket name |
| `OIDC_ISSUER_URL` | No | OIDC Issuer URL for JWT authentication |
| `OIDC_AUDIENCE` | No | JWT audience claim for token validation |
| `OIDC_CLIENT_ID` | No | OAuth2 Client ID |
| `CERBOS_ENDPOINT` | No | Cerbos PDP endpoint URL for authorization |

\* Required for presigned URL uploads and archive extraction containers.

### Initial Setup

```bash
# Create R2 bucket
npx wrangler r2 bucket create reearth-serve

# Create KV namespace
npx wrangler kv namespace create reearth-serve
# → Set the returned ID as CLOUDFLARE_KV_NAMESPACE_ID in .env and GitHub Secrets

# Create R2 S3 API token (Cloudflare Dashboard → R2 → Manage R2 API Tokens)
# → Set R2_S3_ENDPOINT, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY via wrangler secret put

# Enable Cloudflare Containers on the account (Dashboard → Workers & Pages → Containers)

# Create extraction queues
npx wrangler queues create reearth-serve-extraction
npx wrangler queues create reearth-serve-extraction-dlq

# Deploy
npm run deploy
```

## Roadmap

See [ROADMAP.md](./ROADMAP.md) for the full development roadmap.
