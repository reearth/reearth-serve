import type { AssetMetadata, AssetUploadResult, UploadPart, UploadSession } from "../model";
import { detectArchiveFormat } from "../model";
import type { AtomicWrites, FileStorage, MetadataStore, PresignedUrlGenerator, UploadSessionStore } from "../repository";
import type { Job } from "../../job/model";
import { storageKey } from "./shared";
import { ChecksumMismatchError } from "../integrity";
import { siteUrlFor } from "../../site/url";
import { enqueueThumbnail } from "../../thumbnail/queue";
import type { ThumbnailMessage } from "../../thumbnail/queue";
import type { JobQueue } from "../../queue/port";
import type { ExtractionMessage } from "../../extraction/handler";
import { newVerificationJob, verificationMessage, type VerificationMessage } from "../../integrity/verification";
import type { BlobRefStore } from "../../blob/repository";
import { discardClaimedUpload } from "../../blob/usecase";

export async function completeUploadSession(
  sessions: UploadSessionStore,
  writes: AtomicWrites,
  metadata: MetadataStore,
  storage: FileStorage,
  presignedUrls: PresignedUrlGenerator | null,
  id: string,
  ttlSeconds: number,
  baseUrl: string,
  parts?: UploadPart[],
  options?: {
    sessionId?: string | null; projectId?: string | null;
    extractionQueue?: JobQueue<ExtractionMessage> | null; verificationQueue?: JobQueue<VerificationMessage> | null;
    thumbnailQueue?: JobQueue<ThumbnailMessage> | null;
    skipExtraction?: boolean; usageScopes?: string[]; siteHostSuffix?: string;
    /** The blob ledger; required to complete a session that claimed a blob key. */
    blobRefs?: BlobRefStore;
  },
): Promise<(AssetUploadResult & { asset: AssetMetadata }) | null> {
  const session = await sessions.find(id);
  if (!session) return null;

  // Verify session ownership
  if (session.sessionId && options?.sessionId && session.sessionId !== options.sessionId) return null;

  // Where createUploadSession sent the bytes: the blob key it claimed, or the
  // asset's own key.
  const key = session.blobKey ?? storageKey(id, session.filename);
  const blobRef = session.blobKey && session.blobScope && session.sha256
    ? { key: session.blobKey, scope: session.blobScope, sha256: session.sha256 }
    : undefined;
  const blobRefs = options?.blobRefs;
  if (blobRef && !blobRefs) throw new Error(`completeUploadSession: session ${id} claimed ${blobRef.key} but no blob ledger was given`);
  const url = `${baseUrl}/files/${id}/${encodeURIComponent(session.filename)}`;
  const archiveFormat = detectArchiveFormat(session.filename);
  const siteUrl = siteUrlFor({ assetId: id, baseUrl, siteHostSuffix: options?.siteHostSuffix, archive: Boolean(archiveFormat) });

  // The session outlives a completed call when its KV delete has not
  // propagated yet, or when the row write committed but reported an error.
  // Writing again would count usage twice and reset the asset and its job.
  const existing = await metadata.find(id);
  if (existing) {
    await sessions.delete(id);
    return { asset: existing, url, ...(siteUrl && { siteUrl }) };
  }

  // Complete the multipart upload unless a previous attempt already did and
  // then failed on the metadata write: the session survives that failure so
  // the client can retry, and the completed UploadId cannot be completed twice.
  let head = await storage.head(key);
  if (!head && session.s3UploadId) {
    if (!parts || parts.length === 0) return null;
    if (!presignedUrls) return null;
    await presignedUrls.completeMultipartUpload(key, session.s3UploadId, parts);
    head = await storage.head(key);
  }
  if (!head) return null;

  // A claim that lapsed (the session outlived its expiry in KV) may since
  // have been taken by another upload, which may have rewritten the key. This
  // session no longer owns those bytes, so it neither records nor deletes them.
  if (blobRef) {
    const claim = await blobRefs!.find(blobRef.key);
    if (claim?.state !== "uploading" || claim.claimId !== id) return null;
  }

  const integrity = await sessionIntegrity(session, head, async () => {
    // A store that holds a different hash than the one declared would have
    // refused the write; reaching here means the bytes are not what the client
    // promised, so they are not kept and the session is spent (ADR-017 §2).
    // A claimed blob key is still this session's alone, so it goes too.
    if (blobRef) await discardClaimedUpload(blobRefs!, storage, blobRef.key, id);
    else await storage.delete(key);
    await sessions.delete(id);
  });

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
    ...integrity,
    ...(head.contentEncoding && { contentEncoding: head.contentEncoding }),
    ...(head.contentEncoding && session.size && { originalSize: session.size }),
    ...(archiveFormat && {
      type: "archive" as const,
      ...(!session.skipExtraction && { status: "pending" as const }),
      archiveFormat,
    }),
    ...(options?.sessionId && { sessionId: options.sessionId }),
    ...(projectId && { projectId }),
    ...(blobRef && { blobKey: blobRef.key }),
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

  // A row whose hash the store did not vouch for is confirmed by a job that
  // hashes the stored object (ADR-017 §2). It runs alongside extraction: a
  // pending upload is servable, and a rejected one is deleted with whatever
  // extraction wrote.
  const verificationJob = asset.integrity === "pending" ? newVerificationJob(asset, now) : undefined;

  // Job row, asset row and storage-usage counters in one atomic write (ADR-012 §3).
  // On failure the uploaded object and the session are both kept, so the
  // client's retry of `complete` succeeds without re-uploading. Deleting the
  // object here would destroy the only copy of a multi-GB upload, and would
  // leave rows pointing at nothing when the batch committed but reported an error.
  // ponytail: an upload whose client never retries leaves an object with no
  // row; sweep keys with no asset row from cron if that ever shows up in R2 usage.
  //
  // The claim becomes the blob's first reference in the same write: `ready`
  // when the store vouched for the hash, `verifying` until the job does.
  await writes.createAsset({
    asset, job, verificationJob, usageScopes: projectId ? options?.usageScopes : [],
    ...(blobRef && { blob: { ref: blobRef, state: asset.integrity === "verified" ? "ready" as const : "verifying" as const } }),
  });

  // Enqueue only after the rows are committed: the consumer reads them.
  if (job && archiveFormat && options?.extractionQueue) {
    try {
      await options.extractionQueue.send({
        jobId: id,
        assetId: id,
        archiveKey: key,
        archiveFilename: session.filename,
        archiveFormat,
      });
    } catch (e) {
      console.error("Failed to enqueue extraction:", e);
    }
  }

  // A failed enqueue leaves the job pending; the cleanup cron re-sends it.
  if (verificationJob && options?.verificationQueue) {
    try {
      await options.verificationQueue.send(verificationMessage(verificationJob, asset));
    } catch (e) {
      console.error("Failed to enqueue integrity verification:", e);
    }
  }

  await enqueueThumbnail(options?.thumbnailQueue ?? null, {
    assetId: id,
    sourceKey: key,
    contentType: asset.contentType,
    size: asset.size,
  });
  await sessions.delete(id);

  return { asset, url, ...(siteUrl && { siteUrl }) };
}

/**
 * The `sha256` / `integrity` a completed presigned upload is recorded with
 * (ADR-017 §2).
 *
 * - Single PUT, and the store reports a SHA-256 for the object: that hash is
 *   the store's own, so the row is `verified`. R2 keeps one when the PUT
 *   carried `x-amz-checksum-sha256`, which the session signed into the URL.
 *   If it differs from the declared one, `onMismatch` runs and the upload is
 *   refused.
 * - Declared, but the store reports none (multipart, or a store that did not
 *   keep the checksum): the declared hash is recorded as `pending`.
 * - Neither: `pending` with no hash.
 *
 * A `pending` row gets an `integrity-verification` job, which hashes the
 * stored object and settles the row (core/integrity/verification.ts).
 */
async function sessionIntegrity(
  session: UploadSession,
  head: { sha256?: string },
  onMismatch: () => Promise<void>,
): Promise<Pick<AssetMetadata, "sha256" | "integrity">> {
  // A multipart object's store-side checksum, if any, is composite (a hash of
  // part hashes), never the whole-object SHA-256.
  const storeHash = session.s3UploadId ? undefined : head.sha256?.toLowerCase();
  if (storeHash) {
    if (session.sha256 && session.sha256 !== storeHash) {
      await onMismatch();
      throw new ChecksumMismatchError(session.sha256, storeHash);
    }
    return { sha256: storeHash, integrity: "verified" };
  }
  if (session.sha256) return { sha256: session.sha256, integrity: "pending" };
  return { integrity: "pending" };
}

if (import.meta.vitest) {
  const { test, expect, vi } = import.meta.vitest;

  type CreateAssetInput = Parameters<AtomicWrites["createAsset"]>[0];

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

  const noAssets: MetadataStore = {
    save: vi.fn(), find: vi.fn(async () => null), update: vi.fn(), delete: vi.fn(), list: vi.fn(),
    findProtection: vi.fn(async () => null), setProtection: vi.fn(),
  };

  function mockStorage(headResult: { size: number; contentEncoding?: string; sha256?: string } | null = null): FileStorage {
    return {
      put: vi.fn(async () => ({ sha256: "" })),
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
      generatePutUrl: vi.fn(async (key: string, _ct: string, _exp: number) => ({ url: `https://r2.example.com/${key}?signed=true`, headers: {} })),
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

    const result = await completeUploadSession(sessions, writes, noAssets, st, presigned, session.uploadId, 3600, "https://example.com");

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

  // Storage whose object appears only once the multipart upload is completed.
  function multipartFixture() {
    let completed = false;
    const st = mockStorage();
    st.head = vi.fn(async () => (completed ? { size: 1000 } : null));
    const presigned = mockPresignedUrls();
    presigned.completeMultipartUpload = vi.fn(async () => {
      if (completed) throw new Error("NoSuchUpload");
      completed = true;
    });
    return { st, presigned };
  }

  test("completeUploadSession finalizes multipart upload with parts", async () => {
    const sessions = mockSessions();
    const { writes, calls } = mockWrites();
    const { st, presigned } = multipartFixture();

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

    const result = await completeUploadSession(sessions, writes, noAssets, st, presigned, session.uploadId, 3600, "https://example.com", parts);

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
    const { writes } = mockWrites();
    const { st, presigned } = multipartFixture();

    const { createUploadSession } = await import("./create-upload-session");
    const session = await createUploadSession(
      sessions, presigned,
      { filename: "huge.tar", contentType: "application/x-tar", size: 10_000_000_000, partCount: 2 },
      3600,
    );

    const result = await completeUploadSession(sessions, writes, noAssets, st, presigned, session.uploadId, 3600, "https://example.com");
    expect(result).toBeNull();
  });

  test("completeUploadSession returns null if session not found", async () => {
    const sessions = mockSessions();
    const { writes, calls } = mockWrites();
    const st = mockStorage();

    const result = await completeUploadSession(sessions, writes, noAssets, st, null, "nonexistent", 3600, "https://example.com");
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

    const result = await completeUploadSession(sessions, writes, noAssets, st, presigned, session.uploadId, 3600, "https://example.com");
    expect(result).toBeNull();
  });

  test("a failed metadata write keeps the object and session so a retry succeeds", async () => {
    const sessions = mockSessions();
    const { writes } = mockWrites();
    const { st, presigned } = multipartFixture();
    vi.mocked(writes.createAsset).mockRejectedValueOnce(new Error("D1 timeout"));

    const { createUploadSession } = await import("./create-upload-session");
    const session = await createUploadSession(
      sessions, presigned,
      { filename: "huge.tar", contentType: "application/x-tar", size: 10_000_000_000, partCount: 2 },
      3600,
    );
    const parts = [{ partNumber: 1, etag: '"e1"' }, { partNumber: 2, etag: '"e2"' }];

    await expect(
      completeUploadSession(sessions, writes, noAssets, st, presigned, session.uploadId, 3600, "https://example.com", parts),
    ).rejects.toThrow("D1 timeout");
    expect(st.delete).not.toHaveBeenCalled();

    const retry = await completeUploadSession(sessions, writes, noAssets, st, presigned, session.uploadId, 3600, "https://example.com", parts);
    expect(retry?.asset.id).toBe(session.uploadId);
    expect(presigned.completeMultipartUpload).toHaveBeenCalledOnce();
    expect(sessions.delete).toHaveBeenCalledOnce();
  });

  test("a repeated complete after the asset exists returns it without writing again", async () => {
    const sessions = mockSessions();
    const { writes } = mockWrites();
    const st = mockStorage({ size: 100 });
    const presigned = mockPresignedUrls();

    const { createUploadSession } = await import("./create-upload-session");
    const session = await createUploadSession(
      sessions, presigned, { filename: "data.bin", contentType: "application/octet-stream", size: 100 }, 3600,
    );
    const existing = {
      id: session.uploadId, filename: "data.bin", contentType: "application/octet-stream",
      size: 100, createdAt: 1, expiresAt: 0, status: "ready" as const,
    };
    const metadata: MetadataStore = { ...noAssets, find: vi.fn(async () => existing) };

    const result = await completeUploadSession(sessions, writes, metadata, st, presigned, session.uploadId, 3600, "https://example.com");
    expect(result?.asset).toBe(existing);
    expect(writes.createAsset).not.toHaveBeenCalled();
    expect(sessions.delete).toHaveBeenCalledOnce();
  });

  // --- ADR-017 §2: integrity at completion ---

  const DECLARED = "d".repeat(64);

  async function singleSession(sessions: UploadSessionStore, presigned: PresignedUrlGenerator, sha256?: string) {
    const { createUploadSession } = await import("./create-upload-session");
    return createUploadSession(
      sessions, presigned,
      { filename: "data.bin", contentType: "application/octet-stream", size: 100, ...(sha256 && { sha256 }) },
      3600,
    );
  }

  test("a single PUT whose store reports the declared hash is verified", async () => {
    const sessions = mockSessions();
    const { writes, calls } = mockWrites();
    const presigned = mockPresignedUrls();
    const session = await singleSession(sessions, presigned, DECLARED);

    await completeUploadSession(sessions, writes, noAssets, mockStorage({ size: 100, sha256: DECLARED }), presigned, session.uploadId, 3600, "https://example.com");

    expect(calls[0].asset.sha256).toBe(DECLARED);
    expect(calls[0].asset.integrity).toBe("verified");
  });

  test("a declared single PUT the store kept no hash for is recorded pending", async () => {
    const sessions = mockSessions();
    const { writes, calls } = mockWrites();
    const presigned = mockPresignedUrls();
    const session = await singleSession(sessions, presigned, DECLARED);

    await completeUploadSession(sessions, writes, noAssets, mockStorage({ size: 100 }), presigned, session.uploadId, 3600, "https://example.com");

    expect(calls[0].asset.sha256).toBe(DECLARED);
    expect(calls[0].asset.integrity).toBe("pending");
  });

  test("a store hash that differs from the declared one deletes the object and writes no row", async () => {
    const sessions = mockSessions();
    const { writes } = mockWrites();
    const presigned = mockPresignedUrls();
    const st = mockStorage({ size: 100, sha256: "e".repeat(64) });
    const session = await singleSession(sessions, presigned, DECLARED);

    await expect(
      completeUploadSession(sessions, writes, noAssets, st, presigned, session.uploadId, 3600, "https://example.com"),
    ).rejects.toBeInstanceOf(ChecksumMismatchError);
    expect(st.delete).toHaveBeenCalledOnce();
    expect(sessions.delete).toHaveBeenCalledOnce();
    expect(writes.createAsset).not.toHaveBeenCalled();
  });

  test("an undeclared single PUT records the store's hash when it has one, pending otherwise", async () => {
    const presigned = mockPresignedUrls();

    const withHash = mockWrites();
    let sessions = mockSessions();
    let session = await singleSession(sessions, presigned);
    await completeUploadSession(sessions, withHash.writes, noAssets, mockStorage({ size: 100, sha256: "f".repeat(64) }), presigned, session.uploadId, 3600, "https://example.com");
    expect(withHash.calls[0].asset).toMatchObject({ sha256: "f".repeat(64), integrity: "verified" });

    const without = mockWrites();
    sessions = mockSessions();
    session = await singleSession(sessions, presigned);
    await completeUploadSession(sessions, without.writes, noAssets, mockStorage({ size: 100 }), presigned, session.uploadId, 3600, "https://example.com");
    expect(without.calls[0].asset.sha256).toBeUndefined();
    expect(without.calls[0].asset.integrity).toBe("pending");
  });

  // --- ADR-017 §2, P1b: the verification job ---

  function mockQueue<T>() {
    const sent: T[] = [];
    return { sent, queue: { send: vi.fn(async (m: T) => { sent.push(m); }) } };
  }

  test("a verified upload gets no verification job", async () => {
    const sessions = mockSessions();
    const { writes, calls } = mockWrites();
    const presigned = mockPresignedUrls();
    const { sent, queue } = mockQueue<VerificationMessage>();
    const session = await singleSession(sessions, presigned, DECLARED);

    await completeUploadSession(sessions, writes, noAssets, mockStorage({ size: 100, sha256: DECLARED }), presigned, session.uploadId, 3600, "https://example.com", undefined, { verificationQueue: queue });

    expect(calls[0].verificationJob).toBeUndefined();
    expect(sent).toEqual([]);
  });

  test("a pending upload gets a verification job, written with the asset and enqueued after it", async () => {
    const sessions = mockSessions();
    const { writes, calls } = mockWrites();
    const presigned = mockPresignedUrls();
    const { sent, queue } = mockQueue<VerificationMessage>();
    const session = await singleSession(sessions, presigned);

    await completeUploadSession(sessions, writes, noAssets, mockStorage({ size: 100 }), presigned, session.uploadId, 3600, "https://example.com", undefined, { verificationQueue: queue, sessionId: "s1" });

    const job = calls[0].verificationJob!;
    expect(job).toMatchObject({ assetId: session.uploadId, type: "integrity-verification", status: "pending", sessionId: "s1" });
    expect(job.id).not.toBe(session.uploadId);
    expect(calls[0].asset.jobId).toBeUndefined();
    expect(sent).toEqual([{ kind: "integrity-verification", jobId: job.id, assetId: session.uploadId, objectKey: `assets/${session.uploadId}/data.bin` }]);
  });

  test("a pending archive gets both jobs, and the asset's jobId stays the extraction's", async () => {
    const sessions = mockSessions();
    const { writes, calls } = mockWrites();
    const { st, presigned } = multipartFixture();
    const verification = mockQueue<VerificationMessage>();
    const extraction = mockQueue<ExtractionMessage>();

    const { createUploadSession } = await import("./create-upload-session");
    const session = await createUploadSession(
      sessions, presigned,
      { filename: "huge.zip", contentType: "application/zip", size: 10_000_000_000, partCount: 2, sha256: DECLARED },
      3600,
    );
    await completeUploadSession(sessions, writes, noAssets, st, presigned, session.uploadId, 3600, "https://example.com",
      [{ partNumber: 1, etag: '"e1"' }, { partNumber: 2, etag: '"e2"' }],
      { verificationQueue: verification.queue, extractionQueue: extraction.queue });

    expect(calls[0].job?.type).toBe("archive-extraction");
    expect(calls[0].verificationJob?.type).toBe("integrity-verification");
    expect(calls[0].asset.jobId).toBe(session.uploadId);
    expect(extraction.sent).toHaveLength(1);
    expect(verification.sent).toHaveLength(1);
  });

  test("a failed verification enqueue still completes the upload", async () => {
    const sessions = mockSessions();
    const { writes, calls } = mockWrites();
    const presigned = mockPresignedUrls();
    const session = await singleSession(sessions, presigned);
    const queue = { send: vi.fn(async () => { throw new Error("queue down"); }) };
    const err = vi.spyOn(console, "error").mockImplementation(() => {});

    const result = await completeUploadSession(sessions, writes, noAssets, mockStorage({ size: 100 }), presigned, session.uploadId, 3600, "https://example.com", undefined, { verificationQueue: queue });

    expect(result?.asset.integrity).toBe("pending");
    expect(calls[0].verificationJob).toBeDefined();
    err.mockRestore();
  });

  test("a declared multipart upload is recorded pending, whatever the store reports", async () => {
    const sessions = mockSessions();
    const { writes, calls } = mockWrites();
    const { st, presigned } = multipartFixture();
    st.head = vi.fn(async () => ({ size: 1000, sha256: "0".repeat(64) }));

    const { createUploadSession } = await import("./create-upload-session");
    const session = await createUploadSession(
      sessions, presigned,
      { filename: "huge.tar", contentType: "application/x-tar", size: 10_000_000_000, partCount: 2, sha256: DECLARED },
      3600,
    );
    await completeUploadSession(sessions, writes, noAssets, st, presigned, session.uploadId, 3600, "https://example.com",
      [{ partNumber: 1, etag: '"e1"' }, { partNumber: 2, etag: '"e2"' }]);

    expect(calls[0].asset).toMatchObject({ sha256: DECLARED, integrity: "pending" });
  });
}
