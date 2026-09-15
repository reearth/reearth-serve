import type { AssetMetadata } from "../model";
import type { MetadataStore, VersionStore } from "../repository";

export async function updateAsset(
  metadata: MetadataStore,
  versions: VersionStore,
  id: string,
  patch: {
    description?: string;
    userMeta?: Record<string, unknown>;
    activeVersionId?: string | null;
    expiresAt?: number;
    /** ADR-013 C1; validated by `checkSpaChange` before this is called. */
    spa?: boolean;
  },
): Promise<AssetMetadata | null> {
  const asset = await metadata.find(id);
  if (!asset) return null;

  // Validate activeVersionId if provided
  if (patch.activeVersionId !== undefined && patch.activeVersionId !== null) {
    const version = await versions.find(patch.activeVersionId);
    if (!version || version.assetId !== id) return null;
  }

  const updatePatch: { activeVersionId?: string | null; expiresAt?: number; description?: string; userMeta?: Record<string, unknown>; spa?: boolean } = {};
  if (patch.description !== undefined) updatePatch.description = patch.description;
  if (patch.userMeta !== undefined) updatePatch.userMeta = patch.userMeta;
  if (patch.activeVersionId !== undefined) updatePatch.activeVersionId = patch.activeVersionId;
  if (patch.expiresAt !== undefined) updatePatch.expiresAt = patch.expiresAt;
  if (patch.spa !== undefined) updatePatch.spa = patch.spa;

  await metadata.update(id, updatePatch);

  // Return updated asset
  return metadata.find(id);
}
