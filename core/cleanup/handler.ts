import { cleanupExpiredAssets, drainPendingCleanups, SubrequestBudget } from "./usecase";
import { sweepBlobs } from "../blob/usecase";
import { purgeReleasedSiteHosts, releaseOutstandingCertificates } from "../site/usecase";
import { JOB_MAX_RETRIES, jobFailureClass, type Job } from "../job/model";
import type { JobStore } from "../job/repository";
import type { AtomicWrites, MetadataStore, VersionStore } from "../asset/repository";
import type { Deps } from "../types";
import { extractionMessageForJob, type ExtractionMessage } from "../extraction/handler";
import {
  closedAsFailed, VERIFICATION_JOB_TYPE, verificationMessageForJob, type VerificationMessage,
} from "../integrity/verification";
import {
  BACKFILL_JOB_TYPE, backfillMessageForJob, enqueueIntegrityBackfill, type BackfillMessage,
} from "../integrity/backfill";
import type { JobQueue } from "../queue/port";

const MAX_RETRIES = JOB_MAX_RETRIES;
// Cap per-tick re-enqueue work so a backlog of failed jobs cannot blow the
// Workers subrequest budget and break the recovery loop itself.
const MAX_RETRIABLE_PER_TICK = 50;

export async function handleScheduled(deps: Deps): Promise<void> {
  const { metadata, storage, jobs, versions, pendingCleanup: pending } = deps;

  // Share one budget across both cleanup paths — we don't want drainPending
  // to steal so much budget that expired assets never get processed. How much
  // there is to spend is a provider limit, so it comes from `deps.limits`
  // (Cloudflare: ~70% of the ~1000-subrequest scheduled cap, leaving room for
  // the retrigger path below).
  const budget = new SubrequestBudget(deps.limits.subrequestBudget);

  const result = await cleanupExpiredAssets(metadata, storage, jobs, {
    maxAssets: 100,
    versions,
    budget,
    writes: deps.writes,
  });

  if (result.deletedAssets.length > 0 || result.budgetExhausted) {
    const suffix = result.budgetExhausted ? " (budget exhausted — resuming next tick)" : "";
    console.log(
      `Cleanup: deleted ${result.deletedAssets.length} expired assets, ${result.deletedJobs.length} jobs${suffix}`,
    );
  }

  // Drain R2 prefixes that earlier DELETE requests couldn't finish inline.
  const drainResult = await drainPendingCleanups(storage, pending, budget);
  if (drainResult.drainedPrefixes.length > 0 || drainResult.budgetExhausted) {
    const suffix = drainResult.budgetExhausted ? " (budget exhausted — resuming next tick)" : "";
    console.log(`Cleanup: drained ${drainResult.drainedPrefixes.length} pending prefixes${suffix}`);
  }

  // The blob layer (ADR-017 §5): expired upload claims, blobs past their
  // grace period with no reference, and one page of orphan reconciliation.
  // After the prefix drain, on whatever budget is left.
  const blobs = await sweepBlobs({ blobRefs: deps.blobRefs, storage, cache: deps.cache }, budget);
  if (blobs.droppedClaims + blobs.swept.length + blobs.orphans.length > 0 || blobs.budgetExhausted) {
    const suffix = blobs.budgetExhausted ? " (budget exhausted — resuming next tick)" : "";
    console.log(
      `Cleanup: blobs — ${blobs.droppedClaims} expired claims dropped, ${blobs.swept.length} unreferenced and ${blobs.orphans.length} orphaned objects deleted${suffix}`,
    );
  }

  // SHA-256 backfill of rows stored before ADR-017 (P4). Lowest priority of
  // the budgeted steps, so it gets what the cleanup and the blob sweeps left.
  // A few jobs at a time: each run is a whole-object read in the extractor
  // container, competing with extraction and verification for instances.
  const backfill = await enqueueIntegrityBackfill(deps, budget, deps.backfillSettings);
  if (backfill.enqueued.length > 0 || backfill.budgetExhausted) {
    const suffix = backfill.budgetExhausted ? " (budget exhausted — resuming next tick)" : "";
    console.log(`Cleanup: integrity backfill — ${backfill.enqueued.length} jobs enqueued${suffix}`);
  }

  // Released site names whose 30-day cooldown has run out (ADR-013 B3). One
  // indexed DELETE; the name becomes claimable again only here, which is what
  // makes the cooldown a real window rather than a suggestion.
  const siteHostDeps = {
    hosts: deps.siteHosts, cache: deps.cache, suffix: deps.siteHostSuffix, provisioner: deps.customHostnames,
  };
  // Certificates of released custom domains that a release could not give up
  // (provider error, or the process died right after the delete committed).
  // Before the purge, so a row is retried for its whole cooldown.
  const certificates = await releaseOutstandingCertificates(siteHostDeps);
  if (certificates.length > 0) {
    console.log(`Cleanup: released ${certificates.length} outstanding custom-domain certificates`);
  }
  const purged = await purgeReleasedSiteHosts(siteHostDeps);
  if (purged.length > 0) {
    console.log(`Cleanup: purged ${purged.length} released site hosts past their cooldown`);
  }

  // Self-heal: the job row and the asset row are written together now, but
  // rows written before that (or by a partially-applied older release) can
  // still be stuck at "extracting" while the job says "completed". The
  // retrigger path only chases pending/failed jobs, so without this step the
  // drift never resolves on its own.
  await reconcileStuckAssets(metadata, jobs);

  // Re-trigger pending/failed/stuck extraction and verification jobs via queue
  if (deps.extractionQueue) {
    await retriggerPendingJobs(metadata, versions, jobs, deps.writes, {
      extraction: deps.extractionQueue,
      verification: deps.verificationQueue,
      backfill: deps.backfillQueue,
    }, deps.extractionStuckThresholdMs);
  }
}

async function reconcileStuckAssets(metadata: MetadataStore, jobs: JobStore): Promise<void> {
  if (!jobs.listStuckAssets) return;
  const stuck = await jobs.listStuckAssets(20);
  if (stuck.length === 0) return;

  for (const job of stuck) {
    const asset = await metadata.find(job.assetId);
    if (!asset) continue;
    // Re-check the drift — the asset might have been healed by another
    // tick, or its status might have moved for unrelated reasons.
    if (asset.status !== "extracting" && asset.status !== "pending") continue;

    asset.status = "ready";
    if (job.fileCount !== undefined) asset.fileCount = job.fileCount;
    if (job.extractedSize !== undefined) asset.extractedSize = job.extractedSize;

    const ttlSeconds = asset.expiresAt > 0
      ? Math.max(0, Math.floor((asset.expiresAt - Date.now()) / 1000))
      : 0;
    await metadata.save(asset, ttlSeconds);
    console.log(`Reconciled stuck asset ${asset.id}: status=extracting → ready (job ${job.id} already completed)`);
  }
}

// effectiveRetryCount returns the retry budget already consumed by a stuck
// job. With lossless checkpoint resume, retry_count measures container
// deaths, not wasted work — and long extractions die for reasons unrelated
// to the job (deploy rollouts, infra blips). A death *after* measurable
// progress is not the same failure repeating, so the budget resets; only
// "died at the same point" repetitions accumulate toward MAX_RETRIES.
// Jobs whose markers never move (e.g. a single multi-GB entry) keep the
// plain cumulative count, same as before.
export function effectiveRetryCount(
  job: Pick<Job, "retryCount" | "fileCount" | "extractedSize" | "retryFileCount" | "retryExtractedSize">,
): number {
  const progressed =
    (job.fileCount ?? 0) > (job.retryFileCount ?? 0) ||
    (job.extractedSize ?? 0) > (job.retryExtractedSize ?? 0);
  return progressed ? 0 : (job.retryCount ?? 0);
}

type RetryQueues = {
  extraction: JobQueue<ExtractionMessage>;
  verification: JobQueue<VerificationMessage> | null;
  backfill: JobQueue<BackfillMessage> | null;
};

async function retriggerPendingJobs(
  metadata: MetadataStore,
  versions: VersionStore,
  jobs: JobStore,
  writes: AtomicWrites,
  queues: RetryQueues,
  stuckThresholdMs: number,
): Promise<void> {
  if (!jobs.listRetriable) return;
  const retriableJobs = await jobs.listRetriable(stuckThresholdMs, MAX_RETRIES, MAX_RETRIABLE_PER_TICK);

  for (const job of retriableJobs) {
    const retryCount = effectiveRetryCount(job);

    // Mark as permanently failed if max retries exceeded. Storing
    // MAX_RETRIES + 1 takes the job out of listRetriable's pool for good
    // (plain `failed` jobs with budget left are retriable by design).
    if (retryCount >= MAX_RETRIES) {
      const updatedJob: Job = {
        ...job,
        status: "failed",
        retryCount: MAX_RETRIES + 1,
        error: `Max retries (${MAX_RETRIES}) exceeded`,
        updatedAt: Date.now(),
        completedAt: Date.now(),
      };
      // Job and its mirror in one atomic write (ADR-012 §3). A version's job
      // fails only that version; the asset and its other versions stay usable.
      //
      // A verification job mirrors nothing (ADR-018 §6, "rejected version"):
      // running out of retries means the object could not be read, not that
      // it is wrong, so the upload stays `pending` and servable, and the
      // asset's `status` belongs to extraction. A backfill job ("slower
      // reads") mirrors nothing either: the row stays without a hash, as it
      // was, and the closed job keeps the backfill from selecting it again.
      if (jobFailureClass(job) !== "missing-feature") {
        await jobs.save(updatedJob);
      } else if (job.versionId) {
        const version = await versions.find(job.versionId);
        if (version) version.status = "failed";
        await writes.saveJob({ job: updatedJob, version: version ?? undefined });
      } else {
        const asset = await metadata.find(job.assetId);
        if (asset) asset.status = "failed";
        await writes.saveJob({ job: updatedJob, asset: asset ?? undefined });
      }
      console.log(`Marked job ${job.id} (asset ${job.assetId}) as permanently failed: max retries exceeded`);
      continue;
    }

    const sent = await resend(job, metadata, versions, queues);
    if (sent === "nothing") {
      // The asset or version is gone (or, for verification and backfill,
      // already settled):
      // close the job instead of finding it again every tick, where it would
      // take one of the MAX_RETRIABLE_PER_TICK slots forever.
      await jobs.save(closedAsFailed(job, "nothing left to run: the asset or version is gone, or already settled", Date.now()));
      console.log(`Closed job ${job.id} (asset ${job.assetId}): nothing left to run`);
      continue;
    }
    if (sent === "unsent") continue;

    // Only after successful enqueue, persist the incremented retry count
    // (reset to zero first if the job progressed) and capture the progress
    // markers this re-enqueue happened at.
    const updatedJob: Job = {
      ...job,
      retryCount: retryCount + 1,
      retryFileCount: job.fileCount ?? 0,
      retryExtractedSize: job.extractedSize ?? 0,
      status: "pending",
      updatedAt: Date.now(),
    };
    try {
      await jobs.save(updatedJob);
    } catch (e) {
      console.error(`Failed to persist retry count for job ${job.id} (job already enqueued):`, e);
      continue;
    }
    console.log(`Re-enqueued ${job.type} for job ${job.id} (retry ${updatedJob.retryCount}/${MAX_RETRIES})`);
  }
}

/**
 * Send the message that re-runs `job`. Sent FIRST, before the retry count is
 * persisted: if it fails, the job stays as it was and the next tick tries
 * again without burning a retry on a transient queue failure.
 */
async function resend(
  job: Job,
  metadata: MetadataStore,
  versions: VersionStore,
  queues: RetryQueues,
): Promise<"sent" | "unsent" | "nothing"> {
  try {
    if (job.type === VERIFICATION_JOB_TYPE) {
      if (!queues.verification) return "unsent";
      const message = await verificationMessageForJob(job, metadata);
      if (!message) return "nothing";
      await queues.verification.send(message);
    } else if (job.type === BACKFILL_JOB_TYPE) {
      if (!queues.backfill) return "unsent";
      const message = await backfillMessageForJob(job, metadata, versions);
      if (!message) return "nothing";
      await queues.backfill.send(message);
    } else {
      const message = await extractionMessageForJob(job, metadata, versions);
      if (!message) return "nothing";
      await queues.extraction.send(message);
    }
    return "sent";
  } catch (e) {
    console.error(`Failed to enqueue ${job.type} for job ${job.id} (retry budget preserved):`, e);
    return "unsent";
  }
}

if (import.meta.vitest) {
  const { test, expect } = import.meta.vitest;

  test("effectiveRetryCount keeps the cumulative count when nothing progressed", () => {
    expect(effectiveRetryCount({ retryCount: 3 })).toBe(3);
    expect(effectiveRetryCount({ retryCount: 3, fileCount: 0, extractedSize: 0 })).toBe(3);
    expect(
      effectiveRetryCount({
        retryCount: 4,
        fileCount: 100,
        retryFileCount: 100,
        extractedSize: 5000,
        retryExtractedSize: 5000,
      }),
    ).toBe(4);
  });

  test("effectiveRetryCount resets when fileCount moved past the last re-enqueue", () => {
    expect(effectiveRetryCount({ retryCount: 4, fileCount: 101, retryFileCount: 100 })).toBe(0);
    // Legacy jobs without markers: any progress counts.
    expect(effectiveRetryCount({ retryCount: 5, fileCount: 1 })).toBe(0);
  });

  test("effectiveRetryCount resets on byte progress even when fileCount is flat", () => {
    expect(
      effectiveRetryCount({
        retryCount: 2,
        fileCount: 100,
        retryFileCount: 100,
        extractedSize: 6000,
        retryExtractedSize: 5000,
      }),
    ).toBe(0);
  });

  test("effectiveRetryCount treats missing retryCount as zero", () => {
    expect(effectiveRetryCount({})).toBe(0);
  });
}
