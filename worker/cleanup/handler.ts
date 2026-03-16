import { R2FileStorage } from "../infra/storage";
import { KVMetadataStore, KVJobStore } from "../infra/metadata";
import { cleanupExpiredAssets } from "./usecase";
import type { Job } from "../job/model";

const CURSOR_KEY = "cleanup:cursor";
const DEFAULT_STUCK_THRESHOLD_MS = 24 * 60 * 60 * 1000; // 24 hours
const MAX_RETRIES = 5;

export async function handleScheduled(env: Env): Promise<void> {
  const metadata = new KVMetadataStore(env.KV);
  const storage = new R2FileStorage(env.STORAGE);
  const jobs = new KVJobStore(env.KV);

  // Resume from last cursor
  const cursor = await env.KV.get(CURSOR_KEY) ?? undefined;

  const result = await cleanupExpiredAssets(metadata, storage, jobs, {
    maxAssets: 100,
    cursor,
  });

  // Persist cursor for next invocation; delete if scan is complete
  if (result.nextCursor) {
    await env.KV.put(CURSOR_KEY, result.nextCursor);
  } else {
    await env.KV.delete(CURSOR_KEY);
  }

  if (result.deletedAssets.length > 0) {
    console.log(
      `Cleanup: deleted ${result.deletedAssets.length} expired assets, ${result.deletedJobs.length} jobs`,
    );
  }

  // Re-trigger pending/failed/stuck extraction jobs via queue
  if (env.EXTRACTION_QUEUE) {
    const stuckThresholdMs = parseInt(env.EXTRACTION_STUCK_THRESHOLD_SECONDS || "", 10) * 1000 || DEFAULT_STUCK_THRESHOLD_MS;
    await retriggerPendingJobs(env.KV, metadata, env.EXTRACTION_QUEUE, stuckThresholdMs);
  }
}

async function retriggerPendingJobs(
  kv: KVNamespace,
  metadata: KVMetadataStore,
  queue: Queue,
  stuckThresholdMs: number,
): Promise<void> {
  const raw = await kv.get("job_list:all");
  if (!raw) return;
  const jobIds: string[] = JSON.parse(raw);

  for (const id of jobIds) {
    const jobRaw = await kv.get(`job:${id}`);
    if (!jobRaw) continue;

    const job = JSON.parse(jobRaw) as Job;
    if (job.type !== "archive-extraction") continue;

    const isStuck = job.status === "running" && (Date.now() - job.updatedAt > stuckThresholdMs);
    if (job.status !== "pending" && job.status !== "failed" && !isStuck) continue;

    // Mark as permanently failed if max retries exceeded
    if ((job.retryCount ?? 0) >= MAX_RETRIES) {
      if (job.status !== "failed") {
        job.status = "failed";
        job.error = `Max retries (${MAX_RETRIES}) exceeded`;
        job.updatedAt = Date.now();
        job.completedAt = Date.now();
        await kv.put(`job:${id}`, JSON.stringify(job));

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
      job.retryCount = (job.retryCount ?? 0) + 1;
      job.status = "pending";
      job.updatedAt = Date.now();
      await kv.put(`job:${id}`, JSON.stringify(job));

      await queue.send({
        assetId: job.assetId,
        archiveKey: `assets/${job.assetId}/${asset.filename}`,
        archiveFilename: asset.filename,
        archiveFormat: asset.archiveFormat,
      });
      console.log(`Re-enqueued extraction for asset ${job.assetId} (retry ${job.retryCount}/${MAX_RETRIES})`);
    } catch (e) {
      console.error(`Failed to re-enqueue extraction for asset ${job.assetId}:`, e);
    }
  }
}
