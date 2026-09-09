import type { JobQueue, QueueMessage } from "../../core/queue/port";
import type { SqlClient, SqlStatement } from "../../core/sql/port";

/**
 * `JobQueue` backed by a SQL outbox table (ADR-012 §4).
 *
 * The stand-in for Cloudflare Queues where there is no queue service: `send`
 * inserts a row, and a periodic drain (the Node runtime's cron) claims the due
 * rows and hands them to the very same consumer functions the Cloudflare queue
 * handler calls.
 *
 * Claiming is a single `DELETE ... RETURNING`, so two drains running at once
 * cannot hand the same message to both — the row is gone before the body is
 * read. That also means a process that dies mid-batch loses the messages it had
 * claimed; the cleanup cron's retrigger path is what recovers extraction jobs,
 * exactly as it does when a Cloudflare batch is lost.
 *
 * `ack`/`retry` are synchronous by port contract, so a retry is buffered and
 * written by `flush()` after the handler returns.
 *
 * Requires `adapters/sql/migrations/0001_create_queue_and_kv.sql`.
 */
export class SqlJobQueue<T> implements JobQueue<T> {
  /** Bodies that ran out of attempts (Cloudflare would DLQ these). */
  readonly dead: T[] = [];

  private readonly maxAttempts: number;
  private readonly now: () => number;
  private pending: SqlStatement[] = [];

  constructor(
    private readonly db: SqlClient,
    private readonly queue: string,
    options: { maxAttempts?: number; now?: () => number } = {},
  ) {
    this.maxAttempts = options.maxAttempts ?? 5;
    this.now = options.now ?? (() => Date.now());
  }

  async send(message: T, options?: { delaySeconds?: number }): Promise<void> {
    const now = this.now();
    await this.db.execute(...insert(this.queue, message, 0, now + (options?.delaySeconds ?? 0) * 1000, now));
  }

  /**
   * Claim up to `limit` due messages. Nothing is redelivered unless `retry` is
   * called on it and `flush()` runs.
   */
  async receive(limit = 50): Promise<QueueMessage<T>[]> {
    const { rows } = await this.db.execute(
      `DELETE FROM queue_messages WHERE id IN (
         SELECT id FROM queue_messages
         WHERE queue = ? AND available_at <= ?
         ORDER BY available_at ASC, rowid ASC
         LIMIT ?
       ) RETURNING id, body, attempts`,
      [this.queue, this.now(), limit],
    );
    return rows.map((row) => this.toMessage(JSON.parse(String(row.body)) as T, Number(row.attempts) + 1));
  }

  /** Write out the retries buffered by the messages from the last `receive`. */
  async flush(): Promise<void> {
    if (this.pending.length === 0) return;
    const statements = this.pending;
    this.pending = [];
    await this.db.batch(statements);
  }

  /** Messages still queued, visible or not. For diagnostics and tests. */
  async depth(): Promise<number> {
    const { rows } = await this.db.execute(
      "SELECT COUNT(*) AS n FROM queue_messages WHERE queue = ?",
      [this.queue],
    );
    return Number(rows[0]?.n ?? 0);
  }

  private toMessage(body: T, attempts: number): QueueMessage<T> {
    let settled = false;
    const settle = () => {
      if (settled) throw new Error("queue message settled twice");
      settled = true;
    };
    return {
      body,
      attempts,
      ack: () => {
        // The row was already removed by the claiming DELETE.
        settle();
      },
      retry: (options?: { delaySeconds?: number }) => {
        settle();
        if (attempts >= this.maxAttempts) {
          this.dead.push(body);
          return;
        }
        const now = this.now();
        const [sql, args] = insert(
          this.queue,
          body,
          attempts,
          now + (options?.delaySeconds ?? 0) * 1000,
          now,
        );
        this.pending.push({ sql, args });
      },
    };
  }
}

function insert<T>(
  queue: string,
  body: T,
  attempts: number,
  availableAt: number,
  createdAt: number,
): [string, (string | number)[]] {
  return [
    "INSERT INTO queue_messages (id, queue, body, attempts, available_at, created_at) VALUES (?, ?, ?, ?, ?, ?)",
    [crypto.randomUUID(), queue, JSON.stringify(body), attempts, availableAt, createdAt],
  ];
}
