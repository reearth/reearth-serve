import { R2FileStorage } from "../infra/storage";
import { D1MetadataStore, D1JobStore, D1VersionStore, D1CleanupPendingStore } from "../infra/d1";
import { cleanupExpiredAssets, drainPendingCleanups, SubrequestBudget } from "./usecase";
import type { Job } from "../job/model";

const DEFAULT_STUCK_THRESHOLD_MS = 24 * 60 * 60 * 1000; // 24 hours
const MAX_RETRIES = 5;
// Cap per-tick re-enqueue work so a backlog of failed jobs cannot blow the
// Workers subrequest budget and break the recovery loop itself.
const MAX_RETRIABLE_PER_TICK = 50;

// Subrequest budget split between cleanup and retrigger phases. Workers
// scheduled invocations cap around 1000 subrequests per run; we partition
// ~70% to cleanup (the R2 list+deleteMany cycles scale with archive size)
// and leave enough for the retrigger path (listRetriable + up to
// MAX_RETRIABLE_PER_TICK jobs × ~4 ops each).
const CLEANUP_BUDGET = 700;

export async function handleScheduled(env: Env): Promise<void> {
  const metadata = new D1MetadataStore(env.DB);
  const storage = new R2FileStorage(env.STORAGE);
  const jobs = new D1JobStore(env.DB);
  const versions = new D1VersionStore(env.DB);
  const pending = new D1CleanupPendingStore(env.DB);

  // Share one budget across both cleanup paths — we don't want drainPending
  // to steal so much budget that expired assets never get processed.
  const budget = new SubrequestBudget(CLEANUP_BUDGET);

  const result = await cleanupExpiredAssets(metadata, storage, jobs, {
    maxAssets: 100,
    versions,
    budget,
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

  // Self-heal: the internal status callback writes the job row and the
  // asset row separately. If the asset write fails after the job commits,
  // the asset is stuck at "extracting" even though the job is "completed".
  // The retrigger path only chases pending/failed jobs, so without this
  // step the drift never resolves on its own.
  await reconcileStuckAssets(metadata, jobs);

  // Re-trigger pending/failed/stuck extraction jobs via queue
  if (env.EXTRACTION_QUEUE) {
    const stuckThresholdMs = parseInt(env.EXTRACTION_STUCK_THRESHOLD_SECONDS || "", 10) * 1000 || DEFAULT_STUCK_THRESHOLD_MS;
    await retriggerPendingJobs(metadata, jobs, env.EXTRACTION_QUEUE, stuckThresholdMs);
  }
}

async function reconcileStuckAssets(metadata: D1MetadataStore, jobs: D1JobStore): Promise<void> {
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

async function retriggerPendingJobs(
  metadata: D1MetadataStore,
  jobs: D1JobStore,
  queue: Queue,
  stuckThresholdMs: number,
): Promise<void> {
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
      await jobs.save(updatedJob);

      const asset = await metadata.find(job.assetId);
      if (asset) {
        asset.status = "failed";
        await metadata.save(asset, Math.max(0, Math.floor((asset.expiresAt - Date.now()) / 1000)));
      }
      console.log(`Marked asset ${job.assetId} as permanently failed: max retries exceeded`);
      continue;
    }

    const asset = await metadata.find(job.assetId);
    if (!asset || !asset.archiveFormat) continue;

    // Send to queue FIRST. If it fails, the job stays pending with the same
    // retry_count and the next cron tick will try again — without burning a
    // retry on a transient queue/network failure.
    try {
      await queue.send({
        assetId: job.assetId,
        archiveKey: `assets/${job.assetId}/${asset.filename}`,
        archiveFilename: asset.filename,
        archiveFormat: asset.archiveFormat,
      });
    } catch (e) {
      console.error(`Failed to enqueue extraction for asset ${job.assetId} (retry budget preserved):`, e);
      continue;
    }

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
      console.error(`Failed to persist retry count for asset ${job.assetId} (job already enqueued):`, e);
      continue;
    }
    console.log(`Re-enqueued extraction for asset ${job.assetId} (retry ${updatedJob.retryCount}/${MAX_RETRIES})`);
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
