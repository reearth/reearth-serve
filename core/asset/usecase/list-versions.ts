import type { AssetVersion } from "../model";
import type { VersionStore, ListResult } from "../repository";

export async function listVersions(
  versions: VersionStore,
  assetId: string,
  options?: { limit?: number; cursor?: string },
): Promise<ListResult<AssetVersion>> {
  return versions.findByAssetId(assetId, options);
}
