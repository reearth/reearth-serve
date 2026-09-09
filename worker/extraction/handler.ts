import { retryDelaySeconds } from "./backoff";
import type { ArchiveFormat } from "../asset/model";
import type { Deps } from "../types";
import type { QueueMessage } from "../queue/port";

export interface ExtractionMessage {
  assetId: string;
  /**
   * Set when the archive arrived as a new version of an existing asset.
   * `uploadVersion` has always put it on the wire; now that the queue is
   * typed, the field is declared. The Cloudflare launcher ignores it today.
   */
  versionId?: string;
  archiveKey: string;
  archiveFilename: string;
  archiveFormat: ArchiveFormat;
}

// Delay applied to every message when the extractor cannot be launched at all.
const MISCONFIGURED_RETRY_DELAY_SECONDS = 300;

export async function handleQueue(
  messages: QueueMessage<ExtractionMessage>[],
  deps: Deps,
): Promise<void> {
  if (!deps.containers.archiveExtractorAvailable) {
    // No container config — a deploy-time problem, not a transient one.
    // Spread retries out so the batch doesn't burn its budget while broken.
    console.error("Cannot launch extractor: container configuration is incomplete");
    for (const message of messages) {
      message.retry({ delaySeconds: MISCONFIGURED_RETRY_DELAY_SECONDS });
    }
    return;
  }

  for (const message of messages) {
    try {
      await deps.containers.launchArchiveExtractor(message.body);
      message.ack();
    } catch (e) {
      console.error(`Failed to launch extractor for ${message.body.assetId} (attempt ${message.attempts}):`, e);
      // Refresh the job's updated_at so the cleanup cron can tell "waiting
      // for capacity, queue is on it" from "orphaned" — without this, the
      // cron re-enqueues the still-pending job every tick and each pass
      // burns one of its MAX_RETRIES. The cron only takes over once the
      // queue gives up (max_retries → DLQ) and the touches stop.
      await touchPendingJob(deps, message.body.assetId);
      message.retry({ delaySeconds: retryDelaySeconds(message.attempts) });
    }
  }
}

async function touchPendingJob(deps: Deps, assetId: string): Promise<void> {
  try {
    const job = await deps.jobs.find(assetId);
    if (job && job.status === "pending") {
      job.updatedAt = Date.now();
      await deps.jobs.save(job);
    }
  } catch (e) {
    console.error(`Failed to touch pending job ${assetId}:`, e);
  }
}
