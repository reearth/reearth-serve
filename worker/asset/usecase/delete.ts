import type { AssetMetadata } from "../model";
import type { FileStorage, MetadataStore } from "../repository";
import { storageKey } from "./shared";

export async function deleteAsset(
  metadata: MetadataStore,
  storage: FileStorage,
  id: string,
): Promise<boolean> {
  const asset = await metadata.find(id);
  if (!asset) return false;

  await Promise.all([
    storage.delete(storageKey(id, asset.filename)),
    metadata.delete(id),
  ]);

  return true;
}

if (import.meta.vitest) {
  const { test, expect, vi } = import.meta.vitest;

  function mockMetadata(): MetadataStore {
    const store = new Map<string, AssetMetadata>();
    return {
      save: vi.fn(async (asset: AssetMetadata, _ttl: number) => { store.set(asset.id, asset); }),
      find: vi.fn(async (id: string) => store.get(id) ?? null),
      delete: vi.fn(async (id: string) => { store.delete(id); }),
    };
  }

  function mockStorage(): FileStorage {
    const store = new Map<string, ArrayBuffer>();
    return {
      put: vi.fn(async (key: string, body: ArrayBuffer | ReadableStream, _ct: string) => {
        const buf = body instanceof ArrayBuffer ? body : new ArrayBuffer(0);
        store.set(key, buf);
        return buf.byteLength;
      }),
      get: vi.fn(async () => null),
      head: vi.fn(async () => null),
      delete: vi.fn(async (key: string) => { store.delete(key); }),
    };
  }

  test("deleteAsset removes both metadata and file", async () => {
    const md = mockMetadata();
    const st = mockStorage();
    const { uploadAsset } = await import("./upload");
    const body = new TextEncoder().encode("data").buffer as ArrayBuffer;

    const { asset } = await uploadAsset(md, st, { name: "f.bin", type: "application/octet-stream", body }, 3600, "https://example.com");

    const deleted = await deleteAsset(md, st, asset.id);
    expect(deleted).toBe(true);
    expect(md.delete).toHaveBeenCalledOnce();
    expect(st.delete).toHaveBeenCalledOnce();
  });

  test("deleteAsset returns false for non-existent asset", async () => {
    const md = mockMetadata();
    const st = mockStorage();

    const deleted = await deleteAsset(md, st, "nonexistent");
    expect(deleted).toBe(false);
    expect(st.delete).not.toHaveBeenCalled();
  });
}
