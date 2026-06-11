import { readFileSync, statSync } from "node:fs";
import { open } from "node:fs/promises";
import { basename } from "node:path";
import { gzipSync } from "node:zlib";
import { isCompressiblePath } from "@reearth/compressible";
import { lookup } from "./mime";
import { PATHS } from "../shared/paths";
import { adoptSessionId, commonHeaders } from "./helpers";
import { loadCredentials } from "./config";
import type { AssetUploadResult, PresignedUploadResult, MultipartUploadResult } from "../shared/api";
import { output } from "./helpers";

const MULTIPART_THRESHOLD = 100 * 1024 * 1024; // 100MB
const PART_SIZE = 100 * 1024 * 1024; // 100MB per part
const MAX_CONCURRENCY = 4;
const MIN_COMPRESS_SIZE = 1024;

function shouldCompress(filename: string, size: number): boolean {
  if (size < MIN_COMPRESS_SIZE) return false;
  return isCompressiblePath(filename);
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

async function uploadViaPresigned(
  endpoint: string,
  fileName: string,
  contentType: string,
  fileData: Uint8Array,
  skipExtraction?: boolean,
): Promise<AssetUploadResult | null> {
  const isMultipart = fileData.byteLength > MULTIPART_THRESHOLD;
  const partCount = isMultipart ? Math.ceil(fileData.byteLength / PART_SIZE) : undefined;

  const initRes = await fetch(`${endpoint}${PATHS.uploads}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...(await commonHeaders()) },
    body: JSON.stringify({ filename: fileName, contentType, size: fileData.byteLength, partCount, ...(skipExtraction && { skipExtraction: true }) }),
  });


  // The server may mint a fresh session ID (e.g. ours expired); adopt it so
  // the complete request below is attributed to the same session.
  adoptSessionId(initRes);

  if (initRes.status === 501) return null;
  if (!initRes.ok) {
    const body = await initRes.text();
    throw new Error(`Upload session creation failed (${initRes.status}): ${body}`);
  }

  const session = await initRes.json() as PresignedUploadResult | MultipartUploadResult;

  let uploadData = fileData;
  if ("contentEncoding" in session && session.contentEncoding === "gzip") {
    uploadData = new Uint8Array(gzipSync(fileData));
  }

  if ("parts" in session) {
    const parts = session.parts;
    const etags: { partNumber: number; etag: string }[] = [];
    for (let i = 0; i < parts.length; i += MAX_CONCURRENCY) {
      const batch = parts.slice(i, i + MAX_CONCURRENCY);
      const results = await Promise.all(
        batch.map(async (part) => {
          const start = (part.partNumber - 1) * PART_SIZE;
          const end = Math.min(start + PART_SIZE, uploadData.byteLength);
          const chunk = uploadData.subarray(start, end);
          const etag = await uploadPartWithRetry(part.url, chunk);
          return { partNumber: part.partNumber, etag };
        }),
      );
      etags.push(...results);
    }

    const completeRes = await fetch(`${endpoint}${PATHS.completeUpload(session.uploadId)}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...(await commonHeaders()) },
      body: JSON.stringify({ parts: etags }),
    });
    adoptSessionId(completeRes);
    if (!completeRes.ok) {
      const body = await completeRes.text();
      throw new Error(`Upload completion failed (${completeRes.status}): ${body}`);
    }
    return completeRes.json() as Promise<AssetUploadResult>;
  }

  // Single PUT
  const singleSession = session as PresignedUploadResult;
  const putRes = await fetch(singleSession.url, {
    method: "PUT",
    headers: singleSession.headers as Record<string, string>,
    body: uploadData as BodyInit,
  });
  if (!putRes.ok) {
    const body = await putRes.text();
    throw new Error(`Direct upload to storage failed (${putRes.status}): ${body}`);
  }

  const completeRes = await fetch(`${endpoint}${PATHS.completeUpload(singleSession.uploadId)}`, {
    method: "POST",
    headers: { ...(await commonHeaders()) },
  });
  adoptSessionId(completeRes);
  if (!completeRes.ok) {
    const body = await completeRes.text();
    throw new Error(`Upload completion failed (${completeRes.status}): ${body}`);
  }
  return completeRes.json() as Promise<AssetUploadResult>;
}

/**
 * Multipart upload streamed from disk, for files too large to buffer in
 * memory (readFileSync caps at ~2 GiB and would hold the whole file anyway).
 * Parts are read on demand — peak memory is MAX_CONCURRENCY × PART_SIZE.
 * Local gzip compression is skipped: at this size the win is marginal and
 * compressing would require a second pass over the file to learn the size.
 */
async function uploadLargeFileViaPresigned(
  endpoint: string,
  filePath: string,
  fileName: string,
  contentType: string,
  fileSize: number,
  skipExtraction?: boolean,
): Promise<AssetUploadResult | null> {
  const partCount = Math.ceil(fileSize / PART_SIZE);

  const initRes = await fetch(`${endpoint}${PATHS.uploads}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...(await commonHeaders()) },
    body: JSON.stringify({ filename: fileName, contentType, size: fileSize, partCount, ...(skipExtraction && { skipExtraction: true }) }),
  });
  adoptSessionId(initRes);

  if (initRes.status === 501) return null;
  if (!initRes.ok) {
    const body = await initRes.text();
    throw new Error(`Upload session creation failed (${initRes.status}): ${body}`);
  }

  const session = await initRes.json() as MultipartUploadResult;
  if (!("parts" in session)) {
    throw new Error("Server did not return a multipart session for a large upload");
  }

  const fh = await open(filePath, "r");
  const etags: { partNumber: number; etag: string }[] = [];
  try {
    const parts = session.parts;
    for (let i = 0; i < parts.length; i += MAX_CONCURRENCY) {
      const batch = parts.slice(i, i + MAX_CONCURRENCY);
      const results = await Promise.all(
        batch.map(async (part) => {
          const start = (part.partNumber - 1) * PART_SIZE;
          const length = Math.min(PART_SIZE, fileSize - start);
          const chunk = Buffer.alloc(length);
          await fh.read(chunk, 0, length, start);
          const etag = await uploadPartWithRetry(part.url, chunk);
          return { partNumber: part.partNumber, etag };
        }),
      );
      etags.push(...results);
      process.stderr.write(`\ruploaded ${Math.min(i + MAX_CONCURRENCY, parts.length)}/${parts.length} parts`);
    }
    process.stderr.write("\n");
  } finally {
    await fh.close();
  }

  const completeRes = await fetch(`${endpoint}${PATHS.completeUpload(session.uploadId)}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...(await commonHeaders()) },
    body: JSON.stringify({ parts: etags }),
  });
  adoptSessionId(completeRes);
  if (!completeRes.ok) {
    const body = await completeRes.text();
    throw new Error(`Upload completion failed (${completeRes.status}): ${body}`);
  }
  return completeRes.json() as Promise<AssetUploadResult>;
}

async function uploadDirect(
  endpoint: string,
  fileName: string,
  contentType: string,
  fileData: Uint8Array,
  skipExtraction?: boolean,
): Promise<AssetUploadResult> {
  const compress = shouldCompress(fileName, fileData.byteLength);
  const uploadData = compress ? new Uint8Array(gzipSync(fileData)) : fileData;

  const headers: Record<string, string> = {
    "Content-Type": contentType,
    "Content-Length": String(uploadData.byteLength),
    "X-Filename": fileName,
    ...(await commonHeaders()),
  };
  if (compress) {
    headers["Content-Encoding"] = "gzip";
    headers["X-Original-Size"] = String(fileData.byteLength);
  }
  if (skipExtraction) {
    headers["X-Skip-Extraction"] = "true";
  }

  const res = await fetch(`${endpoint}${PATHS.assets}`, {
    method: "POST",
    headers,
    body: uploadData as BodyInit,
  });
  adoptSessionId(res);

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Upload failed (${res.status}): ${body}`);
  }
  return res.json() as Promise<AssetUploadResult>;
}

/**
 * Probe /health to check whether anonymous upload is enabled on this server.
 * Returns true if disabled and the user is not logged in — caller should abort.
 * Failures (network, old server without the field) fall back to "allowed" so
 * we don't block uploads on a missing flag; the server still enforces the gate.
 */
async function shouldBlockAnonymousUpload(endpoint: string): Promise<boolean> {
  if (loadCredentials()) return false;
  try {
    const res = await fetch(`${endpoint}${PATHS.health}`);
    if (!res.ok) return false;
    const body = (await res.json()) as { anonymousUploadEnabled?: boolean };
    return body.anonymousUploadEnabled === false;
  } catch {
    return false;
  }
}

export async function doUpload(
  filePath: string,
  opts: { endpoint: string; direct: boolean; json: boolean; skipExtraction?: boolean },
): Promise<void> {
  try {
    statSync(filePath);
  } catch {
    console.error(`Error: File not found: ${filePath}`);
    process.exit(1);
  }

  if (await shouldBlockAnonymousUpload(opts.endpoint)) {
    console.error("Error: Anonymous upload is disabled on this server.");
    console.error("Please log in first: reearth-serve auth login");
    process.exit(1);
  }

  const fileName = basename(filePath);
  const contentType = lookup(fileName);

  // Files beyond Node's buffer limit (and well before it) must not be read
  // into memory wholesale. Stream multipart parts straight from disk.
  const fileSize = statSync(filePath).size;
  const LARGE_FILE_THRESHOLD = 1024 * 1024 * 1024; // 1 GiB
  if (!opts.direct && fileSize > LARGE_FILE_THRESHOLD) {
    const large = await uploadLargeFileViaPresigned(opts.endpoint, filePath, fileName, contentType, fileSize, opts.skipExtraction);
    if (!large) {
      console.error("Error: Server does not support presigned uploads; file is too large for direct upload.");
      process.exit(1);
    }
    output(opts.json ? large : large.url, opts.json);
    return;
  }

  const fileData = new Uint8Array(readFileSync(filePath));

  let result: AssetUploadResult;
  if (opts.direct) {
    result = await uploadDirect(opts.endpoint, fileName, contentType, fileData, opts.skipExtraction);
  } else {
    const presigned = await uploadViaPresigned(opts.endpoint, fileName, contentType, fileData, opts.skipExtraction);
    result = presigned ?? await uploadDirect(opts.endpoint, fileName, contentType, fileData, opts.skipExtraction);
  }

  if (opts.json) {
    output(result, true);
  } else {
    console.log(result.url);
  }
}
