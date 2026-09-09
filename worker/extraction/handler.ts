import { retryDelaySeconds } from "./backoff";
import type { ArchiveFormat } from "../asset/model";
import type { Deps } from "../types";

export interface ExtractionMessage {
  assetId: string;
  archiveKey: string;
  archiveFilename: string;
  archiveFormat: ArchiveFormat;
}

export async function handleQueue(
  batch: MessageBatch<ExtractionMessage>,
  deps: Deps,
): Promise<void> {
  if (!deps.containers.archiveExtractorAvailable) {
    // No container config — a deploy-time problem, not a transient one.
    // Spread retries out so the batch doesn't burn its budget while broken.
    console.error("Cannot launch extractor: container configuration is incomplete");
    batch.retryAll({ delaySeconds: 300 });
    return;
  }

  for (const message of batch.messages) {
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
