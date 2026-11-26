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
| `npm run test:e2e:accounts` | E2E suite for the optional accounts adapter ([`adapters/accounts/README.md`](./adapters/accounts/README.md)) |
| `npm run start:node` | Start the Node runtime (API only, port 8788) |
| `npm run test:e2e` | E2E tests (requires running dev server) |
| `npm run typecheck` | TypeScript type check |
| `npm run db:check` | Check migration files against `origin/main` (see Schema Migrations) |
| `npm run db:hash` | Rewrite both `atlas.sum` files after adding a migration |
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
| `E2E_COMPAT_GCS_HOST` | (unset) | The `COMPAT_GCS_HOST` the server was started with; unset ⇒ the compat credential and GCS API tests are skipped. The Go client scenarios (`e2e/compat-gcs/`) also need `go` 1.26 on `PATH`, and are skipped with a warning without it |
| `E2E_MOCK_DOH` | (unset) | Base URL of the mock DoH resolver (`e2e/mock-doh.ts`); unset ⇒ the custom-domain verification tests are skipped |

`npm run test:e2e:node` starts `runtime/node` instead of wrangler and sets
`E2E_PRESIGNED=false`, `E2E_CONTAINER=false` and `E2E_THUMBNAILS=false`, since
that runtime has none of those three features. It also sets `SIGNING_SECRET`,
without which the password-protection suite (`e2e/access.test.ts`) would be
exercising the missing-secret path rather than the feature. Everything else
runs unchanged.

### Container Tests (Go)

```bash
cd container/archive-extractor
go test -v -race -count=1 ./...
```

## Database

Metadata is stored in Cloudflare D1 (SQLite). Sessions and upload sessions use KV with TTL auto-expiration.

### Schema Migrations

The domain schema lives in `adapters/cloudflare/migrations/`. wrangler applies
it to D1 and records each applied file in D1's `d1_migrations` table.
`adapters/sql/migrations/` holds the `kv` and `queue_messages` tables, which
stand in for Cloudflare KV and Queues. The Node runtime and the unit tests
apply both directories. D1 must never get the second one.

[Atlas](https://github.com/ariga/atlas) checks the files but never applies
them (see [ADR-020](./docs/adr/020-atlas-migrations.md)). Each directory has an
`atlas.sum`, and `npm run db:check` runs these checks against `origin/main`
(set `DB_CHECK_BASE` to compare with another ref):

- file names are `NNNN_name.sql`, and no two files share a prefix;
- a file on the base branch is unchanged;
- a new file sorts after the base branch's highest prefix;
- `atlas.sum` matches the files, and the files replay on SQLite;
- the new files contain no destructive change.

CI runs the same command, and deploy waits for it. The first run downloads the
Atlas binary pinned in `tools/atlas.lock`, so it needs network access. It needs
no Atlas account.

To add a domain migration:

```bash
npx wrangler d1 migrations create reearth-serve <description>
# edit the new file, then:
npm run db:hash
npm run db:check
```

A Node-only migration goes in `adapters/sql/migrations/`, created by hand with
the next free prefix and a name that no domain migration uses.

Rules:

- **Never edit a merged migration.** Add a new one. A changed file replays
  differently on a fresh database, and `db:check` fails on it.
- **Renumber on a collision.** If another PR merged the same prefix first,
  rename your file to the next free prefix and rerun `npm run db:hash`.
- **Do not use `atlas migrate diff`.** Its output for this schema fails on D1,
  and its timestamp file names break the `NNNN` order.
- **Waive a destructive change only on purpose.** A table rebuild (create a new
  table, copy, drop the old one) trips the lint. Put a
  `-- atlas:nolint <code>` line that names each analyzer it waives, such as
  `DS102` for a dropped table, with a comment line beside it that says why. A
  bare `-- atlas:nolint` waives every analyzer and fails `db:check`.

```sql
-- Rebuild assets to change a column type; the data is copied above.
-- atlas:nolint DS102
DROP TABLE assets_old;
```

Other commands:

```bash
# Apply locally (development)
npx wrangler d1 migrations apply reearth-serve --local

# List pending migrations
npx wrangler d1 migrations list reearth-serve --remote
```

`scripts/deploy.sh` applies pending migrations to remote D1 before each
deploy. The E2E script (`scripts/e2e.sh`) clears the local state and applies
them to a local D1.

### Schema Changes

- **Backward-compatible changes** (add table, add nullable column): Apply migration first, then deploy code.
- **Breaking changes** (drop column, rename): Two-step deploy — first remove code references, then drop column in a separate migration.

## Deployment

### CI/CD

CI runs on push/PR to `main`:
- TypeScript type check + unit tests
- Production build
- Go lint + tests for containers
- Migration checks (`npm run db:check`)

Deployment is triggered on push to `main`, once the type check, build and migration checks pass, via `scripts/deploy.sh`:
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
| `CERBOS_ENDPOINT` | No | Cerbos PDP endpoint URL (http or https) for authorization; starting policies in `docs/examples/cerbos/`. An outage answers 503 with `Retry-After: 5`. An invalid value stops Node at startup; on Workers every `/api/` and `/files` request answers `500`. |
| `SIGNING_SECRET` | No‡ | HMAC key for the viewer-authentication cookie of password-protected sites (ADR-013 B7), not used for delivery tokens (ADR-014 §4). A secret (`wrangler secret put SIGNING_SECRET`), not a var |
| `DELIVERY_TOKEN_KEYS` | No | Delivery token key ring, `{"active":"<kid>","keys":{"<kid>":"<base64 secret>"}}`, at most two keys of 32 bytes or more. Generate a secret with `openssl rand -base64 32`. An invalid value stops Node at startup; on Workers every `/api/` and `/files` request answers `500`. |
| `CREDENTIALED_ORIGINS` | No | Comma-separated exact origins, besides Serve's own, whose pages may read a protected file with the visitor's cookie. An entry with a path, a wildcard or `null` fails at start |
| `SITE_HOST_SUFFIX` | No | Wildcard suffix site hosts live under, e.g. `.sites.example.net` (ADR-013 B1). Unset ⇒ site hosts and custom domains are off. Set in `wrangler.toml` once the zone is ready |
| `SITE_REGISTRABLE_DOMAIN` | With `SITE_HOST_SUFFIX` | The registrable domain the site hosts live under, e.g. `example.net`. The Worker refuses to serve when the suffix is not under it or when the `BASE_URL` host is |
| `SITE_DOMAIN_IS_PUBLIC_SUFFIX` | No | `"true"` skips the site-isolation check, for a domain on the Public Suffix List. Logged |
| `CF_API_TOKEN` | No† | Cloudflare API token with `Zone → SSL and Certificates: Edit` on the site-host zone, for Cloudflare for SaaS custom hostnames (ADR-013 B5) |
| `CF_ZONE_ID` | No† | The zone the custom hostnames are registered on (ADR-013 B5) |
| `SITE_FALLBACK_ORIGIN` | No | What a customer CNAMEs their domain at — Cloudflare for SaaS's fallback origin. Unset ⇒ the host of `BASE_URL` |
| `SITE_DNS_RESOLVER_URL` | No | DNS-over-HTTPS endpoint used for the custom-domain TXT check. Default `https://cloudflare-dns.com/dns-query` |
| `COMPAT_GCS_HOST` | No | Host the GCS-compatible API answers on (ADR-019), e.g. `storage.example.com`. A bare `host[:port]`; a scheme or path refuses to start. Key files name it as their token endpoint. Unset ⇒ the API is off and issuing a compat credential answers 503 |
| `COMPAT_OBJECTS_HOST` | No | Read-only public objects host (ADR-019 §6). A bare `host[:port]`. Reserved: answers 501 until it is built |
| `ACCOUNTS_URL` | No | Optional adapter setting. Takes workspaces, members and decisions from an external accounts service; see [`adapters/accounts/README.md`](./adapters/accounts/README.md). Excludes `CERBOS_ENDPOINT` and needs `OIDC_ISSUER_URL`. An invalid value stops Node at startup; on Workers every `/api/` and `/files` request answers `500`. |

\* Required for presigned URL uploads and archive extraction containers.

‡ Required only to protect a site. Unset, an asset cannot be given a password
(`503` on the PATCH) and one that already has one answers `503` instead of
serving its bytes — fail closed, the same rule `INTERNAL_API_SECRET` follows.

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
