import type { AssetVersion } from "../model";
import type { VersionStore, MetadataStore, FileStorage } from "../repository";
import type { CleanupPendingStore } from "../../cleanup/repository";
import { deleteAllR2Objects, SubrequestBudget } from "../../cleanup/usecase";

const INLINE_DELETE_BUDGET = 50;

export async function deleteVersion(
  versions: VersionStore,
  metadata: MetadataStore,
  assetId: string,
  versionId: string,
  options?: { storage?: FileStorage; pendingCleanup?: CleanupPendingStore; budget?: SubrequestBudget },
): Promise<AssetVersion | null> {
  const version = await versions.find(versionId);
  if (!version || version.assetId !== assetId) return null;

  await versions.delete(versionId);

  // If the deleted version was the active version, reset to null (latest)
  const asset = await metadata.find(assetId);
  if (asset?.activeVersionId === versionId) {
    await metadata.update(assetId, { activeVersionId: null });
  }

  // Wipe the version's R2 prefix (archive body + any extracted files).
  // Missing the storage binding means we're in a legacy test path — skip.
  if (options?.storage) {
    const prefix = `assets/${assetId}/v/${versionId}/`;
    const budget = options.budget ?? new SubrequestBudget(INLINE_DELETE_BUDGET);
    const r2Result = await deleteAllR2Objects(options.storage, prefix, budget);
    if (!r2Result.done && options.pendingCleanup) {
      await options.pendingCleanup.add(prefix);
    }
  }

  return version;
}
