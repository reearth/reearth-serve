import { Command } from "commander";
import { createHash } from "node:crypto";
import { createWriteStream, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { basename, dirname, join, relative } from "node:path";
import { Writable } from "node:stream";
import { gzipSync } from "node:zlib";
import { lookup } from "./mime";
import { PATHS } from "../shared/paths";
import type {
  AssetMetadata,
  AssetUploadResult,
  PresignedUploadResult,
  MultipartUploadResult,
  FileEntry,
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
    headers: singleSession.headers as Record<string, string>,
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

// --- File helpers ---

function parseSrc(src: string): { assetId: string; filePath: string | null } {
  const colonIdx = src.indexOf(":");
  if (colonIdx === -1) {
    return { assetId: src, filePath: null };
  }
  return { assetId: src.slice(0, colonIdx), filePath: src.slice(colonIdx + 1) };
}

async function downloadFile(url: string, dest: string, force = false): Promise<boolean> {
  if (!force && existsSync(dest)) {
    return false; // skipped
  }
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`Download failed (${res.status}): ${url}`);
  }
  if (!res.body) {
    throw new Error("Empty response body");
  }

  mkdirSync(dirname(dest), { recursive: true });
  const ws = createWriteStream(dest);
  await res.body.pipeTo(Writable.toWeb(ws) as WritableStream<Uint8Array>);
  return true; // downloaded
}

function localMd5(filePath: string): string {
  const data = readFileSync(filePath);
  return `md5:${createHash("md5").update(data).digest("hex")}`;
}

function listLocalFiles(dir: string): string[] {
  const results: string[] = [];
  if (!existsSync(dir)) return results;
  function walk(d: string) {
    for (const entry of readdirSync(d, { withFileTypes: true })) {
      const full = join(d, entry.name);
      if (entry.isDirectory()) {
        walk(full);
      } else {
        results.push(relative(dir, full));
      }
    }
  }
  walk(dir);
  return results;
}

async function* streamNdjson(endpoint: string, path: string): AsyncGenerator<FileEntry> {
  const res = await fetch(`${endpoint}${path}`);
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`${res.status}: ${text}`);
  }
  if (!res.body) return;

  const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
  let buffer = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += value;
    const lines = buffer.split("\n");
    buffer = lines.pop()!;
    for (const line of lines) {
      if (!line) continue;
      yield JSON.parse(line) as FileEntry;
    }
  }
  if (buffer) {
    yield JSON.parse(buffer) as FileEntry;
  }
}

async function collectFiles(endpoint: string, path: string): Promise<FileEntry[]> {
  const files: FileEntry[] = [];
  for await (const entry of streamNdjson(endpoint, path)) {
    files.push(entry);
  }
  return files;
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

// file
const file = program
  .command("file")
  .description("Manage asset files");

file
  .command("ls")
  .description("List files in an asset")
  .argument("<asset-id>", "Asset ID")
  .argument("[prefix]", "Filter by path prefix")
  .option("-l, --long", "Show detailed output")
  .action(async (assetId: string, prefix: string | undefined, cmdOpts: { long?: boolean }) => {
    const opts = program.opts<{ endpoint: string; json: boolean }>();
    let count = 0;
    let totalSize = 0;

    if (opts.json) {
      // Stream NDJSON to stdout as-is
      for await (const entry of streamNdjson(opts.endpoint, PATHS.assetFiles(assetId, prefix))) {
        console.log(JSON.stringify(entry));
        count++;
      }
    } else {
      // Collect for formatting if --long (need max width), stream otherwise
      if (cmdOpts.long) {
        const files = await collectFiles(opts.endpoint, PATHS.assetFiles(assetId, prefix));
        if (files.length === 0) {
          console.log("No files (extraction may be in progress)");
          return;
        }
        const maxSize = Math.max(...files.map((f) => formatBytes(f.size).length));
        for (const f of files) {
          const size = formatBytes(f.size).padStart(maxSize);
          console.log(`${size}  ${f.contentType.padEnd(30)}  ${f.path}`);
        }
        totalSize = files.reduce((s, f) => s + f.size, 0);
        console.log(`\n${files.length} file(s), ${formatBytes(totalSize)} total`);
        return;
      }
      for await (const entry of streamNdjson(opts.endpoint, PATHS.assetFiles(assetId, prefix))) {
        console.log(entry.path);
        count++;
      }
      if (count === 0) {
        console.log("No files (extraction may be in progress)");
      }
    }
  });

file
  .command("cp")
  .description("Download file(s) from an asset")
  .argument("<src>", "Source: <asset-id>:<path> or <asset-id>")
  .argument("<dest>", "Local destination path or directory (with -r)")
  .option("-r, --recursive", "Recursively download all files under the given prefix")
  .option("-f, --force", "Overwrite existing local files")
  .option("-c, --concurrency <n>", "Max concurrent downloads (with -r)", "4")
  .action(async (src: string, dest: string, cmdOpts: { recursive?: boolean; force?: boolean; concurrency: string }) => {
    const opts = program.opts<{ endpoint: string; json: boolean }>();
    const { assetId, filePath } = parseSrc(src);
    const force = !!cmdOpts.force;

    if (cmdOpts.recursive) {
      // Recursive: download all files matching prefix
      const prefix = filePath || undefined;
      const files = await collectFiles(opts.endpoint, PATHS.assetFiles(assetId, prefix));
      if (files.length === 0) {
        if (opts.json) {
          output({ ok: true, count: 0, skipped: 0 }, true);
        } else {
          console.log("No files to download");
        }
        return;
      }

      let downloaded = 0;
      let skipped = 0;
      const queue = [...files];

      async function worker() {
        while (queue.length > 0) {
          const entry = queue.shift()!;
          // Strip prefix from path for local directory structure
          const relativePath = prefix ? entry.path.slice(prefix.length).replace(/^\//, "") || entry.path.split("/").pop()! : entry.path;
          const localPath = join(dest, relativePath);
          const url = `${opts.endpoint}${PATHS.file(assetId, entry.path)}`;
          const ok = await downloadFile(url, localPath, force);
          if (ok) {
            downloaded++;
          } else {
            skipped++;
          }
          if (!opts.json) {
            process.stdout.write(`\r  ${downloaded + skipped}/${files.length}`);
          }
        }
      }

      const concurrency = parseInt(cmdOpts.concurrency, 10) || 4;
      const workers = Array.from({ length: Math.min(concurrency, files.length) }, () => worker());
      await Promise.all(workers);

      if (opts.json) {
        output({ ok: true, count: downloaded, skipped, dest }, true);
      } else {
        const msg = skipped > 0 ? ` (${skipped} skipped, use -f to overwrite)` : "";
        console.log(`\nDone: ${downloaded} file(s) downloaded to ${dest}${msg}`);
      }
      return;
    }

    // Single file download
    let downloadPath = filePath;
    if (!downloadPath) {
      const data = await apiGet<{ asset: AssetMetadata }>(opts.endpoint, PATHS.asset(assetId));
      downloadPath = data.asset.filename;
    }

    if (!force && existsSync(dest)) {
      if (opts.json) {
        output({ ok: false, error: "File exists (use -f to overwrite)" }, true);
      } else {
        console.error(`Error: ${dest} already exists (use -f to overwrite)`);
      }
      process.exit(1);
    }

    const url = `${opts.endpoint}${PATHS.file(assetId, downloadPath)}`;
    await downloadFile(url, dest, true); // force=true since we already checked

    if (opts.json) {
      output({ ok: true, src, dest }, true);
    } else {
      console.log(`Downloaded: ${dest}`);
    }
  });

file
  .command("sync")
  .description("Sync asset files to a local directory (hash-based diff)")
  .argument("<asset-id>", "Asset ID")
  .argument("<dest-dir>", "Local destination directory")
  .option("--delete", "Remove local files not present in the remote asset")
  .option("-c, --concurrency <n>", "Max concurrent downloads", "4")
  .action(async (assetId: string, destDir: string, cmdOpts: { delete?: boolean; concurrency: string }) => {
    const opts = program.opts<{ endpoint: string; json: boolean }>();
    const concurrency = parseInt(cmdOpts.concurrency, 10) || 4;

    // Collect remote file list
    const remoteFiles = await collectFiles(opts.endpoint, PATHS.assetFiles(assetId));
    if (remoteFiles.length === 0) {
      if (opts.json) {
        output({ ok: true, downloaded: 0, skipped: 0, deleted: 0 }, true);
      } else {
        console.log("No files to sync (extraction may be in progress)");
      }
      return;
    }

    const totalSize = remoteFiles.reduce((s, f) => s + f.size, 0);
    if (!opts.json) {
      console.log(`Syncing ${remoteFiles.length} file(s) (${formatBytes(totalSize)}) ...`);
    }

    // Determine which files need downloading (hash or size comparison)
    const remotePaths = new Set<string>();
    const toDownload: typeof remoteFiles = [];
    let skipped = 0;

    for (const entry of remoteFiles) {
      remotePaths.add(entry.path);
      const localPath = join(destDir, entry.path);

      if (existsSync(localPath)) {
        if (entry.hash) {
          // Hash-based comparison
          const localHash = localMd5(localPath);
          if (localHash === entry.hash) {
            skipped++;
            continue;
          }
        } else {
          // Fall back to size comparison
          const localSize = statSync(localPath).size;
          if (localSize === entry.size) {
            skipped++;
            continue;
          }
        }
      }

      toDownload.push(entry);
    }

    // Download changed/new files
    let downloaded = 0;
    const queue = [...toDownload];

    async function worker() {
      while (queue.length > 0) {
        const entry = queue.shift()!;
        const localPath = join(destDir, entry.path);
        const url = `${opts.endpoint}${PATHS.file(assetId, entry.path)}`;
        await downloadFile(url, localPath, true);
        downloaded++;
        if (!opts.json) {
          process.stdout.write(`\r  ${downloaded + skipped}/${remoteFiles.length}`);
        }
      }
    }

    if (toDownload.length > 0) {
      const workers = Array.from({ length: Math.min(concurrency, toDownload.length) }, () => worker());
      await Promise.all(workers);
    }

    // --delete: remove local files not in remote
    let deleted = 0;
    if (cmdOpts.delete) {
      const localFiles = listLocalFiles(destDir);
      for (const localRel of localFiles) {
        // Normalize separators for comparison
        const normalized = localRel.split("\\").join("/");
        if (!remotePaths.has(normalized)) {
          rmSync(join(destDir, localRel));
          deleted++;
        }
      }
    }

    if (opts.json) {
      output({ ok: true, downloaded, skipped, deleted, totalSize, dest: destDir }, true);
    } else {
      const parts: string[] = [];
      if (downloaded > 0) parts.push(`${downloaded} downloaded`);
      if (skipped > 0) parts.push(`${skipped} unchanged`);
      if (deleted > 0) parts.push(`${deleted} deleted`);
      console.log(`\nDone: ${parts.join(", ")}`);
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
