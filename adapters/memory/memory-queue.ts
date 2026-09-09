import type { JobQueue, QueueMessage } from "../../core/queue/port";

type Entry<T> = {
  body: T;
  attempts: number;
  /** Milliseconds on the queue's clock before which the message is invisible. */
  availableAt: number;
};

export type SentRecord<T> = { body: T; delaySeconds: number };

/**
 * Array-backed `JobQueue` for tests and (later) the in-process Node runtime.
 *
 * It is a real little queue, not a spy: delayed sends stay invisible until the
 * clock passes them, `retry` puts the message back with its attempt count
 * incremented, and a message that exhausts `maxAttempts` lands in `dead`
 * instead of looping forever. The clock is injectable so backoff can be
 * asserted without waiting.
 */
export class MemoryJobQueue<T> implements JobQueue<T> {
  /** Every send in order, including ones still invisible. */
  readonly sent: SentRecord<T>[] = [];
  /** Messages that ran out of attempts (Cloudflare would DLQ these). */
  readonly dead: T[] = [];

  private readonly pending: Entry<T>[] = [];
  private readonly maxAttempts: number;
  private readonly now: () => number;

  constructor(options: { maxAttempts?: number; now?: () => number } = {}) {
    this.maxAttempts = options.maxAttempts ?? 5;
    this.now = options.now ?? (() => Date.now());
  }

  async send(message: T, options?: { delaySeconds?: number }): Promise<void> {
    const delaySeconds = options?.delaySeconds ?? 0;
    this.sent.push({ body: message, delaySeconds });
    this.pending.push({
      body: message,
      attempts: 0,
      availableAt: this.now() + delaySeconds * 1000,
    });
  }

  /** Bodies of every message ever sent, in send order. */
  get bodies(): T[] {
    return this.sent.map((record) => record.body);
  }

  /** Messages still queued, visible or not. */
  get size(): number {
    return this.pending.length;
  }

  /**
   * Take every currently visible message off the queue as a consumer-side
   * batch. Nothing is redelivered until `retry` is called on it.
   */
  receive(): QueueMessage<T>[] {
    const now = this.now();
    const due: Entry<T>[] = [];
    for (let i = this.pending.length - 1; i >= 0; i--) {
      if (this.pending[i].availableAt <= now) due.unshift(...this.pending.splice(i, 1));
    }
    return due.map((entry) => this.toMessage(entry));
  }

  private toMessage(entry: Entry<T>): QueueMessage<T> {
    const attempts = entry.attempts + 1;
    let settled = false;
    const settle = () => {
      if (settled) throw new Error("queue message settled twice");
      settled = true;
    };
    return {
      body: entry.body,
      attempts,
      ack: () => {
        settle();
      },
      retry: (options?: { delaySeconds?: number }) => {
        settle();
        if (attempts >= this.maxAttempts) {
          this.dead.push(entry.body);
          return;
        }
        this.pending.push({
          body: entry.body,
          attempts,
          availableAt: this.now() + (options?.delaySeconds ?? 0) * 1000,
        });
      },
    };
  }
}
