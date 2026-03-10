import type { AssetMetadata, StoredFile } from "../model";
import type { FileStorage, MetadataStore } from "../repository";
import { storageKey } from "./shared";

export async function getAssetFile(
  metadata: MetadataStore,
  storage: FileStorage,
  id: string,
  range?: { offset: number; length: number },
): Promise<{ asset: AssetMetadata; file: StoredFile } | null> {
  const asset = await metadata.find(id);
  if (!asset) return null;

  const file = await storage.get(storageKey(id, asset.filename), range);
  if (!file) return null;

  return { asset, file };
}
