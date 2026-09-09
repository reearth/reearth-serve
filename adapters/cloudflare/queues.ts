import type { JobQueue, QueueMessage } from "../../core/queue/port";

/**
 * Cloudflare Queues adapter for the producer side of `JobQueue` (ADR-012 §4).
 */
export class CloudflareJobQueue<T> implements JobQueue<T> {
  constructor(private readonly queue: Queue<T>) {}

  async send(message: T, options?: { delaySeconds?: number }): Promise<void> {
    await this.queue.send(
      message,
      options?.delaySeconds === undefined ? undefined : { delaySeconds: options.delaySeconds },
    );
  }
}

/**
 * Consumer side: flatten a Cloudflare `MessageBatch` into port messages.
 *
 * The batch itself does not cross the boundary — `ackAll`/`retryAll` have no
 * equivalent in the port, so handlers decide per message and an adapter that
 * has a batch operation can still recognise "every message retried".
 */
export function toQueueMessages<T>(batch: MessageBatch<T>): QueueMessage<T>[] {
  return batch.messages.map((message) => ({
    body: message.body,
    attempts: message.attempts,
    ack: () => message.ack(),
    retry: (options?: { delaySeconds?: number }) => message.retry(options),
  }));
}
