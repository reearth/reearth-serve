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

  // Re-trigger pending/failed/stuck extraction jobs via queue
  if (env.EXTRACTION_QUEUE) {
    const stuckThresholdMs = parseInt(env.EXTRACTION_STUCK_THRESHOLD_SECONDS || "", 10) * 1000 || DEFAULT_STUCK_THRESHOLD_MS;
    await retriggerPendingJobs(metadata, jobs, env.EXTRACTION_QUEUE, stuckThresholdMs);
  }
}

async function retriggerPendingJobs(
  metadata: D1MetadataStore,
  jobs: D1JobStore,
  queue: Queue,
  stuckThresholdMs: number,
): Promise<void> {
  const retriableJobs = await jobs.listRetriable(stuckThresholdMs, MAX_RETRIES, MAX_RETRIABLE_PER_TICK);

  for (const job of retriableJobs) {
    // Mark as permanently failed if max retries exceeded
    if ((job.retryCount ?? 0) >= MAX_RETRIES) {
      if (job.status !== "failed") {
        const updatedJob: Job = {
          ...job,
          status: "failed",
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
      }
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

    // Only after successful enqueue, persist the incremented retry count.
    const updatedJob: Job = {
      ...job,
      retryCount: (job.retryCount ?? 0) + 1,
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
