import type { AssetMetadata } from "../model";
import type { MetadataStore } from "../repository";

export async function getAssetMetadata(
  metadata: MetadataStore,
  id: string,
): Promise<AssetMetadata | null> {
  return metadata.find(id);
}

if (import.meta.vitest) {
  const { test, expect, vi } = import.meta.vitest;

  function mockMetadata(): MetadataStore {
    const store = new Map<string, AssetMetadata>();
    return {
      save: vi.fn(async (asset: AssetMetadata, _ttl: number) => { store.set(asset.id, asset); }),
      find: vi.fn(async (id: string) => store.get(id) ?? null),
      update: vi.fn(async () => {}),
      delete: vi.fn(async (id: string) => { store.delete(id); }),
      list: vi.fn(async () => ({ items: [], cursor: undefined })),
    };
  }

  test("getAssetMetadata returns null for non-existent asset", async () => {
    const md = mockMetadata();
    const result = await getAssetMetadata(md, "nonexistent");
    expect(result).toBeNull();
  });
}
