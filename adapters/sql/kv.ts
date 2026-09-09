import type { KeyValue } from "../../core/kv/port";
import type { SqlClient } from "../../core/sql/port";

/**
 * `KeyValue` backed by a SQL table (ADR-012 §2).
 *
 * The stand-in for Cloudflare KV on providers that have no key-value service:
 * sessions, upload sessions and the JWKS cache all fit in one small table
 * because the port is deliberately tiny (get/put/delete + TTL).
 *
 * Expiry is enforced on read — a row past `expires_at` is invisible even
 * before it is swept — so correctness never depends on the sweep running.
 * `sweepExpired` is only there to keep the table from growing; the Node
 * runtime's cron calls it.
 *
 * Requires `adapters/sql/migrations/0001_create_queue_and_kv.sql`.
 */
export class SqlKeyValue implements KeyValue {
  private readonly now: () => number;

  constructor(private readonly db: SqlClient, options: { now?: () => number } = {}) {
    this.now = options.now ?? (() => Date.now());
  }

  async get(key: string): Promise<string | null> {
    const { rows } = await this.db.execute(
      "SELECT value FROM kv WHERE key = ? AND (expires_at IS NULL OR expires_at > ?)",
      [key, this.now()],
    );
    const row = rows[0];
    return row ? String(row.value) : null;
  }

  async put(key: string, value: string, options?: { ttlSeconds?: number }): Promise<void> {
    const ttl = options?.ttlSeconds;
    await this.db.execute(
      "INSERT INTO kv (key, value, expires_at) VALUES (?, ?, ?) " +
        "ON CONFLICT(key) DO UPDATE SET value = excluded.value, expires_at = excluded.expires_at",
      [key, value, ttl === undefined ? null : this.now() + ttl * 1000],
    );
  }

  async delete(key: string): Promise<void> {
    await this.db.execute("DELETE FROM kv WHERE key = ?", [key]);
  }

  /** Drop rows whose TTL has passed. Returns how many went. */
  async sweepExpired(): Promise<number> {
    const { rowsAffected } = await this.db.execute(
      "DELETE FROM kv WHERE expires_at IS NOT NULL AND expires_at <= ?",
      [this.now()],
    );
    return rowsAffected;
  }
}
