import type { AssetVersion } from "../model";
import type { AtomicWrites, VersionStore, MetadataStore, FileStorage } from "../repository";
import type { CleanupPendingStore } from "../../cleanup/repository";
import { deleteAllR2Objects, SubrequestBudget } from "../../cleanup/usecase";

const INLINE_DELETE_BUDGET = 50;

export async function deleteVersion(
  versions: VersionStore,
  metadata: MetadataStore,
  writes: AtomicWrites,
  assetId: string,
  versionId: string,
  options?: { storage?: FileStorage; pendingCleanup?: CleanupPendingStore; budget?: SubrequestBudget; usageScopes?: string[] },
): Promise<AssetVersion | null> {
  const version = await versions.find(versionId);
  if (!version || version.assetId !== assetId) return null;

  // Row, usage counters and blob reference in one write. A blob is never
  // deleted here — another version or asset in the scope may hold the same
  // key — and one that drops to zero is swept by the cron after its grace
  // period (ADR-017 §5).
  if (!(await writes.deleteVersion({ version, usageScopes: options?.usageScopes }))) return null;

  // If the deleted version was the active version, reset to null (latest)
  const asset = await metadata.find(assetId);
  if (asset?.activeVersionId === versionId) {
    await metadata.update(assetId, { activeVersionId: null });
  }

  // Wipe the version's R2 prefix (archive body + any extracted files). A
  // blob is outside it.
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
