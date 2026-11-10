import type { MultipartUploadResult, PresignedUploadResult, UploadSession } from "../model";
import type { FileStorage, PresignedPut, PresignedUrlGenerator, UploadSessionStore } from "../repository";
import { shouldCompress } from "../compression";
import { generateId, storageKey } from "./shared";
import { placeSessionUpload, type BlobContext, type Placement } from "../../blob/usecase";
import type { BlobRefKey } from "../../blob/model";

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
  params: {
    filename: string; contentType: string; size: number; partCount?: number; sha256?: string;
    /**
     * The encoding the client states it will upload (ADR-017 P5). Honoured as
     * given; omitted, the server decides with `shouldCompress`.
     */
    contentEncoding?: "gzip" | "identity";
  },
  _ttlSeconds: number,
  options?: {
    sessionId?: string | null; projectId?: string | null; skipExtraction?: boolean;
    /** Blob ledger and scope: a declared upload claims its blob key (ADR-017 §3). Omitted, it does not. */
    blob?: BlobContext;
    /**
     * The object store, to look at bytes the scope already holds before a
     * gzip session reuses them (`isGzipBlob`). Without it such a session does
     * not reuse.
     */
    storage?: FileStorage;
  },
): Promise<PresignedUploadResult | MultipartUploadResult> {
  const id = generateId();
  const now = Date.now();
  const urlExpirySeconds = uploadExpirySeconds(params.size);
  const contentType = params.contentType || "application/octet-stream";
  // A stated encoding is the client's description of the bytes its declared
  // hash names, exactly like a direct upload's `Content-Encoding`; without
  // one the encoding is the server's decision and the client is told it.
  const stated = params.contentEncoding !== undefined;
  const compress = stated ? params.contentEncoding === "gzip" : shouldCompress(params.filename, params.size);
  const sha256 = params.sha256?.toLowerCase();
  const expiresAt = now + urlExpirySeconds * 1000;

  // Neither a multipart upload nor (on R2, unconfirmed) a presigned single PUT
  // is verified by the store as it is written, so a declared hash claims the
  // blob key for the session's lifetime instead of just reserving it. A live
  // claim by another session throws `BlobClaimedError` (409). Bytes the scope
  // already holds are reused with no transfer (ADR-017 §4); bytes that cannot
  // be reused (unverified, being deleted) send this upload to the classic key.
  const placement: Placement = options?.blob
    ? await placeSessionUpload(
      options.blob.refs, options.blob.scope, sha256, storageKey(id, params.filename), { id, expiresAt }, now,
      compress && !stated ? (key) => isGzipBlob(options.storage, key) : undefined,
    )
    : { key: storageKey(id, params.filename) };
  if (placement.reuse && placement.ref) {
    return startReuseSession(sessions, {
      id, now, expiresAt, urlExpirySeconds, contentType, compress, sha256: placement.ref.sha256, ref: placement.ref,
      filename: params.filename, size: params.size,
    }, options);
  }
  try {
    return await startSession(sessions, presignedUrls, {
      id, now, expiresAt, urlExpirySeconds, contentType, compress, sha256, placement,
      filename: params.filename, size: params.size, partCount: params.partCount,
    }, options);
  } catch (e) {
    if (placement.ref && options?.blob) await options.blob.refs.releaseClaim(placement.ref.key, id).catch(() => {});
    throw e;
  }
}

/**
 * Whether stored bytes are gzip, by their magic number — the guard on reusing
 * them for a session the server decided to compress.
 *
 * Only for that case: a session whose client stated `contentEncoding` gets no
 * guard, for the same reason a direct upload gets none (below).
 *
 * A session's encoding is the server's decision, not a description of the
 * client's bytes: the client is told to gzip, and its declared hash must be
 * of the gzipped bytes (the open issue on predicting that decision). A client
 * that hashed the raw file instead would, uploading, fail verification. Reused,
 * its asset would label raw bytes `gzip` and be served broken. Bytes that do
 * not start like gzip are therefore not reused for a gzip session: it falls
 * back to an upload, which settles the hash the usual way. A direct upload
 * needs no such guard — its `Content-Encoding` is the client's own statement
 * about the very bytes the hash names, so reuse records what a full upload of
 * those bytes would.
 */
async function isGzipBlob(storage: FileStorage | undefined, key: string): Promise<boolean> {
  if (!storage) return false;
  const head = await storage.get(key, { offset: 0, length: 2 });
  if (!head) return false;
  const start = new Uint8Array(await new Response(head.body).arrayBuffer());
  return start.length === 2 && start[0] === 0x1f && start[1] === 0x8b;
}

/**
 * A session for bytes the scope already holds (ADR-017 §4): nothing to upload.
 *
 * The response is a multipart session with no parts — the shape every client
 * already handles. A client uploads nothing and calls `complete` as usual
 * (with `{ "parts": [] }` or no body), which creates the asset from the
 * existing blob. `contentEncoding` is the server's decision for this file, as
 * for any session, and is what the asset records: the declared hash names the
 * bytes as they would have been stored, so the blob holds exactly those.
 *
 * No claim is taken: nothing is written, so there is no writer to exclude.
 * Whether the blob is still there is settled at completion.
 */
async function startReuseSession(
  sessions: UploadSessionStore,
  params: {
    id: string; now: number; expiresAt: number; urlExpirySeconds: number; contentType: string;
    compress: boolean; sha256: string; ref: BlobRefKey; filename: string; size: number;
  },
  options?: { sessionId?: string | null; projectId?: string | null; skipExtraction?: boolean },
): Promise<MultipartUploadResult> {
  const session: UploadSession = {
    id: params.id,
    filename: params.filename,
    contentType: params.contentType,
    size: params.size,
    createdAt: params.now,
    expiresAt: params.expiresAt,
    ...(params.compress && { contentEncoding: "gzip" }),
    sha256: params.sha256,
    ...(options?.sessionId && { sessionId: options.sessionId }),
    ...(options?.projectId && { projectId: options.projectId }),
    ...(options?.skipExtraction && { skipExtraction: true }),
    blobKey: params.ref.key,
    blobScope: params.ref.scope,
    blobReuse: true,
  };
  await sessions.save(session, params.urlExpirySeconds);
  return {
    uploadId: params.id,
    parts: [],
    ...(params.compress && { contentEncoding: "gzip" }),
    expiresAt: session.expiresAt,
  };
}

async function startSession(
  sessions: UploadSessionStore,
  presignedUrls: PresignedUrlGenerator,
  params: {
    id: string; now: number; expiresAt: number; urlExpirySeconds: number; contentType: string;
    compress: boolean; sha256: string | undefined; placement: Placement;
    filename: string; size: number; partCount?: number;
  },
  options?: { sessionId?: string | null; projectId?: string | null; skipExtraction?: boolean },
): Promise<PresignedUploadResult | MultipartUploadResult> {
  const { id, now, urlExpirySeconds, contentType, compress, sha256, placement } = params;
  const key = placement.key;
  const encodingOpts = compress ? { contentEncoding: "gzip" as const } : undefined;
  const blobFields = placement.ref ? { blobKey: placement.ref.key, blobScope: placement.ref.scope } : {};

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
      expiresAt: params.expiresAt,
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
      ...blobFields,
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
    expiresAt: params.expiresAt,
    ...(compress && { contentEncoding: "gzip" }),
    ...(options?.sessionId && { sessionId: options.sessionId }),
    ...(options?.projectId && { projectId: options.projectId }),
    ...(options?.skipExtraction && { skipExtraction: true }),
    ...(sha256 && { sha256 }),
    ...blobFields,
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

  test("a stated encoding overrides the server's decision, both ways", async () => {
    const presigned = mockPresignedUrls();
    // A compressible name the server would gzip, stated identity.
    const plain = await createUploadSession(
      mockSessions(), presigned,
      { filename: "big.geojson", contentType: "application/geo+json", size: 5000, contentEncoding: "identity" },
      3600,
    ) as PresignedUploadResult;
    expect(plain.contentEncoding).toBeUndefined();
    expect(plain.headers["Content-Encoding"]).toBeUndefined();
    expect(vi.mocked(presigned.generatePutUrl).mock.calls[0][3]).toEqual({});

    // A name the server would not gzip, stated gzip.
    const sessions = mockSessions();
    const gz = await createUploadSession(
      sessions, presigned,
      { filename: "photo.png", contentType: "image/png", size: 5000, partCount: 2, contentEncoding: "gzip" },
      3600,
    ) as MultipartUploadResult;
    expect(gz.contentEncoding).toBe("gzip");
    expect(presigned.createMultipartUpload).toHaveBeenCalledWith(expect.any(String), "image/png", { contentEncoding: "gzip" });
    expect(vi.mocked(sessions.save).mock.calls[0][0].contentEncoding).toBe("gzip");
  });

  test("a stated gzip session reuses bytes without the magic-number guard; an unstated one keeps it", async () => {
    const { blobKey } = await import("../../blob/model");
    const sha = "d".repeat(64);
    const key = blobKey("ws1", sha);
    // Not gzip: the bytes the stated client hashed are what it says it sends.
    const storage = {
      get: vi.fn(async () => ({ body: new Response(new TextEncoder().encode("plain bytes")).body! })),
    } as unknown as FileStorage;
    const ready = { key, scope: "ws1", sha256: sha, refCount: 1, state: "ready" as const };
    const refs = {
      find: vi.fn(async () => ready),
      claim: vi.fn(async () => "claimed" as const),
      reserve: vi.fn(async () => true),
      releaseClaim: vi.fn(async () => {}),
    } as unknown as import("../../blob/repository").BlobRefStore;

    const stated = await createUploadSession(
      mockSessions(), mockPresignedUrls(),
      { filename: "data.json", contentType: "application/json", size: 5000, sha256: sha, contentEncoding: "gzip" },
      3600, { blob: { refs, scope: "ws1" }, storage },
    ) as MultipartUploadResult;
    expect(stated.parts).toEqual([]);
    expect(stated.contentEncoding).toBe("gzip");
    expect(storage.get).not.toHaveBeenCalled();

    const unstated = await createUploadSession(
      mockSessions(), mockPresignedUrls(),
      { filename: "data.json", contentType: "application/json", size: 5000, sha256: sha },
      3600, { blob: { refs, scope: "ws1" }, storage },
    );
    expect("url" in unstated).toBe(true);
  });

  test("upload session body accepts only gzip or identity as contentEncoding", async () => {
    const { createUploadSessionBodySchema } = await import("../../../shared/api");
    for (const contentEncoding of ["gzip", "identity"]) {
      expect(createUploadSessionBodySchema.safeParse({ filename: "a", size: 1, contentEncoding }).success).toBe(true);
    }
    for (const contentEncoding of ["br", "deflate", "GZIP", ""]) {
      expect(createUploadSessionBodySchema.safeParse({ filename: "a", size: 1, contentEncoding }).success, contentEncoding).toBe(false);
    }
  });

  test("upload session body accepts only a hex sha256", async () => {
    const { createUploadSessionBodySchema } = await import("../../../shared/api");
    expect(createUploadSessionBodySchema.safeParse({ filename: "a", size: 1, sha256: "A".repeat(64) }).success).toBe(true);
    expect(createUploadSessionBodySchema.safeParse({ filename: "a", size: 1, sha256: "g".repeat(64) }).success).toBe(false);
    expect(createUploadSessionBodySchema.safeParse({ filename: "a", size: 1, sha256: "a".repeat(63) }).success).toBe(false);
  });
}
