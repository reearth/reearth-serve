# ADR-012: Multi-Cloud Portability via Ports and Per-Cloud Composition Roots

- **Status:** Proposed
- **Date:** 2026-09-09
- **Deciders:** @rot1024

## Context

Re:Earth Serve is built on Cloudflare (Workers, R2, D1, KV, Queues, Containers). Some target customers, notably government and enterprise procurement, require deployment on AWS or Google Cloud. We want to support that without maintaining a second implementation.

Two things about the current code shape the decision:

1. **The domain layer is already provider-agnostic.** Use cases depend on interfaces (`MetadataStore`, `VersionStore`, `FileStorage`, `JobStore`, `ContainerLauncher`, ...) declared in each module's `repository.ts`. Cloudflare types (`R2Bucket`, `D1Database`, `KVNamespace`, `MessageBatch`, `Queue`) appear only in `worker/infra/*`, the composition root `worker/app.ts`, the entrypoint `worker/index.ts`, the queue/cron handlers (`extraction/handler.ts`, `thumbnail/handler.ts`, `cleanup/handler.ts`), and the JWKS cache in `auth/middleware.ts`.
2. **The D1 layer uses a very small API surface.** `infra/d1.ts` (about 1,100 lines of SQL) uses only `prepare().bind().first()/all()/run()`. No `batch()`, no D1-specific metadata. The SQL itself is plain SQLite (`INSERT OR REPLACE`, `ON CONFLICT`, `RETURNING`, `json_extract`).

The archive extractor and thumbnail containers already speak the S3 API through `aws-sdk-go-v2`, so they run against S3, GCS (HMAC interop) and R2 with an endpoint change.

What is *not* portable is Cloudflare's value proposition itself: zero-egress R2 and edge execution. The AWS/GCP variant is therefore positioned as a self-hosted deployment with the same API and CLI, not as a cost-equivalent one.

## Decision

### 1. One core, one set of ports, one composition root per cloud

```
core/                    domain models, use cases, port interfaces
adapters/
  cloudflare/            R2, D1, KV, Queues, Containers
  aws/                   S3, Hrana SQL, SQL-backed queue/KV, ECS RunTask
  gcp/                   GCS, Hrana SQL, SQL-backed queue/KV, Cloud Run Jobs
  memory/                in-memory / local SQLite for unit and e2e tests
runtime/
  cloudflare/index.ts    fetch / scheduled / queue  → createApp(buildDeps(env))
  node/index.ts          @hono/node-server, POST /internal/cron, queue poller
```

`createApp(env: Env)` becomes `createApp(deps: Deps)`, where `Deps` is the object already described by `AppEnv.Variables`. Queue and cron handlers receive the same `Deps` instead of constructing adapters from `env`. Only `runtime/<cloud>/` and `adapters/<cloud>/` may import provider SDKs or provider types.

### 2. Ports and their implementations

| Port | Cloudflare | AWS / GCP | Notes |
|---|---|---|---|
| `FileStorage` | R2 binding | S3 / GCS via S3 API (`aws4fetch`) | `FixedLengthStream` stays inside the R2 adapter |
| `PresignedUrlGenerator` | SigV4 (`aws4fetch`) | same code, different endpoint | GCS via HMAC keys |
| `SqlClient` (new) | D1 | **Hrana over HTTP** (`@libsql/client`) | SQLite dialect fixed; see §3 |
| `KeyValue` (new, wraps `SessionStore`, `UploadSessionStore`, JWKS cache) | KV | SQL table with `expires_at` + cron sweep | Removes one managed service on non-CF |
| `JobQueue` (new) | Queues | SQL-backed outbox polled by cron | See §4 |
| `ContainerLauncher` | Durable Object + Containers | ECS Fargate `RunTask` / Cloud Run Jobs | Container env vars renamed `R2_*` → `OBJECT_STORE_*` |
| Scheduler | cron trigger | EventBridge / Cloud Scheduler → `POST /internal/cron` | `handleScheduled(deps)` unchanged |
| `DnsResolver` (new) | DNS-over-HTTPS (`adapters/doh/`) | the same adapter | One `fetch`, so one implementation runs everywhere; `node:dns` would have been Node-only (ADR-013 B5) |
| `CustomHostnameProvisioner` (new) | Cloudflare for SaaS custom hostnames | ACM / a Let's Encrypt companion, or `NoopProvisioner` where the operator terminates TLS | Certificates for customers' own domains — the most platform-specific thing in ADR-013 (B5) |
| `Limits` (new) | `SubrequestBudget` = 1000 | effectively unbounded | Cloudflare-only constraint becomes configuration |
| HTTP runtime | Workers | Hono on Node (Cloud Run / ECS / Lambda) | React Router SSR runs on Node unchanged |

### 3. `SqlClient`: SQLite dialect, Hrana on the wire

```ts
export interface SqlClient {
  execute(sql: string, args?: SqlValue[]): Promise<{ rows: Row[]; rowsAffected: number }>;
  /** Executes all statements atomically. No interactive transaction: D1 offers only batch(). */
  batch(statements: { sql: string; args?: SqlValue[] }[]): Promise<{ rows: Row[]; rowsAffected: number }[]>;
}
```

- The SQL dialect is **SQLite, and only SQLite**. The existing SQL strings are not rewritten.
- On Cloudflare the implementation wraps D1.
- Off Cloudflare the implementation is `@libsql/client` speaking **Hrana over HTTP**. The initial server is self-hosted `libsql-server` (sqld, MIT); sqld has a single primary, so it runs as its own service with one instance. Any server that implements Hrana can replace it later without touching Serve, and the single-instance constraint belongs to sqld, not to the port. The migration path at every step (D1 → sqld → a later Hrana server) is a SQLite file: `wrangler d1 export` produces one, and sqld's database file is one.
- The adapter uses only `execute` and `batch`. Hrana extensions such as cursors and `store_sql` are avoided so that a server implementing the core subset is sufficient.
- `batch` is part of the port from day one, and it is deliberately non-interactive: D1 has no `BEGIN`/`COMMIT` across requests, only an atomic `batch()`, and Hrana's `batch` matches it. Use cases already avoid read-then-write atomicity (version numbers are assigned inside the `INSERT`, storage usage is updated with `total_size + ?`), so a statement list is enough. Multi-statement writes (asset + version + storage usage on upload, job + version on completion) go through `batch`. On D1 this makes them atomic; on a Hrana server whose commit is a durable round trip, it turns N round trips into one.

### 4. `JobQueue`: outbox first, managed queues as an adapter slot

```ts
export interface JobQueue<T> {
  send(message: T, options?: { delaySeconds?: number }): Promise<void>;
}
export interface QueueMessage<T> {
  body: T; attempts: number;
  ack(): void; retry(options?: { delaySeconds?: number }): void;
}
```

Off Cloudflare the first implementation is a `queue_messages` table drained by the cron endpoint. The extraction and thumbnail queues carry only "launch a container / generate thumbnails, with retry and backoff", and the cleanup cron already re-enqueues stuck extraction jobs, so an outbox reuses existing recovery logic. SQS / Pub/Sub adapters fit the same port and are added when throughput demands it.

### 5. Migration order

1. `createApp(deps)`; queue and cron handlers take `deps`; the JWKS cache takes a cache interface instead of `env.KV`. No behavior change on Cloudflare.
2. Rename container env vars (`R2_*` → `OBJECT_STORE_*`); keep the old names as fallbacks for one release.
3. Introduce `JobQueue` and `QueueMessage`; wrap Cloudflare Queues.
4. Introduce `SqlClient`; wrap D1. Route multi-statement writes through `batch`. Add an in-memory SQLite implementation so the repository layer is unit-tested without D1.
5. Introduce `KeyValue` and `Limits`.
6. Move directories (`worker/` → `core/`, `adapters/cloudflare/`, `runtime/cloudflare/`) in one import-only change, after steps 1–5 so it does not conflict with them.
7. Add `adapters/memory/` and `runtime/node` (Hono on Node, `POST /internal/cron`, SQL-backed queue and key-value), and run the e2e suite against them. API and file delivery first; React Router SSR on Node follows.
8. Add `adapters/aws/`, `adapters/gcp/`, and Terraform per cloud.

Steps 1–6 ship independently and leave the Cloudflare deployment unchanged.

## Alternatives Considered

### A. Provider-shaped shims (fake `R2Bucket` / `D1Database` / `Queue` for AWS)

Implement Cloudflare's binding types on top of S3, Postgres and SQS so that `createApp(env)` and the handlers stay untouched.

**Rejected.** It is the smallest diff, but it imports Cloudflare semantics into every cloud: KV's eventual consistency, D1's `prepare/bind` shape, the 1000-subrequest budget baked into `cleanup/handler.ts`, Queues' batch/ack model. Each shim is a partial emulation whose gaps surface as production bugs on the cloud we test least. The port-level cut is barely larger and gives each adapter its native semantics.

### B. Postgres as the non-Cloudflare database, via a dialect shim

Keep the SQL strings and translate at the driver (`?` → `$1`, `INSERT OR REPLACE` → `ON CONFLICT DO UPDATE`, JSON functions).

**Rejected.** Two dialects behind one string means silent divergence: `INSERT OR REPLACE` deletes-then-inserts in SQLite and fires delete triggers; `json_extract` and `->>` differ in return types; `RETURNING` and upsert edge cases differ. Every query would need a test on both engines, doubling the matrix for the layer with the most code. Fixing the dialect to SQLite and varying only the transport keeps one set of SQL semantics.

### C. Query builder / ORM (Kysely, Drizzle) with per-cloud dialects

Rewrite `infra/d1.ts` against a builder that emits SQLite or Postgres.

**Rejected for now.** It is a rewrite of the largest file in the codebase to solve a problem §3 solves with a transport change, and builders still leak dialect differences for upserts and JSON. Revisit if a Postgres-only requirement appears (for example a customer mandating RDS). The `SqlClient` port does not preclude this; a builder would sit above it.

### D. DynamoDB / Firestore for metadata off Cloudflare

**Rejected.** ADR-003 moved metadata off a key-value store precisely because index lists raced, counters were not atomic and ad-hoc queries were impossible. Reintroducing a KV-shaped store on other clouds reintroduces those problems there.

### E. S3-API-only `FileStorage`, dropping the R2 binding

One adapter everywhere, since R2 speaks S3.

**Rejected.** The binding needs no credentials in the Worker, has no request signing overhead, and is the path exercised in production. The S3 adapter is written anyway for AWS/GCP and can target R2 as a fallback; keeping both costs nothing.

### F. Managed queues (SQS / Pub/Sub) as the first non-Cloudflare queue

**Deferred.** They add a service, per-cloud IAM and a second consumer runtime for a workload of a few messages per minute. The outbox reuses the cron and the recovery logic that already exists for stuck jobs. The port keeps the slot open.

### G. Hrana server as a sidecar of every app instance

Run the SQL server on `localhost` next to each Serve instance (the usual sidecar layout).

**Not chosen as the default; kept as an option.** Serve scales horizontally, so N app instances would mean N Hrana servers writing one database. Whether that is a problem depends on the server: sqld has one primary and cannot run this way at all, while a server that arbitrates writes through object storage (conditional creates with fencing) stays correct under multiple writers and only pays for the losers' retries and rebuilds. So the layout is a cost question for the target server, not a correctness one. The default is a separate service with a small instance count, because it works for every Hrana server and keeps the SQL server's scaling independent of Serve's; a sidecar can be adopted per deployment once the backend supports it and the churn is measured.

### H. Run the Worker on other clouds via `workerd`

**Rejected.** `workerd` provides the runtime, not the bindings. R2, D1, KV, Queues and Containers have no equivalents outside Cloudflare, so the adapter work is identical and `workerd` only adds an unusual runtime to operate.

### I. Separate repository or fork per cloud

**Rejected.** Every feature would be implemented three times and drift immediately. The whole point of the port layer is that features land once in `core/`.

## Consequences

**Positive**

- Provider code is confined to `adapters/<cloud>/` and `runtime/<cloud>/`; `core/` compiles without `@cloudflare/workers-types`.
- The e2e suite runs against `runtime/node` + `adapters/memory/` with no cloud credentials, which is faster and cheaper than the current Cloudflare-bound e2e path.
- SQL stays a single dialect. The off-Cloudflare database backend can change (any Hrana server) without a Serve release.
- Multi-statement writes become atomic on every cloud, including D1.

**Negative**

- A directory move (`worker/` → `core/`, `adapters/`, `runtime/`) touches most imports once. It is mechanical but noisy in review.
- Off Cloudflare, every SQL write is a network round trip to a separate service rather than a binding call. Serve's write rate is low (asset creation, a job heartbeat every two minutes, storage-usage updates), so this is acceptable, but it is why `batch` is mandatory for multi-statement writes.
- The outbox queue has cron-tick latency (tens of seconds) instead of Queues' near-immediate dispatch. Acceptable for extraction and thumbnails; a managed-queue adapter exists as the escape hatch.
- Zero egress and edge execution are not reproduced. Documentation must state that the AWS/GCP deployment has different cost characteristics.

**Neutral**

- Cloudflare remains the primary deployment and the one exercised in CI on every change. AWS/GCP adapters need their own periodic e2e runs against real infrastructure.
- Terraform (or equivalent) per cloud is new operational surface and is out of scope for this ADR.

## Follow-ups

- Per-tenant databases (one SQLite database per workspace) would map cleanly onto the existing scope clause in `infra/d1.ts` and onto Hrana's path-per-database addressing, but cross-workspace listing (`accessibleByUser`) and anonymous-session assets need a directory database. Decide in a separate ADR once the Hrana backend is in place.
- Webhook delivery (ADR-007) will use `JobQueue` when implemented.
