import type { AssetMetadata, AssetUploadResult, UploadPart, UploadSession } from "../model";
import type { FileStorage, MetadataStore, PresignedUrlGenerator, UploadSessionStore } from "../repository";
import { storageKey } from "./shared";

export async function completeUploadSession(
  sessions: UploadSessionStore,
  metadata: MetadataStore,
  storage: FileStorage,
  presignedUrls: PresignedUrlGenerator | null,
  id: string,
  ttlSeconds: number,
  baseUrl: string,
  parts?: UploadPart[],
): Promise<AssetUploadResult | null> {
  const session = await sessions.find(id);
  if (!session) return null;

  const key = storageKey(id, session.filename);

  // Complete multipart upload first if needed
  if (session.s3UploadId) {
    if (!parts || parts.length === 0) return null;
    if (!presignedUrls) return null;
    await presignedUrls.completeMultipartUpload(key, session.s3UploadId, parts);
  }

  const head = await storage.head(key);
  if (!head) return null;

  const asset: AssetMetadata = {
    id,
    filename: session.filename,
    contentType: session.contentType,
    size: head.size,
    createdAt: session.createdAt,
    expiresAt: Date.now() + ttlSeconds * 1000,
  };

  await metadata.save(asset, ttlSeconds);
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
      get: vi.fn(async () => null),
      head: vi.fn(async (key: string) => {
        const buf = store.get(key);
        if (!buf) return null;
        return { size: buf.byteLength };
      }),
      delete: vi.fn(async (key: string) => { store.delete(key); }),
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
    const md = mockMetadata();
    const st = mockStorage();
    const presigned = mockPresignedUrls();

    const { createUploadSession } = await import("./create-upload-session");
    const session = await createUploadSession(
      sessions, presigned,
      { filename: "data.bin", contentType: "application/octet-stream", size: 100 },
      3600,
    );

    const key = `assets/${session.uploadId}/data.bin`;
    await st.put(key, new ArrayBuffer(100), "application/octet-stream");

    const result = await completeUploadSession(sessions, md, st, presigned, session.uploadId, 3600, "https://example.com");

    expect(result).not.toBeNull();
    expect(result!.asset.id).toBe(session.uploadId);
    expect(result!.asset.filename).toBe("data.bin");
    expect(result!.url).toContain("/files/");
    expect(md.save).toHaveBeenCalledOnce();
    expect(sessions.delete).toHaveBeenCalledOnce();
    // Single upload: completeMultipartUpload should NOT be called
    expect(presigned.completeMultipartUpload).not.toHaveBeenCalled();
  });

  test("completeUploadSession finalizes multipart upload with parts", async () => {
    const sessions = mockSessions();
    const md = mockMetadata();
    const st = mockStorage();
    const presigned = mockPresignedUrls();

    const { createUploadSession } = await import("./create-upload-session");
    const session = await createUploadSession(
      sessions, presigned,
      { filename: "huge.tar", contentType: "application/x-tar", size: 10_000_000_000, partCount: 2 },
      3600,
    );

    // Simulate: multipart upload completed, file now in R2
    const key = `assets/${session.uploadId}/huge.tar`;
    await st.put(key, new ArrayBuffer(1000), "application/x-tar");

    const parts = [
      { partNumber: 1, etag: '"etag1"' },
      { partNumber: 2, etag: '"etag2"' },
    ];

    const result = await completeUploadSession(sessions, md, st, presigned, session.uploadId, 3600, "https://example.com", parts);

    expect(result).not.toBeNull();
    expect(result!.asset.filename).toBe("huge.tar");
    expect(presigned.completeMultipartUpload).toHaveBeenCalledOnce();
    expect(md.save).toHaveBeenCalledOnce();
  });

  test("completeUploadSession returns null for multipart without parts", async () => {
    const sessions = mockSessions();
    const md = mockMetadata();
    const st = mockStorage();
    const presigned = mockPresignedUrls();

    const { createUploadSession } = await import("./create-upload-session");
    const session = await createUploadSession(
      sessions, presigned,
      { filename: "huge.tar", contentType: "application/x-tar", size: 10_000_000_000, partCount: 2 },
      3600,
    );

    // Try to complete multipart session without providing parts
    const result = await completeUploadSession(sessions, md, st, presigned, session.uploadId, 3600, "https://example.com");
    expect(result).toBeNull();
  });

  test("completeUploadSession returns null if session not found", async () => {
    const sessions = mockSessions();
    const md = mockMetadata();
    const st = mockStorage();

    const result = await completeUploadSession(sessions, md, st, null, "nonexistent", 3600, "https://example.com");
    expect(result).toBeNull();
  });

  test("completeUploadSession returns null if file not uploaded", async () => {
    const sessions = mockSessions();
    const md = mockMetadata();
    const st = mockStorage();
    const presigned = mockPresignedUrls();

    const { createUploadSession } = await import("./create-upload-session");
    const session = await createUploadSession(
      sessions, presigned,
      { filename: "pending.bin", contentType: "application/octet-stream", size: 50 },
      3600,
    );

    const result = await completeUploadSession(sessions, md, st, presigned, session.uploadId, 3600, "https://example.com");
    expect(result).toBeNull();
  });
}
