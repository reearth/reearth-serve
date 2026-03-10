import type { MultipartUploadResult, PresignedUploadResult, UploadSession } from "../model";
import type { PresignedUrlGenerator, UploadSessionStore } from "../repository";
import { generateId, storageKey } from "./shared";

export async function createUploadSession(
  sessions: UploadSessionStore,
  presignedUrls: PresignedUrlGenerator,
  params: { filename: string; contentType: string; size: number; partCount?: number },
  ttlSeconds: number,
): Promise<PresignedUploadResult | MultipartUploadResult> {
  const id = generateId();
  const now = Date.now();
  const urlExpirySeconds = Math.min(ttlSeconds, 3600);
  const contentType = params.contentType || "application/octet-stream";
  const key = storageKey(id, params.filename);

  // Multipart upload
  if (params.partCount && params.partCount > 1) {
    const s3UploadId = await presignedUrls.createMultipartUpload(key, contentType);

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
    };

    await sessions.save(session, urlExpirySeconds);

    return {
      uploadId: id,
      parts: partUrls,
      expiresAt: session.expiresAt,
    };
  }

  // Single PUT upload
  const url = await presignedUrls.generatePutUrl(key, contentType, urlExpirySeconds);

  const session: UploadSession = {
    id,
    filename: params.filename,
    contentType,
    size: params.size,
    createdAt: now,
    expiresAt: now + urlExpirySeconds * 1000,
  };

  await sessions.save(session, urlExpirySeconds);

  return {
    uploadId: id,
    url,
    method: "PUT",
    headers: { "Content-Type": contentType },
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
      generatePutUrl: vi.fn(async (key: string, _ct: string, _exp: number) => `https://r2.example.com/${key}?signed=true`),
      createMultipartUpload: vi.fn(async (_key: string, _ct: string) => "mp-upload-id-123"),
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
    expect(sessions.save).toHaveBeenCalledOnce();
    expect(presigned.generatePutUrl).toHaveBeenCalledOnce();
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
    expect(multi.uploadId).toBeTypeOf("string");
    expect(multi.parts).toHaveLength(3);
    expect(multi.parts[0].partNumber).toBe(1);
    expect(multi.parts[0].url).toContain("partNumber=1");
    expect(multi.parts[2].partNumber).toBe(3);
    expect(presigned.createMultipartUpload).toHaveBeenCalledOnce();
    expect(presigned.generateUploadPartUrl).toHaveBeenCalledTimes(3);
    expect(sessions.save).toHaveBeenCalledOnce();
  });
}
