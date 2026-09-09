import type { AssetMetadata, AssetVersion } from "../model";
import type { MetadataStore, VersionStore } from "../repository";

export interface ResolvedAsset {
  asset: AssetMetadata;
  version: AssetVersion | null;
}

/**
 * Resolve an ID (asset or version) to an asset + its active/latest version.
 * Returns null if not found.
 */
export async function resolveAssetVersion(
  metadata: MetadataStore,
  versions: VersionStore,
  id: string,
): Promise<ResolvedAsset | null> {
  // 1. Try as asset ID
  const asset = await metadata.find(id);
  if (asset) {
    let version: AssetVersion | null = null;
    if (asset.activeVersionId) {
      version = await versions.find(asset.activeVersionId);
    }
    if (!version) {
      version = await versions.findLatest(id);
    }
    return { asset, version };
  }

  // 2. Try as version ID
  const version = await versions.find(id);
  if (version) {
    const parentAsset = await metadata.find(version.assetId);
    if (parentAsset) {
      return { asset: parentAsset, version };
    }
  }

  return null;
}

/**
 * Get asset metadata enriched with currentVersion and versionCount.
 */
export async function enrichAssetWithVersion(
  metadata: MetadataStore,
  versions: VersionStore,
  id: string,
): Promise<AssetMetadata | null> {
  const asset = await metadata.find(id);
  if (!asset) return null;

  const versionCount = await versions.count(id);

  if (versionCount === 0) return { ...asset, versionCount: 0 };

  let currentVersion: AssetVersion | null = null;
  if (asset.activeVersionId) {
    currentVersion = await versions.find(asset.activeVersionId);
  }
  if (!currentVersion) {
    currentVersion = await versions.findLatest(id);
  }

  return {
    ...asset,
    ...(currentVersion && { currentVersion }),
    versionCount,
  };
}
