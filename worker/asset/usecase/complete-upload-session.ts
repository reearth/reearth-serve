import type { AssetMetadata, AssetUploadResult, UploadPart, UploadSession } from "../model";
import { detectArchiveFormat } from "../model";
import type { FileStorage, MetadataStore, PresignedUrlGenerator, UploadSessionStore } from "../repository";
import type { JobStore } from "../../job/repository";
import type { Job } from "../../job/model";
import { storageKey } from "./shared";
import { enqueueThumbnail } from "../../thumbnail/queue";

export async function completeUploadSession(
  sessions: UploadSessionStore,
  metadata: MetadataStore,
  storage: FileStorage,
  presignedUrls: PresignedUrlGenerator | null,
  jobs: JobStore,
  id: string,
  ttlSeconds: number,
  baseUrl: string,
  parts?: UploadPart[],
  options?: { sessionId?: string | null; projectId?: string | null; extractionQueue?: Queue | null; thumbnailQueue?: Queue | null; skipExtraction?: boolean },
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

  try {
    // Create extraction job for archives (unless skipped)
    if (archiveFormat && !session.skipExtraction) {
      const job: Job = {
        id,
        assetId: id,
        type: "archive-extraction",
        status: "pending",
        createdAt: now,
        updatedAt: now,
        ...(options?.sessionId && { sessionId: options.sessionId }),
        ...(projectId && { projectId }),
      };
      await jobs.save(job);
      asset.jobId = id;

      // Enqueue extraction job
      if (options?.extractionQueue) {
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
    }

    await metadata.save(asset, options?.projectId ? 0 : ttlSeconds);

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

  return {
    asset,
    url: `${baseUrl}/files/${id}/${encodeURIComponent(session.filename)}`,
  };
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

  function mockJobs(): JobStore {
    const store = new Map<string, Job>();
    return {
      save: vi.fn(async (job: Job) => { store.set(job.id, job); }),
      find: vi.fn(async (id: string) => store.get(id) ?? null),
      delete: vi.fn(async (id: string) => { store.delete(id); }),
      list: vi.fn(async () => ({ items: [], cursor: undefined })),
    };
  }

  test("completeUploadSession finalizes single upload when file exists", async () => {
    const sessions = mockSessions();
    const md = mockMetadata();
    const st = mockStorage({ size: 100 });
    const presigned = mockPresignedUrls();
    const jb = mockJobs();

    const { createUploadSession } = await import("./create-upload-session");
    const session = await createUploadSession(
      sessions, presigned,
      { filename: "data.bin", contentType: "application/octet-stream", size: 100 },
      3600,
    );

    const result = await completeUploadSession(sessions, md, st, presigned, jb, session.uploadId, 3600, "https://example.com");

    expect(result).not.toBeNull();
    expect(result!.asset.id).toBe(session.uploadId);
    expect(result!.asset.filename).toBe("data.bin");
    expect(result!.url).toContain("/files/");
    expect(result!.asset.type).toBeUndefined();
    expect(md.save).toHaveBeenCalledOnce();
    expect(sessions.delete).toHaveBeenCalledOnce();
    expect(presigned.completeMultipartUpload).not.toHaveBeenCalled();
    expect(jb.save).not.toHaveBeenCalled();
  });

  test("completeUploadSession finalizes multipart upload with parts", async () => {
    const sessions = mockSessions();
    const md = mockMetadata();
    const st = mockStorage({ size: 1000 });
    const presigned = mockPresignedUrls();
    const jb = mockJobs();

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

    const result = await completeUploadSession(sessions, md, st, presigned, jb, session.uploadId, 3600, "https://example.com", parts);

    expect(result).not.toBeNull();
    expect(result!.asset.filename).toBe("huge.tar");
    expect(result!.asset.type).toBe("archive");
    expect(result!.asset.status).toBe("pending");
    expect(result!.asset.archiveFormat).toBe("tar");
    expect(result!.asset.jobId).toBeDefined();
    expect(presigned.completeMultipartUpload).toHaveBeenCalledOnce();
    expect(md.save).toHaveBeenCalledOnce();
    expect(jb.save).toHaveBeenCalledOnce();
  });

  test("completeUploadSession returns null for multipart without parts", async () => {
    const sessions = mockSessions();
    const md = mockMetadata();
    const st = mockStorage({ size: 1000 });
    const presigned = mockPresignedUrls();
    const jb = mockJobs();

    const { createUploadSession } = await import("./create-upload-session");
    const session = await createUploadSession(
      sessions, presigned,
      { filename: "huge.tar", contentType: "application/x-tar", size: 10_000_000_000, partCount: 2 },
      3600,
    );

    const result = await completeUploadSession(sessions, md, st, presigned, jb, session.uploadId, 3600, "https://example.com");
    expect(result).toBeNull();
  });

  test("completeUploadSession returns null if session not found", async () => {
    const sessions = mockSessions();
    const md = mockMetadata();
    const st = mockStorage();
    const jb = mockJobs();

    const result = await completeUploadSession(sessions, md, st, null, jb, "nonexistent", 3600, "https://example.com");
    expect(result).toBeNull();
  });

  test("completeUploadSession returns null if file not uploaded", async () => {
    const sessions = mockSessions();
    const md = mockMetadata();
    const st = mockStorage(); // head returns null
    const presigned = mockPresignedUrls();
    const jb = mockJobs();

    const { createUploadSession } = await import("./create-upload-session");
    const session = await createUploadSession(
      sessions, presigned,
      { filename: "pending.bin", contentType: "application/octet-stream", size: 50 },
      3600,
    );

    const result = await completeUploadSession(sessions, md, st, presigned, jb, session.uploadId, 3600, "https://example.com");
    expect(result).toBeNull();
  });
}
