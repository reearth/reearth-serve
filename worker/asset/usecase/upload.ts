import type { AssetMetadata, AssetUploadResult } from "../model";
import type { FileStorage, MetadataStore } from "../repository";
import { generateId, storageKey } from "./shared";

export async function uploadAsset(
  metadata: MetadataStore,
  storage: FileStorage,
  file: { name: string; type: string; body: ArrayBuffer },
  ttlSeconds: number,
  baseUrl: string,
): Promise<AssetUploadResult> {
  const id = generateId();
  const now = Date.now();
  const contentType = file.type || "application/octet-stream";

  const size = await storage.put(storageKey(id, file.name), file.body, contentType);

  const asset: AssetMetadata = {
    id,
    filename: file.name,
    contentType,
    size,
    createdAt: now,
    expiresAt: now + ttlSeconds * 1000,
  };

  await metadata.save(asset, ttlSeconds);

  return {
    asset,
    url: `${baseUrl}/files/${id}/${encodeURIComponent(file.name)}`,
  };
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
      delete: vi.fn(async () => {}),
    };
  }

  test("uploadAsset creates metadata and stores file", async () => {
    const md = mockMetadata();
    const st = mockStorage();
    const body = new TextEncoder().encode("hello").buffer as ArrayBuffer;

    const result = await uploadAsset(md, st, { name: "test.txt", type: "text/plain", body }, 3600, "https://example.com");

    expect(result.asset.filename).toBe("test.txt");
    expect(result.asset.contentType).toBe("text/plain");
    expect(result.asset.size).toBe(5);
    expect(result.url).toContain("/files/");
    expect(result.url).toContain("test.txt");
    expect(md.save).toHaveBeenCalledOnce();
    expect(st.put).toHaveBeenCalledOnce();
  });
}
