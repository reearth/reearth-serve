import type { AssetMetadata, AssetUploadResult } from "../model";
import { detectArchiveFormat } from "../model";
import type { FileStorage, MetadataStore } from "../repository";
import type { JobStore } from "../../job/repository";
import type { Job } from "../../job/model";
import type { ContainerLauncher } from "../../infra/container";
import { generateId, storageKey } from "./shared";

export async function uploadAsset(
  metadata: MetadataStore,
  storage: FileStorage,
  jobs: JobStore,
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
  options?: { sessionId?: string | null; projectId?: string | null; containerLauncher?: ContainerLauncher | null },
): Promise<AssetUploadResult> {
  const id = generateId();
  const now = Date.now();
  const contentType = file.type || "application/octet-stream";
  const key = storageKey(id, file.name);

  await storage.put(key, file.body, contentType, file.size,
    file.contentEncoding ? { contentEncoding: file.contentEncoding } : undefined,
  );

  const archiveFormat = detectArchiveFormat(file.name);

  const asset: AssetMetadata = {
    id,
    filename: file.name,
    contentType,
    size: file.size,
    createdAt: now,
    expiresAt: now + ttlSeconds * 1000,
    ...(file.contentEncoding && { contentEncoding: file.contentEncoding }),
    ...(file.contentEncoding && file.originalSize && { originalSize: file.originalSize }),
    ...(archiveFormat && {
      type: "archive" as const,
      status: "pending" as const,
      archiveFormat,
    }),
    ...(options?.sessionId && { sessionId: options.sessionId }),
    ...(options?.projectId && { projectId: options.projectId }),
  };

  // Create extraction job for archives
  if (archiveFormat) {
    const job: Job = {
      id,
      assetId: id,
      type: "archive-extraction",
      status: "pending",
      createdAt: now,
      updatedAt: now,
      ...(options?.projectId && { projectId: options.projectId }),
    };
    await jobs.save(job);
    asset.jobId = id;

    // Trigger container extraction
    if (options?.containerLauncher) {
      try {
        await options.containerLauncher.launchArchiveExtractor({
          assetId: id,
          archiveKey: key,
          archiveFilename: file.name,
          archiveFormat,
        });
      } catch (e) {
        console.error("Failed to launch archive extractor:", e);
      }
    }
  }

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
      list: vi.fn(async () => ({ keys: [], cursor: undefined })),
    };
  }

  function mockJobs(): JobStore {
    const store = new Map<string, Job>();
    return {
      save: vi.fn(async (job: Job) => { store.set(job.id, job); }),
      find: vi.fn(async (id: string) => store.get(id) ?? null),
      delete: vi.fn(async (id: string) => { store.delete(id); }),
    };
  }

  test("uploadAsset creates metadata and stores file via stream", async () => {
    const md = mockMetadata();
    const st = mockStorage();
    const jb = mockJobs();

    const result = await uploadAsset(
      md, st, jb,
      { name: "test.txt", type: "text/plain", body: toStream(new TextEncoder().encode("hello")), size: 5 },
      3600, "https://example.com",
    );

    expect(result.asset.filename).toBe("test.txt");
    expect(result.asset.contentType).toBe("text/plain");
    expect(result.asset.size).toBe(5);
    expect(result.asset.type).toBeUndefined();
    expect(result.asset.status).toBeUndefined();
    expect(md.save).toHaveBeenCalledOnce();
    expect(st.put).toHaveBeenCalledOnce();
    expect(jb.save).not.toHaveBeenCalled();
  });

  test("uploadAsset detects ZIP and creates job", async () => {
    const md = mockMetadata();
    const st = mockStorage();
    const jb = mockJobs();

    const result = await uploadAsset(
      md, st, jb,
      { name: "data.zip", type: "application/zip", body: toStream(new Uint8Array(10)), size: 10 },
      3600, "https://example.com",
    );

    expect(result.asset.type).toBe("archive");
    expect(result.asset.status).toBe("pending");
    expect(result.asset.archiveFormat).toBe("zip");
    expect(result.asset.jobId).toBe(result.asset.id);
    expect(jb.save).toHaveBeenCalledOnce();
  });

  test("uploadAsset detects tar.gz and creates job", async () => {
    const md = mockMetadata();
    const st = mockStorage();
    const jb = mockJobs();

    const result = await uploadAsset(
      md, st, jb,
      { name: "data.tar.gz", type: "application/gzip", body: toStream(new Uint8Array(10)), size: 10 },
      3600, "https://example.com",
    );

    expect(result.asset.type).toBe("archive");
    expect(result.asset.archiveFormat).toBe("tar.gz");
    expect(jb.save).toHaveBeenCalledOnce();
  });

  test("uploadAsset does not compress (compression is client responsibility)", async () => {
    const md = mockMetadata();
    const st = mockStorage();
    const jb = mockJobs();
    const data = new TextEncoder().encode('{"data":' + '"x"'.repeat(500) + '}');

    const result = await uploadAsset(
      md, st, jb,
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
    const jb = mockJobs();

    const result = await uploadAsset(
      md, st, jb,
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
