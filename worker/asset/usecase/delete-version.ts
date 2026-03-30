import type { AssetVersion } from "../model";
import type { VersionStore, MetadataStore } from "../repository";

export async function deleteVersion(
  versions: VersionStore,
  metadata: MetadataStore,
  assetId: string,
  versionId: string,
): Promise<AssetVersion | null> {
  const version = await versions.find(versionId);
  if (!version || version.assetId !== assetId) return null;

  await versions.delete(versionId);

  // If the deleted version was the active version, reset to null (latest)
  const asset = await metadata.find(assetId);
  if (asset?.activeVersionId === versionId) {
    await metadata.update(assetId, { activeVersionId: null });
  }

  return version;
}
