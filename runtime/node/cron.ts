import { handleScheduled } from "../../core/cleanup/handler";
import { handleQueue } from "../../core/extraction/handler";
import type { ThumbnailMessage } from "../../core/thumbnail/queue";
import type { QueueMessage } from "../../core/queue/port";
import type { SqlJobQueue } from "../../adapters/sql/queue";
import type { NodeRuntime } from "./deps";

/** How many queued messages one tick may claim per queue. */
const BATCH_SIZE = 50;

export type CronResult = {
  extraction: number;
  thumbnail: number;
  /** Rows removed from the `kv` table because their TTL had passed. */
  kvSwept: number;
  /** Set when a consumer could not run at all on this runtime. */
  skipped?: string[];
};

/**
 * One tick of everything Cloudflare drives with a cron trigger and queue
 * consumers: the cleanup/retrigger pass, then a drain of each outbox queue
 * through the very same consumer the Worker uses, then the kv sweep.
 *
 * Called from `POST /internal/cron`; there is no in-process timer, so the
 * operator decides the cadence (systemd timer, k8s CronJob, `while sleep`).
 */
export async function runCron(runtime: NodeRuntime): Promise<CronResult> {
  const { deps, extractionQueue, thumbnailQueue, kv } = runtime;
  const skipped: string[] = [];

  await handleScheduled(deps);

  const extraction = await drain(extractionQueue, (messages) => handleQueue(messages, deps));

  let thumbnail = 0;
  const consumeThumbnails = await loadThumbnailConsumer();
  if (consumeThumbnails) {
    thumbnail = await drain(thumbnailQueue, (messages) => consumeThumbnails(messages, deps));
  } else {
    skipped.push("thumbnail");
  }

  const kvSwept = await kv.sweepExpired();

  return { extraction, thumbnail, kvSwept, ...(skipped.length > 0 && { skipped }) };
}

async function drain<T>(
  queue: SqlJobQueue<T>,
  consume: (messages: QueueMessage<T>[]) => Promise<void>,
): Promise<number> {
  const messages = await queue.receive(BATCH_SIZE);
  if (messages.length === 0) return 0;
  try {
    await consume(messages);
  } finally {
    // Retries buffered by the consumer are written even if it threw, so a
    // partially-processed batch is not silently lost.
    await queue.flush();
  }
  return messages.length;
}

type ThumbnailConsumer = (
  messages: QueueMessage<ThumbnailMessage>[],
  deps: NodeRuntime["deps"],
) => Promise<void>;

let thumbnailConsumer: ThumbnailConsumer | null | undefined;

/**
 * The thumbnail consumer is loaded lazily because it pulls in jSquash's `.wasm`
 * modules, which only a bundler (wrangler/vite) can resolve — plain Node
 * cannot import them. Rather than crash the whole runtime at startup, we find
 * out once and report thumbnails as unavailable, leaving queued messages in the
 * table for a runtime that can do the work.
 */
async function loadThumbnailConsumer(): Promise<ThumbnailConsumer | null> {
  if (thumbnailConsumer !== undefined) return thumbnailConsumer;
  try {
    const module = await import("../../core/thumbnail/handler");
    thumbnailConsumer = module.handleThumbnailQueue;
  } catch (e) {
    console.warn(
      "Thumbnail generation is unavailable on this runtime (jSquash wasm cannot be loaded):",
      e instanceof Error ? e.message : e,
    );
    thumbnailConsumer = null;
  }
  return thumbnailConsumer;
}
