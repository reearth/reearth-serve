import type { AssetMetadata, AssetUploadResult } from "../model";
import type { FileStorage, MetadataStore } from "../repository";
import { generateId, storageKey } from "./shared";

export async function uploadAsset(
  metadata: MetadataStore,
  storage: FileStorage,
  file: {
    name: string;
    type: string;
    body: ReadableStream<Uint8Array>;
    size: number;
    contentEncoding?: string;
    originalSize?: number;
  },
  ttlSeconds: number,
  baseUrl: string,
): Promise<AssetUploadResult> {
  const id = generateId();
  const now = Date.now();
  const contentType = file.type || "application/octet-stream";
  const key = storageKey(id, file.name);

  await storage.put(key, file.body, contentType, file.size,
    file.contentEncoding ? { contentEncoding: file.contentEncoding } : undefined,
  );

  const asset: AssetMetadata = {
    id,
    filename: file.name,
    contentType,
    size: file.size,
    createdAt: now,
    expiresAt: now + ttlSeconds * 1000,
    ...(file.contentEncoding && { contentEncoding: file.contentEncoding }),
    ...(file.contentEncoding && file.originalSize && { originalSize: file.originalSize }),
  };

  await metadata.save(asset, ttlSeconds);

  return {
    asset,
    url: `${baseUrl}/files/${id}/${encodeURIComponent(file.name)}`,
  };
}

if (import.meta.vitest) {
  const { test, expect, vi } = import.meta.vitest;

  function toStream(data: Uint8Array): ReadableStream<Uint8Array> {
    return new ReadableStream({ start(c) { c.enqueue(data); c.close(); } });
  }

  function mockMetadata(): MetadataStore {
    const store = new Map<string, AssetMetadata>();
    return {
      save: vi.fn(async (asset: AssetMetadata, _ttl: number) => { store.set(asset.id, asset); }),
      find: vi.fn(async (id: string) => store.get(id) ?? null),
      delete: vi.fn(async (id: string) => { store.delete(id); }),
    };
  }

  function mockStorage(): FileStorage {
    return {
      put: vi.fn(async (_key: string, body: ReadableStream<Uint8Array>, _ct: string, _size: number) => {
        const reader = body.getReader();
        while (!(await reader.read()).done) {}
      }),
      get: vi.fn(async () => null),
      head: vi.fn(async () => null),
      delete: vi.fn(async () => {}),
    };
  }

  test("uploadAsset creates metadata and stores file via stream", async () => {
    const md = mockMetadata();
    const st = mockStorage();

    const result = await uploadAsset(
      md, st,
      { name: "test.txt", type: "text/plain", body: toStream(new TextEncoder().encode("hello")), size: 5 },
      3600, "https://example.com",
    );

    expect(result.asset.filename).toBe("test.txt");
    expect(result.asset.contentType).toBe("text/plain");
    expect(result.asset.size).toBe(5);
    expect(md.save).toHaveBeenCalledOnce();
    expect(st.put).toHaveBeenCalledOnce();
  });

  test("uploadAsset does not compress (compression is client responsibility)", async () => {
    const md = mockMetadata();
    const st = mockStorage();
    const data = new TextEncoder().encode('{"data":' + '"x"'.repeat(500) + '}');

    const result = await uploadAsset(
      md, st,
      { name: "data.json", type: "application/json", body: toStream(data), size: data.byteLength },
      3600, "https://example.com",
    );

    expect(result.asset.contentEncoding).toBeUndefined();
    expect(result.asset.originalSize).toBeUndefined();
    expect(result.asset.size).toBe(data.byteLength);
  });

  test("uploadAsset records contentEncoding and originalSize when provided", async () => {
    const md = mockMetadata();
    const st = mockStorage();

    const result = await uploadAsset(
      md, st,
      {
        name: "data.json", type: "application/json",
        body: toStream(new Uint8Array(50)), size: 50,
        contentEncoding: "gzip", originalSize: 200,
      },
      3600, "https://example.com",
    );

    expect(result.asset.contentEncoding).toBe("gzip");
    expect(result.asset.originalSize).toBe(200);
    expect(result.asset.size).toBe(50);
  });
}
