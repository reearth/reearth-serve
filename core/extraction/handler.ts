import { retryDelaySeconds } from "./backoff";
import type { ArchiveFormat } from "../asset/model";
import type { MetadataStore, VersionStore } from "../asset/repository";
import { originalKey } from "../blob/model";
import type { Job } from "../job/model";
import type { Deps } from "../types";
import type { QueueMessage } from "../queue/port";
import { touchPendingJob } from "../job/usecase";
import { handleVerificationQueue, isVerificationMessage, type VerificationMessage } from "../integrity/verification";

/** One extraction run, addressed by job (ADR-005, amendment 2026-11-05). */
export interface ExtractionMessage {
  /** An asset's own job has `jobId == assetId`; a version's job has its own ID. */
  jobId: string;
  assetId: string;
  /** Set for a version's job: the run reads and writes under the version's prefix. */
  versionId?: string;
  /**
   * Storage key of the archive to read — `originalKey` of the row, which may
   * be a blob outside the asset's prefix (ADR-017 §3). The extractor reads it
   * as given and writes under its own prefix (`keyRoot`), derived from the IDs.
   */
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
      archiveKey: originalKey(version),
      archiveFilename: version.filename,
      archiveFormat: version.archiveFormat,
    };
  }
  const asset = await metadata.find(job.assetId);
  if (!asset?.archiveFormat) return null;
  return {
    jobId: job.id,
    assetId: job.assetId,
    archiveKey: originalKey(asset),
    archiveFilename: asset.filename,
    archiveFormat: asset.archiveFormat,
  };
}

// Delay applied to every message when the extractor cannot be launched at all.
const MISCONFIGURED_RETRY_DELAY_SECONDS = 300;

/**
 * Consumer of the extraction queue. The queue also carries hash verification
 * runs (ADR-017 §2), which use the same container image and launcher; they are
 * split off first so a deployment without the extractor does not hold them back.
 */
export async function handleQueue(
  messages: QueueMessage<ExtractionMessage | VerificationMessage>[],
  deps: Deps,
): Promise<void> {
  const verification: QueueMessage<VerificationMessage>[] = [];
  const extraction: QueueMessage<ExtractionMessage>[] = [];
  for (const m of messages) {
    if (isVerificationMessage(m.body)) verification.push(m as QueueMessage<VerificationMessage>);
    else extraction.push(m as QueueMessage<ExtractionMessage>);
  }
  if (verification.length > 0) await handleVerificationQueue(verification, deps);
  if (extraction.length > 0) await handleExtractionMessages(extraction, deps);
}

async function handleExtractionMessages(
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
      await touchPendingJob(deps.jobs, params.jobId);
      message.retry({ delaySeconds: retryDelaySeconds(message.attempts) });
    }
  }
}
