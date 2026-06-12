# Contributing

## Prerequisites

- Node.js 22+
- Docker (for archive extraction container)
- Cloudflare account (for deployment)

## Development

```bash
npm install
npm run dev        # Start dev server with HMR (port 5173)
```

### Scripts

| Command | Description |
|---------|-------------|
| `npm run dev` | Start dev server with HMR |
| `npm run build` | Production build |
| `npm run deploy` | Build + deploy to Cloudflare |
| `npm run check` | Type check + unit tests |
| `npm run test` | Unit tests only |
| `npm run test:e2e:dev` | Start dev server + run E2E tests + shut down |
| `npm run test:e2e` | E2E tests (requires running dev server) |
| `npm run typecheck` | TypeScript type check |
| `npm run typegen` | Generate Wrangler + React Router types |
| `npm run cli -- <command>` | Run CLI commands |

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

#### E2E Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `E2E_ENDPOINT` | `http://localhost:8787` | Dev server URL |
| `E2E_PRESIGNED` | (unset) | Set to `true` to enable presigned upload tests |
| `E2E_CONTAINER` | (unset) | Set to `true` to enable container extraction tests (requires Docker) |

### Container Tests (Go)

```bash
cd container/archive-extractor
go test -v -race -count=1 ./...
```

## Database

Metadata is stored in Cloudflare D1 (SQLite). Sessions and upload sessions use KV with TTL auto-expiration.

### Schema Migrations

Migrations live in `worker/infra/migrations/` and are managed by wrangler:

```bash
# Create a new migration
npx wrangler d1 migrations create reearth-serve <description>

# Apply locally (development)
npx wrangler d1 migrations apply reearth-serve --local

# Apply to production
npx wrangler d1 migrations apply reearth-serve --remote

# List pending migrations
npx wrangler d1 migrations list reearth-serve --remote
```

Migrations are automatically applied before deployment in `scripts/deploy.sh`.

When developing locally, the E2E test script (`scripts/e2e.sh`) automatically applies migrations after clearing miniflare state.

### Schema Changes

- **Backward-compatible changes** (add table, add nullable column): Apply migration first, then deploy code.
- **Breaking changes** (drop column, rename): Two-step deploy — first remove code references, then drop column in a separate migration.

## Deployment

### CI/CD

CI runs on push/PR to `main`:
- TypeScript type check + unit tests
- Production build
- Go lint + tests for containers

Deployment is triggered on push to `main` via `scripts/deploy.sh`:
1. D1 migrations are applied (`--remote`)
2. Code is built and deployed to Cloudflare Workers

### GitHub Secrets

| Secret | Description |
|--------|-------------|
| `CLOUDFLARE_API_TOKEN` | Cloudflare API token with Workers + Containers + R2 + KV + D1 permissions |
| `CLOUDFLARE_ACCOUNT_ID` | Your Cloudflare account ID |
| `CLOUDFLARE_KV_NAMESPACE_ID` | KV namespace ID |
| `CLOUDFLARE_D1_DATABASE_ID` | D1 database ID |
| `CLOUDFLARE_R2_BUCKET_NAME` | R2 bucket name |

### Worker Secrets (wrangler)

Set via `npx wrangler secret put <NAME>`:

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
| `CERBOS_ENDPOINT` | No | Cerbos PDP endpoint URL for authorization |

\* Required for presigned URL uploads and archive extraction containers.

### Initial Setup

```bash
# Create R2 bucket
npx wrangler r2 bucket create reearth-serve

# Create KV namespace
npx wrangler kv namespace create reearth-serve
# → Set the returned ID as CLOUDFLARE_KV_NAMESPACE_ID

# Create D1 database
npx wrangler d1 create reearth-serve
# → Set the returned ID as CLOUDFLARE_D1_DATABASE_ID

# Apply D1 schema
npx wrangler d1 migrations apply reearth-serve --remote

# Create R2 S3 API token (Cloudflare Dashboard → R2 → Manage R2 API Tokens)
# → Set R2_S3_ENDPOINT, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY via wrangler secret put

# Enable Cloudflare Containers (Dashboard → Workers & Pages → Containers)

# Create extraction queues
npx wrangler queues create reearth-serve-extraction
npx wrangler queues create reearth-serve-extraction-dlq

# Deploy
npm run deploy
```

### Local Deploy

```bash
cp .env.example .env
# Fill in CLOUDFLARE_ACCOUNT_ID, CLOUDFLARE_KV_NAMESPACE_ID,
# CLOUDFLARE_D1_DATABASE_ID, CLOUDFLARE_R2_BUCKET_NAME
npm run deploy
```

## Architecture Decisions

Architecture Decision Records are in [`docs/adr/`](./docs/adr/).
