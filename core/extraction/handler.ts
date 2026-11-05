import { retryDelaySeconds } from "./backoff";
import type { ArchiveFormat } from "../asset/model";
import type { MetadataStore, VersionStore } from "../asset/repository";
import { storageKey, versionStorageKey } from "../asset/usecase/shared";
import type { Job } from "../job/model";
import type { Deps } from "../types";
import type { QueueMessage } from "../queue/port";

/** One extraction run, addressed by job (ADR-005, amendment 2026-11-05). */
export interface ExtractionMessage {
  /** An asset's own job has `jobId == assetId`; a version's job has its own ID. */
  jobId: string;
  assetId: string;
  /** Set for a version's job: the run reads and writes under the version's prefix. */
  versionId?: string;
  archiveKey: string;
  archiveFilename: string;
  archiveFormat: ArchiveFormat;
}

/** The message that re-extracts `job`'s archive, or null when it has none left. */
export async function extractionMessageForJob(
  job: Job,
  metadata: MetadataStore,
  versions: VersionStore,
): Promise<ExtractionMessage | null> {
  if (job.versionId) {
    const version = await versions.find(job.versionId);
    if (!version?.archiveFormat) return null;
    return {
      jobId: job.id,
      assetId: job.assetId,
      versionId: version.id,
      archiveKey: versionStorageKey(job.assetId, version.id, version.filename),
      archiveFilename: version.filename,
      archiveFormat: version.archiveFormat,
    };
  }
  const asset = await metadata.find(job.assetId);
  if (!asset?.archiveFormat) return null;
  return {
    jobId: job.id,
    assetId: job.assetId,
    archiveKey: storageKey(job.assetId, asset.filename),
    archiveFilename: asset.filename,
    archiveFormat: asset.archiveFormat,
  };
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
    // Messages enqueued before `jobId` existed belong to the asset's own job.
    const params = { ...message.body, jobId: message.body.jobId ?? message.body.assetId };
    try {
      await deps.containers.launchArchiveExtractor(params);
      message.ack();
    } catch (e) {
      console.error(`Failed to launch extractor for job ${params.jobId} (attempt ${message.attempts}):`, e);
      // Refresh the job's updated_at so the cleanup cron can tell "waiting
      // for capacity, queue is on it" from "orphaned" — without this, the
      // cron re-enqueues the still-pending job every tick and each pass
      // burns one of its MAX_RETRIES. The cron only takes over once the
      // queue gives up (max_retries → DLQ) and the touches stop.
      await touchPendingJob(deps, params.jobId);
      message.retry({ delaySeconds: retryDelaySeconds(message.attempts) });
    }
  }
}

async function touchPendingJob(deps: Deps, jobId: string): Promise<void> {
  try {
    const job = await deps.jobs.find(jobId);
    if (job && job.status === "pending") {
      job.updatedAt = Date.now();
      await deps.jobs.save(job);
    }
  } catch (e) {
    console.error(`Failed to touch pending job ${jobId}:`, e);
  }
}
