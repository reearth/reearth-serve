import { R2FileStorage } from "../infra/storage";
import { KVMetadataStore, KVJobStore } from "../infra/metadata";
import { CloudflareContainerLauncher } from "../infra/container";
import type { ContainerLauncher } from "../infra/container";
import { cleanupExpiredAssets } from "./usecase";
import type { Job } from "../job/model";

const CURSOR_KEY = "cleanup:cursor";

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

  // Re-trigger pending/failed extraction jobs
  const containerLauncher = (env.ARCHIVE_EXTRACTOR && env.R2_S3_ENDPOINT && env.R2_ACCESS_KEY_ID && env.R2_SECRET_ACCESS_KEY)
    ? new CloudflareContainerLauncher(env.ARCHIVE_EXTRACTOR, env.BASE_URL, {
        endpoint: env.R2_S3_ENDPOINT,
        accessKeyId: env.R2_ACCESS_KEY_ID,
        secretAccessKey: env.R2_SECRET_ACCESS_KEY,
        bucket: env.R2_BUCKET_NAME || "reearth-serve",
      })
    : null;

  if (containerLauncher) {
    await retriggerPendingJobs(env.KV, metadata, containerLauncher);
  }
}

async function retriggerPendingJobs(
  kv: KVNamespace,
  metadata: KVMetadataStore,
  containerLauncher: ContainerLauncher,
): Promise<void> {
  let cursor: string | undefined;

  do {
    const list = await kv.list({ prefix: "job:", limit: 100, cursor });

    for (const key of list.keys) {
      const raw = await kv.get(key.name);
      if (!raw) continue;

      const job = JSON.parse(raw) as Job;
      if (job.status !== "pending" && job.status !== "failed") continue;
      if (job.type !== "archive-extraction") continue;

      // Check if asset still exists
      const asset = await metadata.find(job.assetId);
      if (!asset || !asset.archiveFormat) continue;

      try {
        await containerLauncher.launchArchiveExtractor({
          assetId: job.assetId,
          archiveKey: `assets/${job.assetId}/${asset.filename}`,
          archiveFilename: asset.filename,
          archiveFormat: asset.archiveFormat,
        });
        console.log(`Re-triggered extraction for asset ${job.assetId}`);
      } catch (e) {
        console.error(`Failed to re-trigger extraction for asset ${job.assetId}:`, e);
      }
    }

    cursor = list.list_complete ? undefined : list.cursor;
  } while (cursor);
}
