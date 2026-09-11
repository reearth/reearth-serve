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
| `npm run test:e2e:dev` | Start the Cloudflare dev server + run E2E tests + shut down |
| `npm run test:e2e:node` | Same suite against the Node runtime, no cloud credentials |
| `npm run start:node` | Start the Node runtime (API only, port 8788) |
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
| `E2E_THUMBNAILS` | (unset) | Set to `false` to skip thumbnail tests on a runtime without the jSquash wasm codecs |
| `E2E_SITE_HOST_SUFFIX` | (unset) | The suffix the server was started with; unset ⇒ the site-host suite is skipped |
| `E2E_MOCK_DOH` | (unset) | Base URL of the mock DoH resolver (`e2e/mock-doh.ts`); unset ⇒ the custom-domain verification tests are skipped |

`npm run test:e2e:node` starts `runtime/node` instead of wrangler and sets
`E2E_PRESIGNED=false`, `E2E_CONTAINER=false` and `E2E_THUMBNAILS=false`, since
that runtime has none of those three features. Everything else runs unchanged.

### Container Tests (Go)

```bash
cd container/archive-extractor
go test -v -race -count=1 ./...
```

## Database

Metadata is stored in Cloudflare D1 (SQLite). Sessions and upload sessions use KV with TTL auto-expiration.

### Schema Migrations

The domain schema lives in `adapters/cloudflare/migrations/` and is managed by
wrangler. `adapters/sql/migrations/` holds the `kv` and `queue_messages` tables,
which stand in for Cloudflare KV and Queues — the Node runtime applies both
directories, and D1 must never get the second one.

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

The latest domain migration is `0004_add_site_hosts.sql` (ADR-013 B2). It adds
a table only, so it is backward-compatible and can be applied before the deploy:
`npx wrangler d1 migrations apply reearth-serve --remote`. The Node runtime and
the unit tests pick it up automatically — both apply
`adapters/cloudflare/migrations/` wholesale — so nothing outside D1 needs a
manual step.

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
| `CLOUDFLARE_ACCOUNT_ID` | Optional. When unset, `scripts/deploy.sh` lists the accounts the token can see and uses the only one; with several, set this or `CLOUDFLARE_ACCOUNT_NAME` |
| `CLOUDFLARE_ACCOUNT_NAME` | Optional. Picks the account by name when the token can see more than one |
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
| `SITE_HOST_SUFFIX` | No | Wildcard suffix site hosts live under, e.g. `.serve.reearth.land` (ADR-013 B1). Unset ⇒ site hosts and custom domains are off. Set in `wrangler.toml` once the zone is ready |
| `CF_API_TOKEN` | No† | Cloudflare API token with `Zone → SSL and Certificates: Edit` on the site-host zone, for Cloudflare for SaaS custom hostnames (ADR-013 B5) |
| `CF_ZONE_ID` | No† | The zone the custom hostnames are registered on (ADR-013 B5) |
| `SITE_FALLBACK_ORIGIN` | No | What a customer CNAMEs their domain at — Cloudflare for SaaS's fallback origin. Unset ⇒ the host of `BASE_URL` |
| `SITE_DNS_RESOLVER_URL` | No | DNS-over-HTTPS endpoint used for the custom-domain TXT check. Default `https://cloudflare-dns.com/dns-query` |

\* Required for presigned URL uploads and archive extraction containers.

† Both or neither. With both, a verified custom domain is registered on the
zone and gets a DV certificate automatically; with neither, the customer is
told to CNAME at the fallback origin and the operator terminates TLS
themselves (which is what the Node runtime always does).

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
# Fill in CLOUDFLARE_KV_NAMESPACE_ID, CLOUDFLARE_D1_DATABASE_ID,
# CLOUDFLARE_R2_BUCKET_NAME. CLOUDFLARE_ACCOUNT_ID is optional: it is
# auto-selected from the API token when the token sees exactly one account.
npm run deploy
```

## Architecture Decisions

Architecture Decision Records are in [`docs/adr/`](./docs/adr/).
