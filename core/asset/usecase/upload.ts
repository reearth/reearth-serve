import type { AssetMetadata, AssetUploadResult } from "../model";
import { detectArchiveFormat } from "../model";
import type { AtomicWrites, FileStorage } from "../repository";
import type { Job } from "../../job/model";
import { generateId, storageKey } from "./shared";
import { placeDirectUpload, type BlobContext } from "../../blob/usecase";
import { siteUrlFor } from "../../site/url";
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
    /**
     * Declared SHA-256 of the body, lowercase hex (ADR-017 §1). The store
     * verifies it and writes nothing on a mismatch (`ChecksumMismatchError`).
     */
    sha256?: string;
  },
  ttlSeconds: number,
  baseUrl: string,
  options?: {
    sessionId?: string | null; projectId?: string | null;
    extractionQueue?: JobQueue<ExtractionMessage> | null; thumbnailQueue?: JobQueue<ThumbnailMessage> | null;
    skipExtraction?: boolean; usageScopes?: string[]; siteHostSuffix?: string;
    /** Blob ledger and scope: a declared upload is stored at its blob key (ADR-017 §3). Omitted, it is not. */
    blob?: BlobContext;
  },
): Promise<AssetUploadResult & { asset: AssetMetadata }> {
  const id = generateId();
  const now = Date.now();
  const contentType = file.type || "application/octet-stream";
  // A declared hash goes to the blob layer when the ledger lets this upload
  // write the key; otherwise, and always without a declaration, to the
  // asset's own key.
  const placement = options?.blob
    ? await placeDirectUpload(options.blob.refs, options.blob.scope, file.sha256, storageKey(id, file.name), now)
    : { key: storageKey(id, file.name) };
  const key = placement.key;

  // Declared or not, the store hands back the hash of what it stored, so the
  // row is `verified` either way (ADR-017 §2). A declared mismatch throws
  // here, before any row exists and with nothing stored.
  const stored = await storage.put(key, file.body, contentType, file.size, {
    ...(file.contentEncoding && { contentEncoding: file.contentEncoding }),
    ...(file.sha256 && { sha256: file.sha256 }),
  });

  const archiveFormat = detectArchiveFormat(file.name);

  const asset: AssetMetadata = {
    id,
    filename: file.name,
    contentType,
    size: file.size,
    createdAt: now,
    expiresAt: options?.projectId ? 0 : now + ttlSeconds * 1000,
    sha256: stored.sha256,
    integrity: "verified",
    ...(file.contentEncoding && { contentEncoding: file.contentEncoding }),
    ...(file.contentEncoding && file.originalSize && { originalSize: file.originalSize }),
    ...(archiveFormat && {
      type: "archive" as const,
      ...(!options?.skipExtraction && { status: "pending" as const }),
      archiveFormat,
    }),
    ...(options?.sessionId && { sessionId: options.sessionId }),
    ...(options?.projectId && { projectId: options.projectId }),
    ...(placement.ref && { blobKey: placement.ref.key }),
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
    // The blob reference rides in the same write: bytes first, ledger second (ADR-017 §5).
    await writes.createAsset({
      asset, job, usageScopes: options?.usageScopes,
      ...(placement.ref && { blob: { ref: placement.ref, state: "ready" as const } }),
    });

    // Enqueue only after the rows are committed: the consumer reads them.
    if (job && options?.extractionQueue) {
      try {
        await options.extractionQueue.send({
          jobId: id,
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
    //
    // A blob is never deleted here: other rows may reference the same key.
    // The reservation's grace clock (or, failing that, the orphan sweep)
    // reclaims it if nothing does.
    if (!placement.ref) {
      try {
        await storage.delete(key);
      } catch (delErr) {
        console.error("Failed to clean up R2 object after metadata save failure:", delErr);
      }
    }
    throw e;
  }

  const siteUrl = siteUrlFor({
    assetId: id,
    baseUrl,
    siteHostSuffix: options?.siteHostSuffix,
    archive: Boolean(archiveFormat),
  });

  return {
    asset,
    url: `${baseUrl}/files/${id}/${encodeURIComponent(file.name)}`,
    ...(siteUrl && { siteUrl }),
  };
}

if (import.meta.vitest) {
  const { test, expect, vi } = import.meta.vitest;

  function toStream(data: Uint8Array): ReadableStream<Uint8Array> {
    return new ReadableStream({ start(c) { c.enqueue(data); c.close(); } });
  }

  type CreateAssetInput = Parameters<AtomicWrites["createAsset"]>[0];
  const COMPUTED_SHA256 = "a".repeat(64);
  const DECLARED_SHA256 = "b".repeat(64);

  function mockWrites() {
    const calls: CreateAssetInput[] = [];
    const writes: AtomicWrites = {
      createAsset: vi.fn(async (input: CreateAssetInput) => { calls.push(input); }),
      createVersion: vi.fn(async () => { throw new Error("not used"); }),
      deleteVersion: vi.fn(async () => { throw new Error("not used"); }),
      saveJob: vi.fn(async () => { throw new Error("not used"); }),
      deleteAsset: vi.fn(async () => { throw new Error("not used"); }),
    };
    return { writes, calls };
  }

  function mockStorage(): FileStorage {
    return {
      put: vi.fn(async (_key: string, body: ReadableStream<Uint8Array>, _ct: string, _size: number, opts?: { sha256?: string }) => {
        const reader = body.getReader();
        while (!(await reader.read()).done) {}
        return { sha256: opts?.sha256 ?? COMPUTED_SHA256 };
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

  test("uploadAsset adds siteUrl for an archive when a site host suffix is configured", async () => {
    const { writes } = mockWrites();

    const archive = await uploadAsset(
      writes, mockStorage(),
      { name: "site.zip", type: "application/zip", body: toStream(new Uint8Array(10)), size: 10 },
      3600, "https://example.com",
      { siteHostSuffix: ".serve.example.com" },
    );
    expect(archive.siteUrl).toBe(`https://${archive.asset.id}.serve.example.com/`);

    // A single file is not a site, and without a suffix there is no host.
    const plain = await uploadAsset(
      writes, mockStorage(),
      { name: "a.txt", type: "text/plain", body: toStream(new Uint8Array(3)), size: 3 },
      3600, "https://example.com",
      { siteHostSuffix: ".serve.example.com" },
    );
    expect(plain.siteUrl).toBeUndefined();

    const unconfigured = await uploadAsset(
      writes, mockStorage(),
      { name: "site.zip", type: "application/zip", body: toStream(new Uint8Array(10)), size: 10 },
      3600, "https://example.com",
    );
    expect(unconfigured.siteUrl).toBeUndefined();
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

  // --- ADR-017 §1–§2: integrity ---

  test("uploadAsset records the store's hash as verified when none is declared", async () => {
    const { writes, calls } = mockWrites();
    const st = mockStorage();

    const result = await uploadAsset(
      writes, st,
      { name: "a.txt", type: "text/plain", body: toStream(new Uint8Array(3)), size: 3 },
      3600, "https://example.com",
    );

    expect(vi.mocked(st.put).mock.calls[0][4]?.sha256).toBeUndefined();
    expect(result.asset.sha256).toBe(COMPUTED_SHA256);
    expect(result.asset.integrity).toBe("verified");
    expect(calls[0].asset.sha256).toBe(COMPUTED_SHA256);
  });

  test("uploadAsset hands a declared hash to the store and records it", async () => {
    const { writes, calls } = mockWrites();
    const st = mockStorage();

    await uploadAsset(
      writes, st,
      { name: "a.txt", type: "text/plain", body: toStream(new Uint8Array(3)), size: 3, sha256: DECLARED_SHA256 },
      3600, "https://example.com",
    );

    expect(vi.mocked(st.put).mock.calls[0][4]?.sha256).toBe(DECLARED_SHA256);
    expect(calls[0].asset.sha256).toBe(DECLARED_SHA256);
    expect(calls[0].asset.integrity).toBe("verified");
  });

  test("uploadAsset writes no row when the store rejects the declared hash", async () => {
    const { ChecksumMismatchError } = await import("../integrity");
    const { writes } = mockWrites();
    const st = mockStorage();
    vi.mocked(st.put).mockRejectedValueOnce(new ChecksumMismatchError(DECLARED_SHA256));

    await expect(uploadAsset(
      writes, st,
      { name: "a.txt", type: "text/plain", body: toStream(new Uint8Array(3)), size: 3, sha256: DECLARED_SHA256 },
      3600, "https://example.com",
    )).rejects.toBeInstanceOf(ChecksumMismatchError);
    expect(writes.createAsset).not.toHaveBeenCalled();
  });
}
