import { R2FileStorage } from "../infra/storage";
import { D1MetadataStore, D1JobStore } from "../infra/d1";
import { cleanupExpiredAssets } from "./usecase";
import type { Job } from "../job/model";

const DEFAULT_STUCK_THRESHOLD_MS = 24 * 60 * 60 * 1000; // 24 hours
const MAX_RETRIES = 5;

export async function handleScheduled(env: Env): Promise<void> {
  const metadata = new D1MetadataStore(env.DB);
  const storage = new R2FileStorage(env.STORAGE);
  const jobs = new D1JobStore(env.DB);

  const result = await cleanupExpiredAssets(metadata, storage, jobs, {
    maxAssets: 100,
  });

  if (result.deletedAssets.length > 0) {
    console.log(
      `Cleanup: deleted ${result.deletedAssets.length} expired assets, ${result.deletedJobs.length} jobs`,
    );
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
  const retriableJobs = await jobs.listRetriable(stuckThresholdMs, MAX_RETRIES);

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

    try {
      // Increment retry count and reset to pending
      const updatedJob: Job = {
        ...job,
        retryCount: (job.retryCount ?? 0) + 1,
        status: "pending",
        updatedAt: Date.now(),
      };
      await jobs.save(updatedJob);

      await queue.send({
        assetId: job.assetId,
        archiveKey: `assets/${job.assetId}/${asset.filename}`,
        archiveFilename: asset.filename,
        archiveFormat: asset.archiveFormat,
      });
      console.log(`Re-enqueued extraction for asset ${job.assetId} (retry ${updatedJob.retryCount}/${MAX_RETRIES})`);
    } catch (e) {
      console.error(`Failed to re-enqueue extraction for asset ${job.assetId}:`, e);
    }
  }
}
