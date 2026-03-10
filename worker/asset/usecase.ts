import type { AssetMetadata, AssetUploadResult, StoredFile } from "./model";
import type { FileStorage, MetadataStore } from "./repository";

function generateId(): string {
  return crypto.randomUUID().replace(/-/g, "").slice(0, 16);
}

function storageKey(id: string, filename: string): string {
  return `assets/${id}/${filename}`;
}

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

export async function getAssetMetadata(
  metadata: MetadataStore,
  id: string,
): Promise<AssetMetadata | null> {
  return metadata.find(id);
}

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
      get: vi.fn(async (key: string) => {
        const buf = store.get(key);
        if (!buf) return null;
        return {
          body: new ReadableStream({
            start(c) { c.enqueue(new Uint8Array(buf)); c.close(); },
          }),
          size: buf.byteLength,
          contentType: "application/octet-stream",
        };
      }),
      delete: vi.fn(async (key: string) => { store.delete(key); }),
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

  test("deleteAsset removes both metadata and file", async () => {
    const md = mockMetadata();
    const st = mockStorage();
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

  test("getAssetMetadata returns null for non-existent asset", async () => {
    const md = mockMetadata();
    const result = await getAssetMetadata(md, "nonexistent");
    expect(result).toBeNull();
  });
}
