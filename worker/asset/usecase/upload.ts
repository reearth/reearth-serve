import type { AssetMetadata, AssetUploadResult } from "../model";
import { detectArchiveFormat } from "../model";
import type { AtomicWrites, FileStorage } from "../repository";
import type { Job } from "../../job/model";
import { generateId, storageKey } from "./shared";
import { enqueueThumbnail } from "../../thumbnail/queue";
import type { ThumbnailMessage } from "../../thumbnail/queue";
import type { JobQueue } from "../../queue/port";
import type { ExtractionMessage } from "../../extraction/handler";

export async function uploadAsset(
  writes: AtomicWrites,
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
  options?: { sessionId?: string | null; projectId?: string | null; extractionQueue?: JobQueue<ExtractionMessage> | null; thumbnailQueue?: JobQueue<ThumbnailMessage> | null; skipExtraction?: boolean; usageScopes?: string[] },
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
    expiresAt: options?.projectId ? 0 : now + ttlSeconds * 1000,
    ...(file.contentEncoding && { contentEncoding: file.contentEncoding }),
    ...(file.contentEncoding && file.originalSize && { originalSize: file.originalSize }),
    ...(archiveFormat && {
      type: "archive" as const,
      ...(!options?.skipExtraction && { status: "pending" as const }),
      archiveFormat,
    }),
    ...(options?.sessionId && { sessionId: options.sessionId }),
    ...(options?.projectId && { projectId: options.projectId }),
  };

  // Create extraction job for archives (unless skipped)
  let job: Job | undefined;
  if (archiveFormat && !options?.skipExtraction) {
    job = {
      id,
      assetId: id,
      type: "archive-extraction",
      status: "pending",
      createdAt: now,
      updatedAt: now,
      ...(options?.sessionId && { sessionId: options.sessionId }),
      ...(options?.projectId && { projectId: options.projectId }),
    };
    asset.jobId = id;
  }

  try {
    // Job row, asset row and storage-usage counters in one atomic write, so a
    // failure never leaves an asset without its job or the counters short
    // (ADR-012 §3).
    await writes.createAsset({ asset, job, usageScopes: options?.usageScopes });

    // Enqueue only after the rows are committed: the consumer reads them.
    if (job && options?.extractionQueue) {
      try {
        await options.extractionQueue.send({
          assetId: id,
          archiveKey: key,
          archiveFilename: file.name,
          archiveFormat: archiveFormat!,
        });
      } catch (e) {
        console.error("Failed to enqueue extraction:", e);
      }
    }

    // Best-effort thumbnail enqueue. Skipped for non-image content types.
    await enqueueThumbnail(options?.thumbnailQueue ?? null, {
      assetId: id,
      sourceKey: key,
      contentType,
      size: file.size,
    });
  } catch (e) {
    // R2 put already succeeded but D1 metadata write failed. Without
    // compensation the R2 object is orphaned (cleanup drives off D1 rows),
    // so try to delete it. Best-effort: a delete failure here is logged
    // but the original error is what the caller cares about.
    try {
      await storage.delete(key);
    } catch (delErr) {
      console.error("Failed to clean up R2 object after metadata save failure:", delErr);
    }
    throw e;
  }

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

  type CreateAssetInput = Parameters<AtomicWrites["createAsset"]>[0];

  function mockWrites() {
    const calls: CreateAssetInput[] = [];
    const writes: AtomicWrites = {
      createAsset: vi.fn(async (input: CreateAssetInput) => { calls.push(input); }),
      createVersion: vi.fn(async () => { throw new Error("not used"); }),
      saveJob: vi.fn(async () => { throw new Error("not used"); }),
    };
    return { writes, calls };
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

  test("uploadAsset creates metadata and stores file via stream", async () => {
    const { writes, calls } = mockWrites();
    const st = mockStorage();

    const result = await uploadAsset(
      writes, st,
      { name: "test.txt", type: "text/plain", body: toStream(new TextEncoder().encode("hello")), size: 5 },
      3600, "https://example.com",
    );

    expect(result.asset.filename).toBe("test.txt");
    expect(result.asset.contentType).toBe("text/plain");
    expect(result.asset.size).toBe(5);
    expect(result.asset.type).toBeUndefined();
    expect(result.asset.status).toBeUndefined();
    expect(st.put).toHaveBeenCalledOnce();
    expect(calls).toHaveLength(1);
    expect(calls[0].job).toBeUndefined();
  });

  test("uploadAsset detects ZIP and writes the job in the same batch", async () => {
    const { writes, calls } = mockWrites();

    const result = await uploadAsset(
      writes, mockStorage(),
      { name: "data.zip", type: "application/zip", body: toStream(new Uint8Array(10)), size: 10 },
      3600, "https://example.com",
    );

    expect(result.asset.type).toBe("archive");
    expect(result.asset.status).toBe("pending");
    expect(result.asset.archiveFormat).toBe("zip");
    expect(result.asset.jobId).toBe(result.asset.id);
    expect(calls[0].job?.id).toBe(result.asset.id);
  });

  test("uploadAsset detects tar.gz and creates job", async () => {
    const { writes, calls } = mockWrites();

    const result = await uploadAsset(
      writes, mockStorage(),
      { name: "data.tar.gz", type: "application/gzip", body: toStream(new Uint8Array(10)), size: 10 },
      3600, "https://example.com",
    );

    expect(result.asset.archiveFormat).toBe("tar.gz");
    expect(calls[0].job).toBeDefined();
  });

  test("uploadAsset passes the storage-usage scopes into the batch", async () => {
    const { writes, calls } = mockWrites();

    await uploadAsset(
      writes, mockStorage(),
      { name: "a.txt", type: "text/plain", body: toStream(new Uint8Array(3)), size: 3 },
      3600, "https://example.com",
      { projectId: "p1", usageScopes: ["project:p1", "workspace:ws1"] },
    );

    expect(calls[0].usageScopes).toEqual(["project:p1", "workspace:ws1"]);
  });

  test("uploadAsset enqueues extraction only after the rows are committed", async () => {
    const { writes } = mockWrites();
    const order: string[] = [];
    (writes.createAsset as ReturnType<typeof vi.fn>).mockImplementation(async () => { order.push("write"); });
    const extractionQueue = { send: vi.fn(async () => { order.push("enqueue"); }) };

    await uploadAsset(
      writes, mockStorage(),
      { name: "data.zip", type: "application/zip", body: toStream(new Uint8Array(10)), size: 10 },
      3600, "https://example.com",
      { extractionQueue },
    );

    expect(order).toEqual(["write", "enqueue"]);
  });

  test("uploadAsset does not compress (compression is client responsibility)", async () => {
    const { writes } = mockWrites();
    const data = new TextEncoder().encode('{"data":' + '"x"'.repeat(500) + '}');

    const result = await uploadAsset(
      writes, mockStorage(),
      { name: "data.json", type: "application/json", body: toStream(data), size: data.byteLength },
      3600, "https://example.com",
    );

    expect(result.asset.contentEncoding).toBeUndefined();
    expect(result.asset.originalSize).toBeUndefined();
    expect(result.asset.size).toBe(data.byteLength);
  });

  test("uploadAsset records contentEncoding and originalSize when provided", async () => {
    const { writes } = mockWrites();

    const result = await uploadAsset(
      writes, mockStorage(),
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

  test("uploadAsset with skipExtraction detects archive but does not create job", async () => {
    const { writes, calls } = mockWrites();

    const result = await uploadAsset(
      writes, mockStorage(),
      { name: "data.zip", type: "application/zip", body: toStream(new Uint8Array(10)), size: 10 },
      3600, "https://example.com",
      { skipExtraction: true },
    );

    expect(result.asset.type).toBe("archive");
    expect(result.asset.archiveFormat).toBe("zip");
    expect(result.asset.status).toBeUndefined();
    expect(result.asset.jobId).toBeUndefined();
    expect(calls[0].job).toBeUndefined();
  });
}
