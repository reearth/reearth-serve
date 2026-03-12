import { R2FileStorage } from "../infra/storage";
import { KVMetadataStore, KVJobStore } from "../infra/metadata";
import { cleanupExpiredAssets } from "./usecase";

export async function handleScheduled(env: Env): Promise<void> {
  const metadata = new KVMetadataStore(env.KV);
  const storage = new R2FileStorage(env.STORAGE);
  const jobs = new KVJobStore(env.KV);

  const result = await cleanupExpiredAssets(metadata, storage, jobs, {
    maxAssets: 100,
  });

  if (result.deletedAssets.length > 0) {
    console.log(
      `Cleanup: deleted ${result.deletedAssets.length} expired assets, ${result.deletedJobs.length} jobs`,
    );
  }
}
