import { readFileSync, statSync } from "node:fs";
import { mkdtemp, open, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { gzipSync } from "node:zlib";
import { isCompressiblePath } from "@reearth/compressible";
import { lookup } from "./mime";
import { PATHS } from "../shared/paths";
import { adoptSessionId, apiPatch, apiPost, commonHeaders, promptPasswordTwice, SITE_PASSWORD_ENV } from "./helpers";
import { loadCredentials } from "./config";
import type { AssetMetadata, AssetUploadResult, PresignedUploadResult, MultipartUploadResult, SiteHost } from "../shared/api";
import { output } from "./helpers";
import { zipDirectory } from "./zip";

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

/** Options `upload` and its `asset create` alias share (ADR-013 C2). */
export interface UploadOptions {
  endpoint: string;
  direct: boolean;
  json: boolean;
  skipExtraction?: boolean;
  /** `--site`: turn the SPA fallback on after upload (ADR-013 C1). */
  site?: boolean;
  /** `--name <slug>`: claim a named site host after upload (ADR-013 B2). */
  name?: string;
  /** `--password`: protect the site after upload (ADR-013 B7). Prompts. */
  password?: boolean;
}

/**
 * Zip `dir` into a temp file and hand back its path, or `null` when the
 * argument is not a directory.
 *
 * The name of the upload is `<dirname>.zip`, which is what the file list, the
 * `Content-Disposition` and `/files/{id}/<name>` will all show. `dist` is a
 * common directory name, so the *resolved* path's basename is used — `upload
 * ./dist` from a project directory still says `dist.zip`, but `upload .` says
 * the project's own name rather than `..zip`.
 */
async function zipToTemp(dirPath: string): Promise<{ file: string; cleanup: () => Promise<void> } | null> {
  if (!statSync(dirPath).isDirectory()) return null;

  const name = basename(resolve(dirPath));
  const tmp = await mkdtemp(join(tmpdir(), "reearth-serve-site-"));
  const file = join(tmp, `${name}.zip`);
  const cleanup = () => rm(tmp, { recursive: true, force: true });
  try {
    const summary = await zipDirectory(dirPath, file);
    for (const link of summary.skippedSymlinks) {
      console.error(`Skipped symbolic link: ${link}`);
    }
    console.error(`Packed ${summary.entries} file(s) into ${name}.zip`);
  } catch (err) {
    await cleanup();
    throw err;
  }
  return { file, cleanup };
}

export async function doUpload(filePath: string, opts: UploadOptions): Promise<void> {
  try {
    statSync(filePath);
  } catch {
    console.error(`Error: File not found: ${filePath}`);
    process.exit(1);
  }

  const packed = await zipToTemp(filePath);
  try {
    await uploadAndConfigure(packed?.file ?? filePath, opts);
  } finally {
    await packed?.cleanup();
  }
}

async function uploadAndConfigure(filePath: string, opts: UploadOptions): Promise<void> {
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
    await finish(large, opts);
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

  await finish(result, opts);
}

/**
 * Everything that happens after the bytes are in: the site switches, the name,
 * and the output.
 *
 * The upload itself is never rolled back when one of these fails — the asset
 * exists and its URL works, and deleting it because a name was taken would
 * throw away the upload the user just paid for. The error says which step
 * failed and the user reruns that one step.
 */
async function finish(result: AssetUploadResult, opts: UploadOptions): Promise<void> {
  const namedUrl = await applySiteOptions(result, opts);
  if (opts.json) {
    output({ ...result, ...(namedUrl ? { namedSiteUrl: namedUrl } : {}) }, true);
  } else {
    printUrls(result, namedUrl);
  }
}

/**
 * `--site`, `--password` and `--name`, applied to a fresh upload (ADR-013 C2).
 *
 * The two asset-level switches go in one `PATCH`, because they are one write on
 * the server and two requests would leave a half-configured site behind if the
 * second failed. Both are project-only (C1 and B7), and so is a name (B2), so a
 * demo upload gets a note rather than a server error it cannot act on.
 */
async function applySiteOptions(
  result: AssetUploadResult,
  opts: UploadOptions,
): Promise<string | undefined> {
  const wanted = opts.site || opts.password || opts.name;
  if (!wanted) return undefined;

  if (!result.asset.projectId) {
    const flags = [opts.site && "--site", opts.password && "--password", opts.name && "--name"]
      .filter(Boolean).join(", ");
    console.error(
      `Note: ${flags} needs a project. This was a demo upload, which expires in an hour and ` +
      "cannot hold a name or a password; log in and run `project use <id>`, then upload again.",
    );
    return undefined;
  }

  const patch: Record<string, unknown> = {};
  if (opts.site) patch.spa = true;
  if (opts.password) {
    patch.access = "password";
    // Never from an argument: a command line is visible in `ps`, in shell
    // history and in CI logs.
    patch.password = process.env[SITE_PASSWORD_ENV] || await promptPasswordTwice();
  }
  if (Object.keys(patch).length > 0) {
    await apiPatch<{ asset: AssetMetadata }>(opts.endpoint, PATHS.asset(result.asset.id), patch);
  }

  if (!opts.name) return undefined;
  const claimed = await apiPost<{ host: SiteHost; siteUrl: string }>(
    opts.endpoint,
    PATHS.assetHosts(result.asset.id),
    { hostname: opts.name },
  );
  return claimed.siteUrl;
}

/**
 * The file URL, plus the site host when the server hosts this archive as a
 * site (ADR-013 B1), plus the claimed name (B2). The file URL stays the first
 * line so anything piping the output into `head -1` keeps working.
 */
function printUrls(result: AssetUploadResult, namedUrl?: string): void {
  console.log(result.url);
  if (result.siteUrl) console.log(`Site: ${result.siteUrl}`);
  if (namedUrl) console.log(`Named site: ${namedUrl}`);
}
