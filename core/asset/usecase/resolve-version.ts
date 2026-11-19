import type { AssetMetadata, AssetVersion } from "../model";
import type { MetadataStore, VersionStore } from "../repository";

export interface ResolvedAsset {
  asset: AssetMetadata;
  version: AssetVersion | null;
}

/** The version an asset-ID URL serves: the active one, else the latest, else none (assets from before ADR-005). */
export async function activeVersion(versions: VersionStore, asset: AssetMetadata): Promise<AssetVersion | null> {
  const active = asset.activeVersionId ? await versions.find(asset.activeVersionId) : null;
  return active ?? (await versions.findLatest(asset.id));
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
  if (asset) return { asset, version: await activeVersion(versions, asset) };

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

  const currentVersion = await activeVersion(versions, asset);
  return {
    ...asset,
    ...(currentVersion && { currentVersion }),
    versionCount,
  };
}
