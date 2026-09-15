import type { AssetMetadata, AssetUploadResult, UploadPart, UploadSession } from "../model";
import { detectArchiveFormat } from "../model";
import type { AtomicWrites, FileStorage, PresignedUrlGenerator, UploadSessionStore } from "../repository";
import type { Job } from "../../job/model";
import { storageKey } from "./shared";
import { siteUrlFor } from "../../site/url";
import { enqueueThumbnail } from "../../thumbnail/queue";
import type { ThumbnailMessage } from "../../thumbnail/queue";
import type { JobQueue } from "../../queue/port";
import type { ExtractionMessage } from "../../extraction/handler";

export async function completeUploadSession(
  sessions: UploadSessionStore,
  writes: AtomicWrites,
  storage: FileStorage,
  presignedUrls: PresignedUrlGenerator | null,
  id: string,
  ttlSeconds: number,
  baseUrl: string,
  parts?: UploadPart[],
  options?: { sessionId?: string | null; projectId?: string | null; extractionQueue?: JobQueue<ExtractionMessage> | null; thumbnailQueue?: JobQueue<ThumbnailMessage> | null; skipExtraction?: boolean; usageScopes?: string[]; siteHostSuffix?: string },
): Promise<AssetUploadResult | null> {
  const session = await sessions.find(id);
  if (!session) return null;

  // Verify session ownership
  if (session.sessionId && options?.sessionId && session.sessionId !== options.sessionId) return null;

  const key = storageKey(id, session.filename);

  // Complete multipart upload first if needed
  if (session.s3UploadId) {
    if (!parts || parts.length === 0) return null;
    if (!presignedUrls) return null;
    await presignedUrls.completeMultipartUpload(key, session.s3UploadId, parts);
  }

  const head = await storage.head(key);
  if (!head) return null;

  const archiveFormat = detectArchiveFormat(session.filename);
  const now = Date.now();

  // projectId is bound at createUploadSession time (after membership check)
  // and re-verified by the handler before we get here; use the session's copy
  // so client headers can't retarget an anon session to a different project.
  const projectId = session.projectId ?? options?.projectId ?? null;

  const asset: AssetMetadata = {
    id,
    filename: session.filename,
    contentType: session.contentType,
    size: head.size,
    createdAt: session.createdAt,
    expiresAt: projectId ? 0 : now + ttlSeconds * 1000,
    ...(head.contentEncoding && { contentEncoding: head.contentEncoding }),
    ...(head.contentEncoding && session.size && { originalSize: session.size }),
    ...(archiveFormat && {
      type: "archive" as const,
      ...(!session.skipExtraction && { status: "pending" as const }),
      archiveFormat,
    }),
    ...(options?.sessionId && { sessionId: options.sessionId }),
    ...(projectId && { projectId }),
  };

  // Create extraction job for archives (unless skipped)
  let job: Job | undefined;
  if (archiveFormat && !session.skipExtraction) {
    job = {
      id,
      assetId: id,
      type: "archive-extraction",
      status: "pending",
      createdAt: now,
      updatedAt: now,
      ...(options?.sessionId && { sessionId: options.sessionId }),
      ...(projectId && { projectId }),
    };
    asset.jobId = id;
  }

  try {
    // Job row, asset row and storage-usage counters in one atomic write (ADR-012 §3).
    await writes.createAsset({ asset, job, usageScopes: projectId ? options?.usageScopes : [] });

    // Enqueue only after the rows are committed: the consumer reads them.
    if (job && archiveFormat && options?.extractionQueue) {
      try {
        await options.extractionQueue.send({
          assetId: id,
          archiveKey: key,
          archiveFilename: session.filename,
          archiveFormat,
        });
      } catch (e) {
        console.error("Failed to enqueue extraction:", e);
      }
    }

    await enqueueThumbnail(options?.thumbnailQueue ?? null, {
      assetId: id,
      sourceKey: key,
      contentType: asset.contentType,
      size: asset.size,
    });
  } catch (e) {
    // R2 already holds the uploaded body but the D1 metadata row failed to
    // persist. Cleanup is driven off D1, so without compensation the R2
    // object would never be reclaimed.
    try {
      await storage.delete(key);
    } catch (delErr) {
      console.error("Failed to clean up R2 object after metadata save failure:", delErr);
    }
    throw e;
  }
  await sessions.delete(id);

  const siteUrl = siteUrlFor({
    assetId: id,
    baseUrl,
    siteHostSuffix: options?.siteHostSuffix,
    archive: Boolean(archiveFormat),
  });

  return {
    asset,
    url: `${baseUrl}/files/${id}/${encodeURIComponent(session.filename)}`,
    ...(siteUrl && { siteUrl }),
  };
}

if (import.meta.vitest) {
  const { test, expect, vi } = import.meta.vitest;

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

  function mockStorage(headResult: { size: number; contentEncoding?: string } | null = null): FileStorage {
    return {
      put: vi.fn(async () => {}),
      get: vi.fn(async () => null),
      head: vi.fn(async () => headResult),
      delete: vi.fn(async () => {}),
      list: vi.fn(async () => ({ keys: [], cursor: undefined })),
    };
  }

  function mockSessions(): UploadSessionStore {
    const store = new Map<string, UploadSession>();
    return {
      save: vi.fn(async (session: UploadSession, _ttl: number) => { store.set(session.id, session); }),
      find: vi.fn(async (id: string) => store.get(id) ?? null),
      delete: vi.fn(async (id: string) => { store.delete(id); }),
    };
  }

  function mockPresignedUrls(): PresignedUrlGenerator {
    return {
      generatePutUrl: vi.fn(async (key: string, _ct: string, _exp: number) => `https://r2.example.com/${key}?signed=true`),
      createMultipartUpload: vi.fn(async () => "mp-upload-id"),
      generateUploadPartUrl: vi.fn(async (key: string, _uid: string, part: number, _exp: number) => `https://r2.example.com/${key}?partNumber=${part}`),
      completeMultipartUpload: vi.fn(async () => {}),
      abortMultipartUpload: vi.fn(async () => {}),
    };
  }


  test("completeUploadSession finalizes single upload when file exists", async () => {
    const sessions = mockSessions();
    const { writes, calls } = mockWrites();
    const st = mockStorage({ size: 100 });
    const presigned = mockPresignedUrls();

    const { createUploadSession } = await import("./create-upload-session");
    const session = await createUploadSession(
      sessions, presigned,
      { filename: "data.bin", contentType: "application/octet-stream", size: 100 },
      3600,
    );

    const result = await completeUploadSession(sessions, writes, st, presigned, session.uploadId, 3600, "https://example.com");

    expect(result).not.toBeNull();
    expect(result!.asset.id).toBe(session.uploadId);
    expect(result!.asset.filename).toBe("data.bin");
    expect(result!.url).toContain("/files/");
    expect(result!.asset.type).toBeUndefined();
    expect(writes.createAsset).toHaveBeenCalledOnce();
    expect(sessions.delete).toHaveBeenCalledOnce();
    expect(presigned.completeMultipartUpload).not.toHaveBeenCalled();
    expect(calls[0].job).toBeUndefined();
  });

  test("completeUploadSession finalizes multipart upload with parts", async () => {
    const sessions = mockSessions();
    const { writes, calls } = mockWrites();
    const st = mockStorage({ size: 1000 });
    const presigned = mockPresignedUrls();

    const { createUploadSession } = await import("./create-upload-session");
    const session = await createUploadSession(
      sessions, presigned,
      { filename: "huge.tar", contentType: "application/x-tar", size: 10_000_000_000, partCount: 2 },
      3600,
    );

    const parts = [
      { partNumber: 1, etag: '"etag1"' },
      { partNumber: 2, etag: '"etag2"' },
    ];

    const result = await completeUploadSession(sessions, writes, st, presigned, session.uploadId, 3600, "https://example.com", parts);

    expect(result).not.toBeNull();
    expect(result!.asset.filename).toBe("huge.tar");
    expect(result!.asset.type).toBe("archive");
    expect(result!.asset.status).toBe("pending");
    expect(result!.asset.archiveFormat).toBe("tar");
    expect(result!.asset.jobId).toBeDefined();
    expect(presigned.completeMultipartUpload).toHaveBeenCalledOnce();
    expect(writes.createAsset).toHaveBeenCalledOnce();
    expect(calls[0].job).toBeDefined();
  });

  test("completeUploadSession returns null for multipart without parts", async () => {
    const sessions = mockSessions();
    const { writes, calls } = mockWrites();
    const st = mockStorage({ size: 1000 });
    const presigned = mockPresignedUrls();

    const { createUploadSession } = await import("./create-upload-session");
    const session = await createUploadSession(
      sessions, presigned,
      { filename: "huge.tar", contentType: "application/x-tar", size: 10_000_000_000, partCount: 2 },
      3600,
    );

    const result = await completeUploadSession(sessions, writes, st, presigned, session.uploadId, 3600, "https://example.com");
    expect(result).toBeNull();
  });

  test("completeUploadSession returns null if session not found", async () => {
    const sessions = mockSessions();
    const { writes, calls } = mockWrites();
    const st = mockStorage();

    const result = await completeUploadSession(sessions, writes, st, null, "nonexistent", 3600, "https://example.com");
    expect(result).toBeNull();
  });

  test("completeUploadSession returns null if file not uploaded", async () => {
    const sessions = mockSessions();
    const { writes, calls } = mockWrites();
    const st = mockStorage(); // head returns null
    const presigned = mockPresignedUrls();

    const { createUploadSession } = await import("./create-upload-session");
    const session = await createUploadSession(
      sessions, presigned,
      { filename: "pending.bin", contentType: "application/octet-stream", size: 50 },
      3600,
    );

    const result = await completeUploadSession(sessions, writes, st, presigned, session.uploadId, 3600, "https://example.com");
    expect(result).toBeNull();
  });
}
