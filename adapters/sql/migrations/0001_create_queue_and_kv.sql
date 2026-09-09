-- Provider-independent tables for the off-Cloudflare runtimes (ADR-012 §2, §4).
--
-- These back `SqlKeyValue` and `SqlJobQueue`, which stand in for Cloudflare KV
-- and Cloudflare Queues where those do not exist. They are deliberately NOT in
-- `adapters/cloudflare/migrations/`: the Cloudflare deployment uses the real KV
-- namespace and the real Queues, so D1 must never grow these tables.
--
-- A runtime that needs them (see `runtime/node/`) applies this directory in
-- addition to `adapters/cloudflare/migrations/`, which holds the domain schema
-- every backend shares.

-- Key/value with an optional expiry. `expires_at` is epoch milliseconds; NULL
-- means "never". Reads filter expired rows out, and the cron sweeps them.
CREATE TABLE IF NOT EXISTS kv (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL,
  expires_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_kv_expires ON kv(expires_at);

-- Outbox queue. One row per undelivered message; the cron claims due rows,
-- hands them to the same consumer the Cloudflare queue handler uses, and
-- re-inserts the ones the handler retried.
CREATE TABLE IF NOT EXISTS queue_messages (
  id           TEXT PRIMARY KEY,
  queue        TEXT NOT NULL,
  body         TEXT NOT NULL,
  attempts     INTEGER NOT NULL DEFAULT 0,
  available_at INTEGER NOT NULL,
  created_at   INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_queue_messages_due ON queue_messages(queue, available_at);
