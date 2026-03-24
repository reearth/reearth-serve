# ADR-007: Webhooks and Event Log

- **Status:** Proposed
- **Date:** 2026-03-25
- **Deciders:** @rot1024

## Context

ADR-006 introduced Derived Assets, Asset Edges, and dirty propagation. External systems (e.g., reearth-untiled for tile generation, CI/CD pipelines, monitoring dashboards) need to react to asset lifecycle events — new versions uploaded, dirty propagation, status transitions, etc.

Without a webhook system, external engines must poll for changes, which is wasteful and introduces latency. Additionally, government and municipal users (PLATEAU) require auditability — a durable record of what happened, when, and what was notified.

This ADR defines:
1. **Webhook subscriptions** — per-project registration of HTTP endpoints that receive event notifications
2. **Event log** — durable, queryable record of all events for auditability
3. **Scalable delivery** — Cloudflare-native architecture that handles bursty event fan-out
4. **Developer tooling** — Stripe CLI-inspired local development and testing features

### Scope

This ADR covers webhooks for internal/first-party use — the project owner registers endpoints for their own systems. Webhook "apps" (distributable integrations that other users can install, like Slack or GitHub Apps) are explicitly **out of scope** for now.

## Decision

### 1. Event Model

All state changes in the system produce **events**. Events are the source of truth; webhooks are a delivery mechanism for events.

```typescript
interface Event {
  id: string;                    // ULID
  type: string;                  // e.g., "asset.version.created"
  projectId: string;
  timestamp: number;             // Unix ms
  data: Record<string, unknown>; // event-specific payload
  actor?: {                      // who/what caused the event
    type: "user" | "system" | "api_key";
    id: string;
  };
}
```

#### Event Types

| Event | Trigger | Key Data |
|-------|---------|----------|
| `asset.created` | New asset created | `{ asset }` |
| `asset.updated` | Asset metadata/user_meta changed | `{ asset, changes }` |
| `asset.deleted` | Asset deleted | `{ assetId }` |
| `asset.dirty` | Asset marked dirty (with propagation list) | `{ assetId, propagated: [assetId...] }` |
| `asset.version.created` | New version uploaded | `{ assetId, version }` |
| `asset.version.status_changed` | Status transition (dirty→pending→ready/failed) | `{ assetId, versionId, from, to }` |
| `asset.version.deleted` | Version deleted | `{ assetId, versionId }` |
| `asset.edge.created` | Dependency edge added | `{ fromAssetId, toAssetId }` |
| `asset.edge.deleted` | Dependency edge removed | `{ fromAssetId, toAssetId }` |
| `asset.active_version.changed` | Active version set/unset | `{ assetId, versionId }` |

Event types use a dot-separated hierarchy. Subscribers can filter by exact type or prefix (e.g., `asset.version.*`).

### 2. Event Log (D1)

All events are persisted to D1 before any webhook delivery attempt. This guarantees auditability even if webhook delivery fails.

#### D1 Schema

```sql
CREATE TABLE events (
  id         TEXT PRIMARY KEY,
  type       TEXT NOT NULL,
  project_id TEXT NOT NULL,
  timestamp  INTEGER NOT NULL,
  data       TEXT NOT NULL,       -- JSON payload
  actor_type TEXT,
  actor_id   TEXT,
  meta       TEXT                 -- JSON: system metadata
);
CREATE INDEX idx_events_project_time ON events(project_id, timestamp);
CREATE INDEX idx_events_type ON events(type, timestamp);
CREATE INDEX idx_events_asset ON events(
  json_extract(data, '$.assetId'),
  timestamp
) WHERE json_extract(data, '$.assetId') IS NOT NULL;
```

#### Retention and Cold Archival

Events follow a **hot/cold** two-tier storage model:

**Hot tier (D1)** — last 30 days. Supports real-time queries, event replay, and delivery log correlation. A scheduled archival job incrementally moves expired events to cold storage.

**Cold tier (R2, Parquet)** — 30 days and older. Expired events are archived to R2 as Parquet files before being deleted from D1. This preserves long-term auditability while keeping D1 lean.

```
R2 key layout:
  events/{projectId}/year=2026/month=03/day=24/events.parquet
```

**Why Parquet?**
- Columnar format enables efficient analytical queries (e.g., "count all `asset.dirty` events in March") without reading entire files.
- Excellent compression ratio for repetitive event data (type strings, project IDs).
- Widely supported by analytics tools (DuckDB, Pandas, BigQuery, Athena) — users can download and analyze their own event history.
- R2's zero-egress cost makes cold storage essentially free at rest.

**Incremental archival process** (cron trigger, every hour):

Cloudflare Workers cron has a CPU time limit, so the archival job is designed to be **incremental and resumable** — it processes a small batch per invocation and picks up where it left off on the next run.

1. Read the archival cursor from KV (`archival_cursor` → `{ projectId, timestamp }`). On first run, start from the oldest event.
2. Query D1 for a batch of events older than 30 days, starting from the cursor position (`WHERE timestamp < :cutoff AND (project_id, timestamp) > (:cursorProject, :cursorTimestamp) ORDER BY project_id, timestamp LIMIT :batchSize`).
3. Group the batch by project and day.
4. For each (project, day) group:
   - Serialize events into a Parquet file (using parquet-wasm, or delegating to a Container if volume exceeds Worker limits).
   - Upload to R2. If a Parquet file already exists for that (project, day), append by reading the existing file, merging, and re-uploading.
   - Delete the archived rows from D1.
5. Update the archival cursor in KV to the last processed position.
6. If the batch was full (more work remaining), the next hourly invocation continues from the cursor.

**Key properties:**
- **Timeout-safe**: Each invocation processes a fixed-size batch (e.g., 1000 events). If the Worker times out mid-batch, no data is lost — undeleted rows remain in D1 and will be re-processed on the next run.
- **Idempotent**: Re-archiving the same events produces the same Parquet output. The delete-after-upload pattern means duplicate archival is harmless (same data written to R2 twice, then the D1 row is deleted).
- **Catches up naturally**: If event volume is high, the hourly job processes one batch per run. Over time (hours/days), it drains the backlog without any single invocation needing to handle the full volume.

**Cold tier query** — not served via the real-time Query API. Instead, users can download Parquet files directly via a dedicated endpoint:

```
GET /api/v1/projects/:projectId/events/archive
  ?year=2026&month=03
→ 200 { "files": [
    { "key": "events/proj-1/year=2026/month=03/day=01/events.parquet", "size": 12345, "url": "..." },
    ...
  ]}
```

Signed R2 URLs are returned for direct download. This keeps the hot-path API simple while providing full historical access.

#### Query API (Hot Tier)

```
GET /api/v1/projects/:projectId/events
  ?type=asset.version.created        -- exact type or prefix with *
  ?assetId=abc123                    -- filter by related asset
  ?after=2026-03-01T00:00:00Z       -- time range
  ?before=2026-03-25T00:00:00Z
  ?limit=50
  ?cursor=...
```

Returns events newest-first with cursor-based pagination.

### 3. Webhook Subscriptions

#### D1 Schema

```sql
CREATE TABLE webhook_endpoints (
  id          TEXT PRIMARY KEY,
  project_id  TEXT NOT NULL,
  url         TEXT NOT NULL,
  secret      TEXT NOT NULL,         -- HMAC signing secret
  description TEXT,
  events      TEXT NOT NULL,         -- JSON array of event type filters, e.g., ["asset.*", "asset.version.created"]
  enabled     BOOLEAN NOT NULL DEFAULT 1,
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL,
  meta        TEXT                   -- JSON: system metadata (failure count, last delivery, etc.)
);
CREATE INDEX idx_webhooks_project ON webhook_endpoints(project_id);
```

#### API

| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/api/v1/projects/:pid/webhooks` | Create webhook endpoint |
| `GET` | `/api/v1/projects/:pid/webhooks` | List webhook endpoints |
| `GET` | `/api/v1/projects/:pid/webhooks/:id` | Get webhook endpoint details |
| `PATCH` | `/api/v1/projects/:pid/webhooks/:id` | Update webhook (URL, events, enabled) |
| `DELETE` | `/api/v1/projects/:pid/webhooks/:id` | Delete webhook endpoint |
| `POST` | `/api/v1/projects/:pid/webhooks/:id/test` | Send a test event |

Creating a webhook:

```
POST /api/v1/projects/proj-1/webhooks
{
  "url": "https://my-service.example.com/hooks/reearth",
  "events": ["asset.version.created", "asset.dirty"],
  "description": "Trigger tile regeneration"
}
→ 201 {
  "id": "wh-abc",
  "url": "https://my-service.example.com/hooks/reearth",
  "secret": "whsec_a1b2c3...",    // generated, shown only on creation
  "events": ["asset.version.created", "asset.dirty"],
  "enabled": true,
  ...
}
```

The `secret` is returned only on creation. It can be rotated via `POST /api/v1/projects/:pid/webhooks/:id/rotate-secret`.

### 4. Webhook Delivery

#### Payload Format

```json
{
  "id": "evt_01HXYZ...",
  "type": "asset.version.created",
  "timestamp": 1710100000000,
  "projectId": "proj-1",
  "data": {
    "assetId": "asset-abc",
    "version": { "id": "ver-xyz", "version": 3, "filename": "data.fgb", "status": "ready" }
  },
  "actor": { "type": "user", "id": "user-123" }
}
```

#### Signing (HMAC-SHA256)

Every webhook request is signed to allow receivers to verify authenticity. Follows the Stripe model:

```
X-Reearth-Signature: t=1710100000,v1=sha256hex...
```

The signature is computed as:
```
HMAC-SHA256(secret, "${timestamp}.${rawBody}")
```

Receivers should:
1. Extract timestamp and signature from the header
2. Compute expected signature using their secret
3. Compare using constant-time comparison
4. Reject if timestamp is too old (recommended: 5-minute tolerance)

#### Delivery Guarantees

- **At-least-once delivery** — events may be delivered more than once. Receivers must be idempotent (use `event.id` for deduplication).
- **Ordering** — not guaranteed across events. Events within a single webhook delivery batch are ordered by timestamp, but concurrent deliveries may arrive out of order.
- **Timeout** — 10-second response timeout. Non-2xx responses are treated as failures.

#### Retry Policy

Failed deliveries are retried with exponential backoff:

| Attempt | Delay |
|---------|-------|
| 1 | Immediate |
| 2 | 1 minute |
| 3 | 5 minutes |
| 4 | 30 minutes |
| 5 | 2 hours |

After 5 failed attempts, the event is moved to the dead letter queue. If a webhook endpoint accumulates failures (e.g., 50 consecutive failures over 24 hours), the endpoint is automatically **disabled** and the project owner is notified (if notification channel is configured).

#### Delivery Log

Each delivery attempt is recorded:

```sql
CREATE TABLE webhook_deliveries (
  id            TEXT PRIMARY KEY,
  webhook_id    TEXT NOT NULL,
  event_id      TEXT NOT NULL,
  attempt       INTEGER NOT NULL,
  status        TEXT NOT NULL,       -- "success" | "failed" | "pending"
  http_status   INTEGER,
  response_body TEXT,                -- first 1KB of response (for debugging)
  duration_ms   INTEGER,
  created_at    INTEGER NOT NULL,
  error         TEXT,                -- error message on failure
  meta          TEXT
);
CREATE INDEX idx_deliveries_webhook ON webhook_deliveries(webhook_id, created_at);
CREATE INDEX idx_deliveries_event ON webhook_deliveries(event_id);
CREATE INDEX idx_deliveries_status ON webhook_deliveries(status) WHERE status = 'failed';
```

Delivery logs are queryable via API:

```
GET /api/v1/projects/:pid/webhooks/:id/deliveries
  ?status=failed
  ?limit=50
```

### 5. System Event Queue (Internal Pub/Sub)

In addition to user-facing webhooks, serve supports **system-level event publishing** via Cloudflare Queues. This provides a low-latency, reliable pub/sub channel for system-to-system integration (e.g., serve → untiled) without the overhead of HTTP webhook round-trips.

#### Design

System queues are configured via **environment variable bindings** in `wrangler.toml`. Serve publishes events to all bound system queues in addition to the webhook pipeline. The consumer (e.g., untiled) runs its own Worker that processes messages from the queue.

```toml
# wrangler.toml — serve side (producer)
[[queues.producers]]
queue = "reearth-serve-events"
binding = "EVENT_QUEUE"           # env var name in Worker code

# Optional: multiple system queues for different consumers
[[queues.producers]]
queue = "reearth-serve-events-analytics"
binding = "EVENT_QUEUE_ANALYTICS"
```

```toml
# wrangler.toml — untiled side (consumer)
[[queues.consumers]]
queue = "reearth-serve-events"
max_batch_size = 20
max_batch_timeout = 5
max_retries = 5
dead_letter_queue = "reearth-serve-events-dlq"
```

#### Event Flow

```
Event occurs
  ↓
Event written to D1 (events table)
  ↓
  ├── System queues: send to all bound EVENT_QUEUE_* bindings
  │     → Direct Cloudflare Queue message (no HTTP, no signing overhead)
  │     → Consumer (untiled) processes at its own pace
  │
  └── Webhook pipeline: send to WEBHOOK_FANOUT_QUEUE
        → Fan-out → Delivery → HTTP POST to registered endpoints
```

System queues and webhooks are **independent delivery paths** for the same events. Both receive all events (or a configured subset). The key differences:

| | System Queue | Webhook |
|---|---|---|
| **Transport** | Cloudflare Queue (intra-platform) | HTTP POST (internet) |
| **Latency** | Milliseconds (same Cloudflare network) | Seconds (HTTP round-trip + retry) |
| **Consumer** | Cloudflare Worker (co-deployed) | Any HTTP server (anywhere) |
| **Auth** | Implicit (Queue binding = trust) | HMAC-SHA256 signature |
| **Configuration** | `wrangler.toml` env bindings (deploy-time) | API/CLI (runtime, per-project) |
| **Use case** | System-to-system (serve↔untiled) | User integrations (CI/CD, monitoring) |
| **Delivery log** | Not recorded in webhook_deliveries | Recorded |

#### Message Format

System queue messages carry the same event payload as webhooks, without signing:

```json
{
  "id": "evt_01HXYZ...",
  "type": "asset.version.created",
  "timestamp": 1710100000000,
  "projectId": "proj-1",
  "data": { "assetId": "asset-abc", "version": { ... } },
  "actor": { "type": "user", "id": "user-123" }
}
```

#### Event Filtering

Not all consumers need all events. Filtering can be applied at two levels:

1. **Producer-side (serve)**: A binding-level filter can be configured to only publish specific event types to a queue. This avoids sending unnecessary messages.

```typescript
// In serve's event publisher
const systemQueues: SystemQueueBinding[] = [
  { queue: env.EVENT_QUEUE, filter: ["asset.*"] },
  { queue: env.EVENT_QUEUE_ANALYTICS, filter: ["asset.version.created", "asset.deleted"] },
];
```

2. **Consumer-side**: The consumer can ignore irrelevant event types in its batch handler. Simple but wastes queue throughput if most messages are filtered out.

Producer-side filtering is preferred when the consumer only cares about a small subset of events.

#### Deployment Patterns

**Single consumer (typical)**:
- One system queue binding for serve → untiled communication.
- untiled's Worker consumes the queue.

**Multiple consumers**:
- Separate queue bindings per consumer (e.g., `EVENT_QUEUE_UNTILED`, `EVENT_QUEUE_BILLING`).
- Each consumer has its own queue, retry policy, and DLQ.
- Adding a new consumer requires adding a binding in serve's `wrangler.toml` and redeploying serve — this is acceptable for system-level integrations which change infrequently.

**No system consumers (serve-only deployment)**:
- If no `EVENT_QUEUE_*` bindings are configured, serve simply skips system queue publishing. Webhooks still work.

### 6. Cloudflare Architecture for Webhook Delivery

#### Pipeline Overview

```
Event occurs (upload, status change, dirty propagation, etc.)
  ↓
Event written to D1 (events table)
  ↓
  ├── System queues (Section 5): EVENT_QUEUE_* bindings
  │
  └── Message sent to WEBHOOK_FANOUT_QUEUE
        { eventId, projectId }
        ↓
      Fan-out Consumer (Worker)
        → Query webhook_endpoints for matching subscriptions
        → For each matching endpoint, send message to WEBHOOK_DELIVERY_QUEUE
          { eventId, webhookId, attempt: 1 }
        ↓
      Delivery Consumer (Worker, auto-scaling concurrency)
        → Read event from D1
        → Sign payload with endpoint secret
        → POST to endpoint URL (10s timeout)
        → Record result in webhook_deliveries
        → On failure: msg.retry() with delay (exponential backoff)
        ↓
      Dead Letter Queue (WEBHOOK_DLQ)
        → Failed after max_retries
        → Separate consumer logs to webhook_deliveries with status "dead"
```

#### Queue Configuration

```toml
# Fan-out: one event → multiple webhook deliveries
[[queues.producers]]
queue = "reearth-serve-webhook-fanout"

[[queues.consumers]]
queue = "reearth-serve-webhook-fanout"
max_batch_size = 50
max_batch_timeout = 5
max_retries = 3
dead_letter_queue = "reearth-serve-webhook-fanout-dlq"

# Delivery: one message per webhook endpoint
[[queues.producers]]
queue = "reearth-serve-webhook-delivery"

[[queues.consumers]]
queue = "reearth-serve-webhook-delivery"
max_batch_size = 10
max_batch_timeout = 2
max_retries = 5
dead_letter_queue = "reearth-serve-webhook-dlq"
# max_concurrency left unset for auto-scaling
```

#### Why Two Queues?

Separating fan-out from delivery provides:

- **Independent retry** — if one endpoint is down, retries for that endpoint don't block other endpoints or other events.
- **Independent scaling** — delivery workers auto-scale based on backlog. A burst of 100 dirty events × 5 subscribers = 500 delivery messages, handled by auto-scaling consumers.
- **Isolated failure** — a slow/failing endpoint accumulates retries in the delivery queue without affecting the fan-out queue.

#### Burst Handling

When dirty propagation marks 100 assets dirty at once:

1. Each dirty mark produces an `asset.dirty` event → 100 messages enter the fan-out queue.
2. Fan-out consumer batches 50 at a time, queries matching webhooks, and produces delivery messages.
3. Delivery consumer auto-scales concurrency (up to 250) to drain the backlog.
4. Backpressure is natural — if downstream endpoints are slow, messages accumulate in the queue rather than overwhelming endpoints.

### 7. Developer Tooling (CLI)

Inspired by Stripe CLI's webhook testing features.

#### Webhook Management

```bash
# Create a webhook
<cli> webhook create --project my-project \
  --url https://my-service.example.com/hooks \
  --events "asset.version.created,asset.dirty"

# List webhooks
<cli> webhook list --project my-project

# Update a webhook
<cli> webhook update wh-abc --events "asset.*"

# Delete a webhook
<cli> webhook delete wh-abc

# Rotate secret
<cli> webhook rotate-secret wh-abc

# Disable/enable
<cli> webhook disable wh-abc
<cli> webhook enable wh-abc
```

#### Local Forwarding (`listen`)

Forward webhook events to a local development server. Inspired by `stripe listen`.

```bash
# Forward all events to local endpoint
<cli> webhook listen --project my-project \
  --forward-to http://localhost:3000/webhook

# Filter to specific events
<cli> webhook listen --project my-project \
  --forward-to http://localhost:3000/webhook \
  --events "asset.version.created,asset.dirty"
```

Output:

```
Ready! Forwarding events to http://localhost:3000/webhook
Signing secret: whsec_test_a1b2c3...  (use this for local signature verification)

2026-03-25 14:30:01  asset.version.created  [evt_01HX...]  → 200 OK (45ms)
2026-03-25 14:30:02  asset.dirty            [evt_01HY...]  → 200 OK (12ms)
2026-03-25 14:30:05  asset.version.created  [evt_01HZ...]  → 500 ERR (102ms)
```

**Implementation**: The CLI opens a WebSocket connection to serve (or polls `/events` with a cursor). Events matching the filter are forwarded to the local endpoint via HTTP. A temporary signing secret is generated for the session.

#### Trigger Test Events (`trigger`)

Send synthetic test events to registered webhooks or the local listener.

```bash
# Trigger a test event (sent to all matching webhooks)
<cli> webhook trigger --project my-project asset.version.created

# Trigger with custom data
<cli> webhook trigger --project my-project asset.version.created \
  --data '{"assetId":"test-asset","version":{"id":"test-ver","version":1}}'

# Trigger to local listener only (no registered webhooks)
<cli> webhook trigger --project my-project asset.dirty --local-only
```

#### Replay Events

Re-deliver a past event to a webhook endpoint.

```bash
# Replay a specific event
<cli> webhook replay evt_01HX... --to wh-abc

# Replay all failed deliveries for a webhook
<cli> webhook replay --failed --to wh-abc
```

#### Delivery Log Inspection

```bash
# View recent deliveries for a webhook
<cli> webhook deliveries wh-abc

# Filter by status
<cli> webhook deliveries wh-abc --status failed

# View event log
<cli> event list --project my-project --type "asset.version.*" --limit 20
```

### 8. Event Replay API

For programmatic replay (useful for recovery and debugging):

| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/api/v1/projects/:pid/webhooks/:id/replay` | Replay events to a webhook |

```
POST /api/v1/projects/proj-1/webhooks/wh-abc/replay
{
  "eventIds": ["evt_01HX...", "evt_01HY..."]
}
→ 200 { "replayed": 2, "deliveries": [...] }
```

```
POST /api/v1/projects/proj-1/webhooks/wh-abc/replay
{
  "filter": { "status": "failed", "after": "2026-03-24T00:00:00Z" }
}
→ 200 { "replayed": 5, "deliveries": [...] }
```

### 9. Responsibility Boundary

| Concern | Re:Earth Serve |
|---------|---------------|
| Event production | Emits events on every state change |
| Event persistence | Stores in D1 with 30-day retention, archived to R2/Parquet |
| System queue publishing | Publishes to all bound `EVENT_QUEUE_*` Cloudflare Queues |
| Webhook registration | CRUD per project |
| Webhook delivery | Queue-based, at-least-once, signed |
| Delivery logging | Records every webhook delivery attempt |
| Local forwarding | CLI `listen` command |
| Test events | CLI `trigger` + API `test` endpoint |
| Event replay | CLI `replay` + API |

External systems integrate via two channels:
- **System queues** (Cloudflare Queue bindings) — for co-deployed systems like untiled. Low-latency, deploy-time configuration.
- **Webhooks** (HTTP POST) — for user-registered endpoints. Runtime configuration, works with any HTTP server.

## Alternatives Considered

### Use Webhooks for System Integration (No System Queue)

Have untiled register a webhook like any other consumer, instead of a dedicated queue channel.

Rejected because:
- HTTP round-trips add latency (seconds) compared to intra-platform queue delivery (milliseconds).
- Webhook delivery requires signing, delivery logging, and retry — unnecessary overhead for trusted system-to-system communication within the same Cloudflare account.
- Queue bindings provide implicit trust (only Workers in the same account can bind to a queue), eliminating the need for authentication.
- Queues provide natural backpressure and batching. Webhooks require the receiver to handle rate limiting itself.

### Single System Queue with Topic-Based Routing

Use one shared queue for all system consumers, with consumers filtering by event type.

Not adopted as the default because:
- A slow consumer blocks all consumers on the same queue (messages pile up behind the slow batch).
- DLQ configuration is per-queue — different consumers may need different retry/failure policies.
- Separate queues per consumer provide isolation at the cost of an extra binding in `wrangler.toml`, which is acceptable for the small number of system consumers expected.

However, a single shared queue is fine for simple deployments with one consumer. The architecture supports both patterns.

### Server-Sent Events (SSE) Instead of Webhooks

Push events via persistent SSE connections instead of HTTP POST callbacks.

Rejected because:
- SSE requires clients to maintain a persistent connection, which is fragile for server-to-server integration.
- Not suitable for Cloudflare Workers (no long-lived connections from worker to external server).
- Webhooks are the industry standard for server-to-server event notification.
- The CLI `listen` command provides a real-time streaming experience for development, covering the SSE use case.

### Cloudflare Durable Objects for Delivery State

Use a Durable Object per webhook endpoint to manage delivery state and retry scheduling via `alarm()`.

Deferred because:
- Queues with auto-scaling consumers and DLQ provide sufficient reliability.
- Durable Objects add cost and complexity (per-object billing, storage management).
- If delivery reliability requirements increase (e.g., guaranteed ordering per endpoint), Durable Objects can be layered in as the delivery backend.

### Cloudflare Workflows for Delivery

Use Cloudflare Workflows (durable execution engine) for webhook delivery with built-in retry and state persistence.

Deferred because:
- Workflows are a newer Cloudflare primitive — less battle-tested than Queues.
- Workflows are better suited for multi-step long-running processes. Webhook delivery is a simpler send-and-retry pattern that Queues handle well.
- Worth revisiting if delivery logic becomes more complex (e.g., conditional retry based on response body, chained deliveries).

### Event Storage in KV Instead of D1

Store events in KV with TTL for automatic expiration.

Rejected because:
- Events need to be queried by type, asset, time range — KV does not support indexed queries.
- D1 provides SQL filtering, pagination, and aggregation for the event log API.
- Event retention cleanup is a simple `DELETE WHERE timestamp < ?` in D1.

### Keep All Events in D1 Indefinitely

Skip cold archival; rely on D1 for the full event history.

Rejected because:
- D1 is SQLite-based with row/storage limits. Months of event data across many projects will degrade write performance (index maintenance) and increase storage costs.
- Historical event queries (analytics, compliance audits) are read-heavy and analytical in nature — columnar Parquet is far more efficient than row-oriented SQLite for these patterns.
- R2 storage is effectively free (no egress cost), making the hot/cold split a clear cost optimization.

### Archive to NDJSON Instead of Parquet

Export archived events as newline-delimited JSON files.

Rejected because:
- NDJSON is easy to produce but inefficient to query — reading a month of events requires scanning the entire file.
- Parquet's columnar compression typically achieves 5–10× smaller file sizes for structured event data.
- Parquet is directly queryable by DuckDB, BigQuery, Athena, etc. — NDJSON requires conversion first.
- The overhead of producing Parquet (via parquet-wasm or a Container) is minimal compared to the long-term query and storage benefits.

### No Event Log (Webhooks Only)

Skip persistent event storage; only deliver via webhooks.

Rejected because:
- Auditability requires a durable record independent of webhook delivery success.
- Event replay (re-deliver past events) requires stored events.
- Debugging webhook issues requires comparing "what happened" (event log) with "what was delivered" (delivery log).

## Consequences

- **Auditability**: Every state change is durably recorded in the event log with actor attribution — meets government/municipal accountability requirements.
- **Reactivity**: External systems receive near-real-time notifications instead of polling.
- **Scalability**: Two-queue architecture (fan-out + delivery) handles bursty events (e.g., dirty propagation across 100 assets) with auto-scaling consumers.
- **Developer experience**: Stripe CLI-inspired tooling (`listen`, `trigger`, `replay`) makes webhook integration fast to develop and debug.
- **Reliability**: At-least-once delivery with exponential backoff, DLQ for persistent failures, and automatic endpoint disabling prevent runaway retries.
- **Storage cost**: D1 holds only 30 days of events (hot tier). Older events are archived as Parquet to R2 (cold tier, zero egress cost), keeping D1 lean while preserving full history for audits and analytics.
- **Latency**: The queue-based pipeline adds latency (seconds) compared to synchronous webhook dispatch, but provides reliability and backpressure.

## Open Questions

- WebSocket-based `listen` vs. long-polling — depends on Cloudflare Durable Objects availability for WebSocket relay.
- Event batching — should high-frequency events (e.g., extraction progress) be batched/debounced before webhook delivery?
- Per-project event retention configuration and billing model.
- IP allowlisting for webhook delivery (some enterprise receivers require known source IPs).
