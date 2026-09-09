import type { AssetVersion } from "../model";
import type { VersionStore } from "../repository";

export async function getVersion(
  versions: VersionStore,
  versionId: string,
): Promise<AssetVersion | null> {
  return versions.find(versionId);
}
