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
curl -F "file=@myfile.geojson" http://localhost:5173/assets
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

```
worker/
├── index.ts              # Entry point (ExportedHandler)
├── app.ts                # Hono app factory with DI
├── types.ts              # Shared Hono env types
├── asset/
│   ├── model.ts          # Asset domain types
│   ├── repository.ts     # MetadataStore / FileStorage interfaces
│   ├── usecase.ts        # Business logic + in-source tests
│   └── handler.ts        # POST/GET/DELETE /assets
├── file/
│   └── handler.ts        # GET /files/:id/:filename (CORS *, Range)
└── infra/
    ├── storage.ts        # R2 FileStorage implementation
    └── metadata.ts       # KV MetadataStore implementation
app/                      # React Router frontend
cli/                      # CLI client
e2e/                      # E2E tests
```

## API

| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/assets` | Upload a file (multipart/form-data) |
| `GET` | `/assets/:id` | Get asset metadata |
| `DELETE` | `/assets/:id` | Delete an asset |
| `GET` | `/files/:id/:filename` | Download file (CORS `*`, Range support) |
| `GET` | `/health` | Health check |

Assets are **immutable** (upload or delete, no overwrite) and **ephemeral** (auto-expire after 1 hour).

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
