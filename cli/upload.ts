import { readFileSync, statSync } from "node:fs";
import { basename } from "node:path";
import { gzipSync } from "node:zlib";
import { lookup } from "./mime";
import { PATHS } from "../shared/paths";
import { commonHeaders } from "./helpers";
import type { AssetUploadResult, PresignedUploadResult, MultipartUploadResult } from "../shared/api";
import { output } from "./helpers";

const MULTIPART_THRESHOLD = 100 * 1024 * 1024; // 100MB
const PART_SIZE = 100 * 1024 * 1024; // 100MB per part
const MAX_CONCURRENCY = 4;
const COMPRESSIBLE_EXTENSIONS = new Set([
  "json", "geojson", "topojson", "csv", "tsv",
  "xml", "kml", "gml", "czml",
  "html", "htm", "js", "mjs", "css",
  "svg", "txt", "md", "yaml", "yml",
]);
const MIN_COMPRESS_SIZE = 1024;

function shouldCompress(filename: string, size: number): boolean {
  if (size < MIN_COMPRESS_SIZE) return false;
  const ext = filename.split(".").pop()?.toLowerCase() ?? "";
  return COMPRESSIBLE_EXTENSIONS.has(ext);
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

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Upload failed (${res.status}): ${body}`);
  }
  return res.json() as Promise<AssetUploadResult>;
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

  const fileName = basename(filePath);
  const fileData = new Uint8Array(readFileSync(filePath));
  const contentType = lookup(fileName);

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
