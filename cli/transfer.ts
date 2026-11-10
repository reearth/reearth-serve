/**
 * Moving a file's bytes to the server, with a declared SHA-256 on every
 * request (ADR-017 P5).
 *
 * The hash is always computed before the first request: an upload session
 * takes it at creation, and a direct upload sends it as a header in front of
 * the body. A file read into memory is hashed from that buffer, so the cost
 * is CPU only. A file streamed from disk (over `LARGE_FILE_THRESHOLD`) is read
 * twice — once to hash, once to upload — and the hashing pass shows its own
 * progress. Reading a local disk is far faster than any upload link.
 *
 * Every upload sends the whole file. The server never tells a client whether
 * the workspace already stores the bytes (ADR-017 §4), so there is nothing to
 * skip; what a duplicate saves is storage on the server.
 *
 * The hash covers the bytes *sent*: after the CLI's own gzip, when it gzips.
 * The encoding is the CLI's decision and is stated to the server
 * (`Content-Encoding` on a direct upload, `contentEncoding` on a session), so
 * the CLI never predicts what the server will do.
 */
import { open } from "node:fs/promises";
import { gzipSync } from "node:zlib";
import { isCompressiblePath } from "@reearth/compressible";
import { PATHS } from "../shared/paths";
import type {
  AssetMetadata, AssetUploadResult, AssetVersion, ErrorCode, MultipartUploadResult, PresignedUploadResult, UploadEncoding,
} from "../shared/api";
import { adoptSessionId, commonHeaders, formatBytes } from "./helpers";
import { progressLine, sha256Bytes, sha256File } from "./hash";

const MIB = 1024 * 1024;
export const MULTIPART_THRESHOLD = 100 * MIB;
export const PART_SIZE = 100 * MIB;
/** The largest body the Worker accepts on a direct upload. */
export const DIRECT_UPLOAD_LIMIT = 100 * MIB;
const MAX_CONCURRENCY = 4;
const MIN_COMPRESS_SIZE = 1024;

/** Retries of a direct upload the server could not store because of a concurrent change (`blob_unavailable`). */
const BLOB_UNAVAILABLE_RETRIES = 2;
/** Polling while a first upload is verified (`upload_under_verification`). */
const VERIFICATION_POLL_MIN_MS = 5_000;
const VERIFICATION_POLL_MAX_MS = 60_000;

/** Whether the CLI gzips a file before uploading it. Its own policy, stated to the server. */
export function shouldCompress(filename: string, size: number): boolean {
  if (size < MIN_COMPRESS_SIZE) return false;
  return isCompressiblePath(filename);
}

/** A failed request, with the server's machine-readable `code` when it sent one. */
export class UploadError extends Error {
  constructor(message: string, readonly status: number, readonly code?: ErrorCode) {
    super(message);
    this.name = "UploadError";
  }
}

export function hasCode(e: unknown, code: ErrorCode): e is UploadError {
  return e instanceof UploadError && e.code === code;
}

async function failure(res: Response, what: string): Promise<UploadError> {
  const text = await res.text();
  let code: ErrorCode | undefined;
  try {
    const parsed = JSON.parse(text) as { code?: unknown };
    if (typeof parsed.code === "string") code = parsed.code as ErrorCode;
  } catch {
    // not JSON: no code
  }
  return new UploadError(`${what} failed (${res.status}): ${text}`, res.status, code);
}

/** What the transfer functions need from the outside world; tests replace it. */
export interface TransferDeps {
  sleep: (ms: number) => Promise<void>;
  log: (message: string) => void;
  now: () => number;
}

export const defaultDeps: TransferDeps = {
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  log: (message) => console.error(message),
  now: () => Date.now(),
};

/** The bytes of one upload, in memory, with what the server is told about them. */
export interface Payload {
  fileName: string;
  contentType: string;
  /** The bytes sent: gzipped when `encoding` is gzip. */
  data: Uint8Array;
  /** Size of the file before any gzip. */
  originalSize: number;
  encoding: UploadEncoding;
  /** SHA-256 of `data`. */
  sha256: string;
  skipExtraction?: boolean;
}

export function preparePayload(fileName: string, contentType: string, fileData: Uint8Array, skipExtraction?: boolean): Payload {
  const gzip = shouldCompress(fileName, fileData.byteLength);
  const data = gzip ? new Uint8Array(gzipSync(fileData)) : fileData;
  return {
    fileName, contentType, data, originalSize: fileData.byteLength,
    encoding: gzip ? "gzip" : "identity", sha256: sha256Bytes(data), skipExtraction,
  };
}

// --- Direct uploads (through the Worker) ---

async function postDirect(endpoint: string, path: string, p: Payload): Promise<Response> {
  const headers: Record<string, string> = {
    "Content-Type": p.contentType,
    "Content-Length": String(p.data.byteLength),
    "X-Filename": p.fileName,
    "X-Content-SHA256": p.sha256,
    ...(await commonHeaders()),
  };
  if (p.encoding === "gzip") {
    headers["Content-Encoding"] = "gzip";
    headers["X-Original-Size"] = String(p.originalSize);
  }
  if (p.skipExtraction) headers["X-Skip-Extraction"] = "true";
  const res = await fetch(`${endpoint}${path}`, { method: "POST", headers, body: p.data as BodyInit });
  adoptSessionId(res);
  return res;
}

/** One direct upload. A 409 is the caller's to handle; 401/403/404/413 would only repeat. */
async function sendDirect<T>(endpoint: string, path: string, p: Payload): Promise<T> {
  const res = await postDirect(endpoint, path, p);
  if (!res.ok) throw await failure(res, "Upload");
  return res.json() as Promise<T>;
}

/** `POST /api/v1/assets`, retried on `blob_unavailable`. */
export async function uploadDirect(endpoint: string, p: Payload, deps: TransferDeps = defaultDeps): Promise<AssetUploadResult> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await sendDirect<AssetUploadResult>(endpoint, PATHS.assets, p);
    } catch (e) {
      if (hasCode(e, "blob_unavailable") && attempt < BLOB_UNAVAILABLE_RETRIES) {
        deps.log("The server could not store the upload because of a concurrent change; uploading again.");
        continue;
      }
      throw e;
    }
  }
}

/**
 * `POST /api/v1/assets/{id}`: a new version.
 *
 * While the asset's first upload is still being verified against its declared
 * hash (a large presigned upload, minutes per hundred GiB), the server refuses
 * new versions with `upload_under_verification`. The CLI then waits — polling
 * the asset, not re-sending the body — for up to `waitMs`, and uploads once
 * the asset is `verified`. A 0 wait fails at once with the same explanation.
 */
export async function uploadVersionDirect(
  endpoint: string,
  assetId: string,
  p: Payload,
  waitMs: number,
  deps: TransferDeps = defaultDeps,
): Promise<{ version: AssetVersion; url: string; siteUrl?: string }> {
  const deadline = deps.now() + waitMs;
  let unavailableRetries = 0;
  for (;;) {
    try {
      return await sendDirect(endpoint, PATHS.assetUpload(assetId), p);
    } catch (e) {
      if (hasCode(e, "blob_unavailable") && unavailableRetries++ < BLOB_UNAVAILABLE_RETRIES) {
        deps.log("The server could not store the upload because of a concurrent change; uploading again.");
        continue;
      }
      if (hasCode(e, "upload_under_verification")) {
        await waitForVerification(endpoint, assetId, deadline, waitMs, deps);
        continue;
      }
      throw e;
    }
  }
}

async function waitForVerification(
  endpoint: string,
  assetId: string,
  deadline: number,
  waitMs: number,
  deps: TransferDeps,
): Promise<void> {
  const stillPending = () => new Error(
    `The first upload of asset ${assetId} is still being verified against its declared SHA-256 ` +
    `(integrity: pending)${waitMs > 0 ? ` after waiting ${Math.round(waitMs / 60_000)} min` : ""}. ` +
    `A version can be added once it is verified; check with \`asset show ${assetId}\` and run this command again.`,
  );
  if (deps.now() >= deadline) throw stillPending();
  deps.log(`The first upload of asset ${assetId} is still being verified (integrity: pending); waiting up to ${Math.max(1, Math.round((deadline - deps.now()) / 60_000))} min...`);
  let delay = VERIFICATION_POLL_MIN_MS;
  for (;;) {
    const remaining = deadline - deps.now();
    if (remaining <= 0) throw stillPending();
    await deps.sleep(Math.min(delay, remaining));
    delay = Math.min(delay * 2, VERIFICATION_POLL_MAX_MS);
    const res = await fetch(`${endpoint}${PATHS.asset(assetId)}`, { headers: { ...(await commonHeaders()) } });
    adoptSessionId(res);
    if (res.status === 404) {
      await res.text().catch(() => {});
      throw new Error(
        `Asset ${assetId} is gone: its first upload failed verification (the stored bytes did not match ` +
        "their declared SHA-256) and was deleted, so there is nothing to add a version to. Upload the file again as a new asset.",
      );
    }
    if (!res.ok) throw await failure(res, "Checking the asset");
    const { asset } = await res.json() as { asset: AssetMetadata };
    if (asset.integrity !== "pending") {
      deps.log("Verification finished; uploading the version.");
      return;
    }
  }
}

// --- Presigned upload sessions ---

/** Where a session's bytes come from: a buffer, or a file read part by part. */
export interface ByteSource {
  /** Bytes that will be sent (after any gzip). */
  size: number;
  read(start: number, length: number): Promise<Uint8Array>;
}

export function bufferSource(data: Uint8Array): ByteSource {
  return { size: data.byteLength, read: async (start, length) => data.subarray(start, start + length) };
}

export interface SessionUpload {
  fileName: string;
  contentType: string;
  originalSize: number;
  encoding: UploadEncoding;
  sha256: string;
  skipExtraction?: boolean;
  source: ByteSource;
}

async function uploadPartWithRetry(url: string, data: Uint8Array, retries = 2): Promise<string> {
  for (let attempt = 0; attempt <= retries; attempt++) {
    const res = await fetch(url, { method: "PUT", body: data as BodyInit });
    if (res.ok) {
      const etag = res.headers.get("ETag");
      if (!etag) throw new Error("Missing ETag in part upload response");
      return etag;
    }
    if (attempt === retries) {
      const body = await res.text();
      throw new Error(`Part upload failed (${res.status}): ${body}`);
    }
  }
  throw new Error("Unreachable");
}

async function complete(endpoint: string, uploadId: string, parts?: { partNumber: number; etag: string }[]): Promise<AssetUploadResult> {
  const res = await fetch(`${endpoint}${PATHS.completeUpload(uploadId)}`, {
    method: "POST",
    headers: { ...(parts && { "Content-Type": "application/json" }), ...(await commonHeaders()) },
    ...(parts && { body: JSON.stringify({ parts }) }),
  });
  adoptSessionId(res);
  if (!res.ok) throw await failure(res, "Upload completion");
  return res.json() as Promise<AssetUploadResult>;
}

/**
 * One session: create it with the declared hash and the stated encoding,
 * upload the parts, complete.
 * `null` when the server has no presigned uploads (501).
 */
async function runSession(endpoint: string, u: SessionUpload): Promise<AssetUploadResult | null> {
  const { source } = u;
  const isMultipart = source.size > MULTIPART_THRESHOLD;
  const partCount = isMultipart ? Math.ceil(source.size / PART_SIZE) : undefined;

  const initRes = await fetch(`${endpoint}${PATHS.uploads}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...(await commonHeaders()) },
    body: JSON.stringify({
      filename: u.fileName, contentType: u.contentType, size: u.originalSize, partCount,
      sha256: u.sha256, contentEncoding: u.encoding,
      ...(u.skipExtraction && { skipExtraction: true }),
    }),
  });
  // The server may mint a fresh session ID (e.g. ours expired); adopt it so
  // the complete request below is attributed to the same session.
  adoptSessionId(initRes);
  if (initRes.status === 501) return null;
  if (!initRes.ok) throw await failure(initRes, "Upload session creation");

  const session = await initRes.json() as PresignedUploadResult | MultipartUploadResult;
  // A server that predates stated encodings decides for itself; if it decided
  // otherwise, the declared hash names other bytes than it expects.
  const answered = session.contentEncoding ?? "identity";
  if (answered !== u.encoding) {
    throw new Error(
      `The server answered contentEncoding "${answered}" to an upload stated as "${u.encoding}"; ` +
      "it predates this CLI. Upgrade the server, or upload with --direct.",
    );
  }

  if ("parts" in session) {
    const etags: { partNumber: number; etag: string }[] = [];
    const parts = session.parts.filter((part) => (part.partNumber - 1) * PART_SIZE < source.size);
    const showProgress = parts.length > 1;
    for (let i = 0; i < parts.length; i += MAX_CONCURRENCY) {
      const batch = parts.slice(i, i + MAX_CONCURRENCY);
      const results = await Promise.all(batch.map(async (part) => {
        const start = (part.partNumber - 1) * PART_SIZE;
        const chunk = await source.read(start, Math.min(PART_SIZE, source.size - start));
        return { partNumber: part.partNumber, etag: await uploadPartWithRetry(part.url, chunk) };
      }));
      etags.push(...results);
      if (showProgress) process.stderr.write(`\ruploaded ${Math.min(i + MAX_CONCURRENCY, parts.length)}/${parts.length} parts`);
    }
    if (showProgress) process.stderr.write("\n");
    return complete(endpoint, session.uploadId, etags);
  }

  const putRes = await fetch(session.url, {
    method: "PUT",
    headers: session.headers,
    body: await source.read(0, source.size) as BodyInit,
  });
  if (!putRes.ok) {
    const body = await putRes.text();
    throw new Error(`Direct upload to storage failed (${putRes.status}): ${body}`);
  }
  return complete(endpoint, session.uploadId);
}

/**
 * A presigned upload. `null` when the server has no presigned uploads (501).
 * A `blob_unavailable` (which current servers never send for a session) is
 * retried with a new session, since the old one is spent.
 */
export async function uploadViaSession(
  endpoint: string,
  u: SessionUpload,
  deps: TransferDeps = defaultDeps,
): Promise<AssetUploadResult | null> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await runSession(endpoint, u);
    } catch (e) {
      if (hasCode(e, "blob_unavailable") && attempt < BLOB_UNAVAILABLE_RETRIES) {
        deps.log("The server could not store the upload because of a concurrent change; starting a new upload session.");
        continue;
      }
      throw e;
    }
  }
}

/**
 * A file too large to read into memory, as a multipart session streamed from
 * disk. It is hashed first, in its own streaming pass with progress, and sent
 * as is (`identity`): gzipping it would take another pass to learn the size,
 * and the parts must be cut from the bytes the hash names.
 */
export async function uploadLargeFile(
  endpoint: string,
  filePath: string,
  fileName: string,
  contentType: string,
  fileSize: number,
  skipExtraction: boolean | undefined,
  deps: TransferDeps = defaultDeps,
): Promise<AssetUploadResult | null> {
  const progress = progressLine("hashing", fileSize, formatBytes);
  const sha256 = await sha256File(filePath, progress.update);
  progress.done();

  const fh = await open(filePath, "r");
  try {
    const source: ByteSource = {
      size: fileSize,
      async read(start, length) {
        const chunk = Buffer.alloc(length);
        await fh.read(chunk, 0, length, start);
        return chunk;
      },
    };
    return await uploadViaSession(endpoint, {
      fileName, contentType, originalSize: fileSize, encoding: "identity", sha256, skipExtraction, source,
    }, deps);
  } finally {
    await fh.close();
  }
}
