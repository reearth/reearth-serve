import type { AssetVersion } from "../model";
import type { VersionStore } from "../repository";

export async function updateVersion(
  versions: VersionStore,
  assetId: string,
  versionId: string,
  patch: { userMeta?: Record<string, unknown> },
): Promise<AssetVersion | null> {
  const version = await versions.find(versionId);
  if (!version || version.assetId !== assetId) return null;

  await versions.update(versionId, patch);
  return versions.find(versionId);
}
