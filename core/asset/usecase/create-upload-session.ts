import type { MultipartUploadResult, PresignedUploadResult, UploadSession } from "../model";
import type { PresignedPut, PresignedUrlGenerator, UploadSessionStore } from "../repository";
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
  params: { filename: string; contentType: string; size: number; partCount?: number; sha256?: string },
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
  const sha256 = params.sha256?.toLowerCase();

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
      // The store checks parts, not the whole object, so a multipart upload's
      // declared hash is recorded `pending` at completion and confirmed by
      // the verification job (ADR-017 §2).
      ...(sha256 && { sha256 }),
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

  // Single PUT upload. A declared hash is signed into the URL so the store
  // verifies the body on write (ADR-017 §2); the header that carries it comes
  // back from the generator and is handed to the client below.
  const put = await presignedUrls.generatePutUrl(key, contentType, urlExpirySeconds, {
    ...encodingOpts,
    ...(sha256 && { sha256 }),
  });

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
    ...(sha256 && { sha256 }),
  };

  await sessions.save(session, urlExpirySeconds);

  const headers: Record<string, string> = { "Content-Type": contentType, ...put.headers };
  if (compress) headers["Content-Encoding"] = "gzip";

  return {
    uploadId: id,
    url: put.url,
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
      generatePutUrl: vi.fn(async (key: string, _ct: string, _exp: number, opts?: { contentEncoding?: string; sha256?: string }): Promise<PresignedPut> => ({
        url: `https://r2.example.com/${key}?signed=true`,
        headers: opts?.sha256 ? { "x-amz-checksum-sha256": `b64(${opts.sha256})` } : {},
      })),
      createMultipartUpload: vi.fn(async (_key: string, _ct: string, _opts?: { contentEncoding?: string }) => "mp-upload-id-123"),
      generateUploadPartUrl: vi.fn(async (key: string, _uid: string, part: number, _exp: number) => `https://r2.example.com/${key}?partNumber=${part}&signed=true`),
      completeMultipartUpload: vi.fn(async () => {}),
      abortMultipartUpload: vi.fn(async () => {}),
    };
  }

  test("upload session body rejects filenames that escape the asset prefix", async () => {
    const { createUploadSessionBodySchema } = await import("../../../shared/api");
    for (const filename of ["../victim/data.geojson", "a/b.txt", "a\\b.txt", "..", ".", "", "x\u0000.txt"]) {
      expect(createUploadSessionBodySchema.safeParse({ filename, size: 1 }).success, filename).toBe(false);
    }
    expect(createUploadSessionBodySchema.safeParse({ filename: "my file..v2.json", size: 1 }).success).toBe(true);
  });

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

  test("createUploadSession signs a declared sha256 into a single PUT and tells the client the header", async () => {
    const sessions = mockSessions();
    const presigned = mockPresignedUrls();
    const declared = "AB".repeat(32);

    const result = await createUploadSession(
      sessions, presigned,
      { filename: "big.zip", contentType: "application/zip", size: 1000, sha256: declared },
      3600,
    ) as PresignedUploadResult;

    expect(vi.mocked(presigned.generatePutUrl).mock.calls[0][3]).toEqual({ sha256: declared.toLowerCase() });
    expect(result.headers["x-amz-checksum-sha256"]).toBe(`b64(${declared.toLowerCase()})`);
    const saved = vi.mocked(sessions.save).mock.calls[0][0];
    expect(saved.sha256).toBe(declared.toLowerCase());
  });

  test("createUploadSession records a declared sha256 on a multipart session", async () => {
    const sessions = mockSessions();
    const presigned = mockPresignedUrls();

    await createUploadSession(
      sessions, presigned,
      { filename: "huge.tar", contentType: "application/x-tar", size: 10_000_000_000, partCount: 3, sha256: "c".repeat(64) },
      3600,
    );

    expect(vi.mocked(sessions.save).mock.calls[0][0].sha256).toBe("c".repeat(64));
  });

  test("upload session body accepts only a hex sha256", async () => {
    const { createUploadSessionBodySchema } = await import("../../../shared/api");
    expect(createUploadSessionBodySchema.safeParse({ filename: "a", size: 1, sha256: "A".repeat(64) }).success).toBe(true);
    expect(createUploadSessionBodySchema.safeParse({ filename: "a", size: 1, sha256: "g".repeat(64) }).success).toBe(false);
    expect(createUploadSessionBodySchema.safeParse({ filename: "a", size: 1, sha256: "a".repeat(63) }).success).toBe(false);
  });
}
