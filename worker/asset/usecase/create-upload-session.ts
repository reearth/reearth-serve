import type { MultipartUploadResult, PresignedUploadResult, UploadSession } from "../model";
import type { PresignedUrlGenerator, UploadSessionStore } from "../repository";
import { shouldCompress } from "../compression";
import { generateId, storageKey } from "./shared";

// Upload window: scale with declared size so multi-GB archives uploaded over
// slow links don't have their presigned URLs (and the KV session that the
// complete call needs) expire mid-transfer. 2 MiB/s is a deliberately
// conservative floor; the cap keeps capability URLs from living for days.
// R2 itself allows presigned expiry up to 7 days.
const MIN_UPLOAD_EXPIRY_SECONDS = 3600; // 1 hour
const MAX_UPLOAD_EXPIRY_SECONDS = 24 * 3600; // 24 hours
const ASSUMED_UPLOAD_BYTES_PER_SECOND = 2 * 1024 * 1024;

export function uploadExpirySeconds(size: number): number {
  return Math.min(
    MAX_UPLOAD_EXPIRY_SECONDS,
    Math.max(MIN_UPLOAD_EXPIRY_SECONDS, Math.ceil(size / ASSUMED_UPLOAD_BYTES_PER_SECOND)),
  );
}

export async function createUploadSession(
  sessions: UploadSessionStore,
  presignedUrls: PresignedUrlGenerator,
  params: { filename: string; contentType: string; size: number; partCount?: number },
  _ttlSeconds: number,
  options?: { sessionId?: string | null; projectId?: string | null; skipExtraction?: boolean },
): Promise<PresignedUploadResult | MultipartUploadResult> {
  const id = generateId();
  const now = Date.now();
  const urlExpirySeconds = uploadExpirySeconds(params.size);
  const contentType = params.contentType || "application/octet-stream";
  const key = storageKey(id, params.filename);
  const compress = shouldCompress(params.filename, params.size);
  const encodingOpts = compress ? { contentEncoding: "gzip" as const } : undefined;

  // Multipart upload
  if (params.partCount && params.partCount > 1) {
    const s3UploadId = await presignedUrls.createMultipartUpload(key, contentType, encodingOpts);

    const partUrls = await Promise.all(
      Array.from({ length: params.partCount }, (_, i) =>
        presignedUrls.generateUploadPartUrl(key, s3UploadId, i + 1, urlExpirySeconds)
          .then((url) => ({ partNumber: i + 1, url })),
      ),
    );

    const session: UploadSession = {
      id,
      filename: params.filename,
      contentType,
      size: params.size,
      createdAt: now,
      expiresAt: now + urlExpirySeconds * 1000,
      s3UploadId,
      partCount: params.partCount,
      ...(compress && { contentEncoding: "gzip" }),
      ...(options?.sessionId && { sessionId: options.sessionId }),
      ...(options?.projectId && { projectId: options.projectId }),
      ...(options?.skipExtraction && { skipExtraction: true }),
    };

    await sessions.save(session, urlExpirySeconds);

    return {
      uploadId: id,
      parts: partUrls,
      ...(compress && { contentEncoding: "gzip" }),
      expiresAt: session.expiresAt,
    };
  }

  // Single PUT upload
  const url = await presignedUrls.generatePutUrl(key, contentType, urlExpirySeconds, encodingOpts);

  const session: UploadSession = {
    id,
    filename: params.filename,
    contentType,
    size: params.size,
    createdAt: now,
    expiresAt: now + urlExpirySeconds * 1000,
    ...(compress && { contentEncoding: "gzip" }),
    ...(options?.sessionId && { sessionId: options.sessionId }),
    ...(options?.projectId && { projectId: options.projectId }),
  };

  await sessions.save(session, urlExpirySeconds);

  const headers: Record<string, string> = { "Content-Type": contentType };
  if (compress) headers["Content-Encoding"] = "gzip";

  return {
    uploadId: id,
    url,
    method: "PUT",
    headers,
    ...(compress && { contentEncoding: "gzip" }),
    expiresAt: session.expiresAt,
  };
}

if (import.meta.vitest) {
  const { test, expect, vi } = import.meta.vitest;

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
      generatePutUrl: vi.fn(async (key: string, _ct: string, _exp: number, _opts?: { contentEncoding?: string }) => `https://r2.example.com/${key}?signed=true`),
      createMultipartUpload: vi.fn(async (_key: string, _ct: string, _opts?: { contentEncoding?: string }) => "mp-upload-id-123"),
      generateUploadPartUrl: vi.fn(async (key: string, _uid: string, part: number, _exp: number) => `https://r2.example.com/${key}?partNumber=${part}&signed=true`),
      completeMultipartUpload: vi.fn(async () => {}),
      abortMultipartUpload: vi.fn(async () => {}),
    };
  }

  test("createUploadSession returns presigned URL for single upload", async () => {
    const sessions = mockSessions();
    const presigned = mockPresignedUrls();

    const result = await createUploadSession(
      sessions, presigned,
      { filename: "big.zip", contentType: "application/zip", size: 1_000_000_000 },
      3600,
    );

    expect("url" in result).toBe(true);
    const single = result as PresignedUploadResult;
    expect(single.uploadId).toBeTypeOf("string");
    expect(single.url).toContain("signed=true");
    expect(single.method).toBe("PUT");
    expect(single.contentEncoding).toBeUndefined(); // zip is not compressible
    expect(sessions.save).toHaveBeenCalledOnce();
  });

  test("createUploadSession returns contentEncoding for compressible file", async () => {
    const sessions = mockSessions();
    const presigned = mockPresignedUrls();

    const result = await createUploadSession(
      sessions, presigned,
      { filename: "data.json", contentType: "application/json", size: 5000 },
      3600,
    );

    expect("url" in result).toBe(true);
    const single = result as PresignedUploadResult;
    expect(single.contentEncoding).toBe("gzip");
    expect(single.headers["Content-Encoding"]).toBe("gzip");
  });

  test("createUploadSession returns part URLs for multipart upload", async () => {
    const sessions = mockSessions();
    const presigned = mockPresignedUrls();

    const result = await createUploadSession(
      sessions, presigned,
      { filename: "huge.tar", contentType: "application/x-tar", size: 10_000_000_000, partCount: 3 },
      3600,
    );

    expect("parts" in result).toBe(true);
    const multi = result as MultipartUploadResult;
    expect(multi.parts).toHaveLength(3);
    expect(multi.contentEncoding).toBeUndefined(); // tar is not compressible
  });

  test("createUploadSession multipart with compressible file", async () => {
    const sessions = mockSessions();
    const presigned = mockPresignedUrls();

    const result = await createUploadSession(
      sessions, presigned,
      { filename: "big.geojson", contentType: "application/geo+json", size: 500_000_000, partCount: 3 },
      3600,
    );

    expect("parts" in result).toBe(true);
    const multi = result as MultipartUploadResult;
    expect(multi.contentEncoding).toBe("gzip");
    expect(presigned.createMultipartUpload).toHaveBeenCalledWith(
      expect.any(String), "application/geo+json", { contentEncoding: "gzip" },
    );
  });
}
