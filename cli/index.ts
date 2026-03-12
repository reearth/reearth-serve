import { Command } from "commander";
import { readFileSync, statSync } from "node:fs";
import { basename } from "node:path";
import { gzipSync } from "node:zlib";
import { lookup } from "./mime";
import { PATHS } from "../shared/paths";
import type {
  AssetMetadata,
  AssetUploadResult,
  PresignedUploadResult,
  MultipartUploadResult,
  Job,
} from "../shared/api";

const DEFAULT_ENDPOINT = "http://localhost:8787";
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

// --- Output helpers ---

function output(data: unknown, json: boolean) {
  if (json) {
    console.log(JSON.stringify(data, null, 2));
  } else if (typeof data === "string") {
    console.log(data);
  } else {
    console.log(data);
  }
}

function formatAsset(asset: AssetMetadata): string {
  const lines = [
    `ID:           ${asset.id}`,
    `Filename:     ${asset.filename}`,
    `Content-Type: ${asset.contentType}`,
    `Size:         ${formatBytes(asset.size)}`,
    `Created:      ${new Date(asset.createdAt).toISOString()}`,
    `Expires:      ${new Date(asset.expiresAt).toISOString()}`,
  ];
  if (asset.contentEncoding) lines.push(`Encoding:     ${asset.contentEncoding}`);
  if (asset.originalSize) lines.push(`Original:     ${formatBytes(asset.originalSize)}`);
  if (asset.type) lines.push(`Type:         ${asset.type}`);
  if (asset.status) lines.push(`Status:       ${asset.status}`);
  if (asset.archiveFormat) lines.push(`Archive:      ${asset.archiveFormat}`);
  if (asset.fileCount) lines.push(`Files:        ${asset.fileCount}`);
  if (asset.jobId) lines.push(`Job:          ${asset.jobId}`);
  return lines.join("\n");
}

function formatJob(job: Job): string {
  const lines = [
    `ID:        ${job.id}`,
    `Asset:     ${job.assetId}`,
    `Type:      ${job.type}`,
    `Status:    ${job.status}`,
    `Updated:   ${new Date(job.updatedAt).toISOString()}`,
  ];
  if (job.completedAt) lines.push(`Completed: ${new Date(job.completedAt).toISOString()}`);
  if (job.fileCount) lines.push(`Files:     ${job.fileCount}`);
  if (job.extractedSize) lines.push(`Extracted: ${formatBytes(job.extractedSize)}`);
  if (job.error) lines.push(`Error:     ${job.error}`);
  return lines.join("\n");
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}

// --- HTTP helpers ---

async function apiGet<T>(endpoint: string, path: string): Promise<T> {
  const res = await fetch(`${endpoint}${path}`);
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`${res.status}: ${body}`);
  }
  return res.json() as Promise<T>;
}

async function apiPost<T>(endpoint: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(`${endpoint}${path}`, {
    method: "POST",
    ...(body ? { headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) } : {}),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`${res.status}: ${text}`);
  }
  return res.json() as Promise<T>;
}

async function apiDelete(endpoint: string, path: string): Promise<void> {
  const res = await fetch(`${endpoint}${path}`, { method: "DELETE" });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`${res.status}: ${body}`);
  }
}

// --- Upload logic ---

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
): Promise<AssetUploadResult | null> {
  const isMultipart = fileData.byteLength > MULTIPART_THRESHOLD;
  const partCount = isMultipart ? Math.ceil(fileData.byteLength / PART_SIZE) : undefined;

  const initRes = await fetch(`${endpoint}${PATHS.uploads}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ filename: fileName, contentType, size: fileData.byteLength, partCount }),
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
      headers: { "Content-Type": "application/json" },
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
    headers: singleSession.headers,
    body: uploadData as BodyInit,
  });
  if (!putRes.ok) {
    const body = await putRes.text();
    throw new Error(`Direct upload to storage failed (${putRes.status}): ${body}`);
  }

  const completeRes = await fetch(`${endpoint}${PATHS.completeUpload(singleSession.uploadId)}`, {
    method: "POST",
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
): Promise<AssetUploadResult> {
  const compress = shouldCompress(fileName, fileData.byteLength);
  const uploadData = compress ? new Uint8Array(gzipSync(fileData)) : fileData;

  const headers: Record<string, string> = {
    "Content-Type": contentType,
    "Content-Length": String(uploadData.byteLength),
    "X-Filename": fileName,
  };
  if (compress) {
    headers["Content-Encoding"] = "gzip";
    headers["X-Original-Size"] = String(fileData.byteLength);
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

async function doUpload(
  filePath: string,
  opts: { endpoint: string; direct: boolean; json: boolean },
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
    result = await uploadDirect(opts.endpoint, fileName, contentType, fileData);
  } else {
    const presigned = await uploadViaPresigned(opts.endpoint, fileName, contentType, fileData);
    result = presigned ?? await uploadDirect(opts.endpoint, fileName, contentType, fileData);
  }

  if (opts.json) {
    output(result, true);
  } else {
    console.log(result.url);
  }
}

// --- Program ---

const program = new Command()
  .name("reearth-serve")
  .description("Re:Earth Serve CLI — spatial data delivery")
  .version("0.1.0")
  .option("--endpoint <url>", "Server endpoint", DEFAULT_ENDPOINT)
  .option("--json", "Output JSON", false);

// upload (shortcut)
program
  .command("upload")
  .description("Upload a file and get a public URL")
  .argument("<file>", "File to upload")
  .option("--direct", "Force direct upload (skip presigned URL)")
  .action(async (file: string, cmdOpts: { direct?: boolean }) => {
    const globalOpts = program.opts<{ endpoint: string; json: boolean }>();
    await doUpload(file, { endpoint: globalOpts.endpoint, direct: !!cmdOpts.direct, json: globalOpts.json });
  });

// asset
const asset = program
  .command("asset")
  .description("Manage assets");

asset
  .command("create")
  .description("Upload a file (alias for upload)")
  .argument("<file>", "File to upload")
  .option("--direct", "Force direct upload (skip presigned URL)")
  .action(async (file: string, cmdOpts: { direct?: boolean }) => {
    const globalOpts = program.opts<{ endpoint: string; json: boolean }>();
    await doUpload(file, { endpoint: globalOpts.endpoint, direct: !!cmdOpts.direct, json: globalOpts.json });
  });

asset
  .command("show")
  .description("Show asset metadata")
  .argument("<id>", "Asset ID")
  .action(async (id: string) => {
    const opts = program.opts<{ endpoint: string; json: boolean }>();
    const data = await apiGet<{ asset: AssetMetadata }>(opts.endpoint, PATHS.asset(id));
    if (opts.json) {
      output(data, true);
    } else {
      console.log(formatAsset(data.asset));
    }
  });

asset
  .command("delete")
  .description("Delete an asset")
  .argument("<id>", "Asset ID")
  .action(async (id: string) => {
    const opts = program.opts<{ endpoint: string; json: boolean }>();
    await apiDelete(opts.endpoint, PATHS.asset(id));
    if (opts.json) {
      output({ ok: true }, true);
    } else {
      console.log(`Deleted: ${id}`);
    }
  });

// job
const job = program
  .command("job")
  .description("Manage jobs");

job
  .command("show")
  .description("Show job status")
  .argument("<id>", "Job ID")
  .action(async (id: string) => {
    const opts = program.opts<{ endpoint: string; json: boolean }>();
    const data = await apiGet<Job>(opts.endpoint, PATHS.job(id));
    if (opts.json) {
      output(data, true);
    } else {
      console.log(formatJob(data));
    }
  });

job
  .command("retry")
  .description("Retry a failed job")
  .argument("<id>", "Job ID")
  .action(async (id: string) => {
    const opts = program.opts<{ endpoint: string; json: boolean }>();
    const data = await apiPost<Job>(opts.endpoint, PATHS.jobRetry(id));
    if (opts.json) {
      output(data, true);
    } else {
      console.log(formatJob(data));
    }
  });

// health
program
  .command("health")
  .description("Check server health")
  .action(async () => {
    const opts = program.opts<{ endpoint: string; json: boolean }>();
    const data = await apiGet<{ ok: boolean }>(opts.endpoint, PATHS.health);
    if (opts.json) {
      output(data, true);
    } else {
      console.log(data.ok ? "OK" : "UNHEALTHY");
    }
  });

program.parse();
