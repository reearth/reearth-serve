import { R2FileStorage } from "../infra/storage";
import { KVMetadataStore, KVJobStore } from "../infra/metadata";
import { cleanupExpiredAssets } from "./usecase";

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
}
