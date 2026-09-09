/**
 * Provider-independent job queue port (ADR-012 §4).
 *
 * The producer side is a single `send`; the consumer side is a flat list of
 * messages, each acknowledged or retried on its own. Cloudflare Queues is one
 * adapter (`adapters/cloudflare/queues.ts`); a SQL-backed outbox drained by the cron is the
 * off-Cloudflare one. Nothing above this file knows which is in use.
 */

/** Producer side: hand a message to the queue. */
export interface JobQueue<T> {
  /**
   * Enqueue one message.
   *
   * @param options.delaySeconds Hold the message invisible for this long
   * before it is delivered. Adapters that cannot delay deliver immediately.
   */
  send(message: T, options?: { delaySeconds?: number }): Promise<void>;
}

/**
 * Consumer side: one delivery attempt of one message.
 *
 * `ack` and `retry` are deliberately synchronous and fire-and-forget — that is
 * Cloudflare's shape, and an adapter that needs I/O to record the decision can
 * buffer it and flush after the handler returns.
 */
export interface QueueMessage<T> {
  readonly body: T;
  /** 1 on the first delivery, incremented on every redelivery. */
  readonly attempts: number;
  /** Mark handled: the message is not delivered again. */
  ack(): void;
  /** Give the message back to the queue, optionally after a delay. */
  retry(options?: { delaySeconds?: number }): void;
}
