import { createHash } from "node:crypto";
import { createWriteStream, existsSync, mkdirSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { Writable } from "node:stream";
import type { AssetMetadata, AssetVersion, FileEntry, Job } from "../shared/api";
import { loadConfig, loadCredentials, loadOrCreateSessionId } from "./config";
import { refreshAccessToken } from "./auth";

// --- Output helpers ---

export function output(data: unknown, json: boolean) {
  if (json) {
    console.log(JSON.stringify(data, null, 2));
  } else if (typeof data === "string") {
    console.log(data);
  } else {
    console.log(data);
  }
}

export function formatAsset(asset: AssetMetadata): string {
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

export function formatVersion(v: AssetVersion): string {
  const lines = [
    `ID:           ${v.id}`,
    `Asset:        ${v.assetId}`,
    `Version:      ${v.version}`,
    `Filename:     ${v.filename}`,
    `Content-Type: ${v.contentType}`,
    `Size:         ${formatBytes(v.size)}`,
    `Created:      ${new Date(v.createdAt).toISOString()}`,
  ];
  if (v.contentEncoding) lines.push(`Encoding:     ${v.contentEncoding}`);
  if (v.originalSize) lines.push(`Original:     ${formatBytes(v.originalSize)}`);
  if (v.type) lines.push(`Type:         ${v.type}`);
  if (v.status) lines.push(`Status:       ${v.status}`);
  if (v.archiveFormat) lines.push(`Archive:      ${v.archiveFormat}`);
  if (v.fileCount) lines.push(`Files:        ${v.fileCount}`);
  if (v.jobId) lines.push(`Job:          ${v.jobId}`);
  if (v.userMeta) lines.push(`User Meta:    ${JSON.stringify(v.userMeta)}`);
  return lines.join("\n");
}

export function formatJob(job: Job): string {
  const lines = [
    `ID:        ${job.id}`,
    `Asset:     ${job.assetId}`,
    `Type:      ${job.type}`,
    `Status:    ${job.status}`,
    `Updated:   ${new Date(job.updatedAt).toISOString()}`,
  ];
  if (job.startedAt) lines.push(`Started:   ${new Date(job.startedAt).toISOString()}`);
  if (job.completedAt) lines.push(`Completed: ${new Date(job.completedAt).toISOString()}`);
  if (job.totalFiles) {
    const pct = job.fileCount ? Math.round((job.fileCount / job.totalFiles) * 100) : 0;
    lines.push(`Progress:  ${job.fileCount ?? 0}/${job.totalFiles} files (${pct}%)`);
  } else if (job.fileCount) {
    lines.push(`Files:     ${job.fileCount}`);
  }
  if (job.extractedSize) lines.push(`Extracted: ${formatBytes(job.extractedSize)}`);
  if (job.error) lines.push(`Error:     ${job.error}`);
  return lines.join("\n");
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}

// --- HTTP helpers ---

const TOKEN_REFRESH_BUFFER_MS = 60 * 1000; // refresh 60s before expiry

export async function commonHeaders(): Promise<Record<string, string>> {
  const headers: Record<string, string> = {};
  let creds = loadCredentials();

  // Auto-refresh if token is expired or about to expire
  if (creds?.expiresAt && creds.expiresAt - Date.now() < TOKEN_REFRESH_BUFFER_MS) {
    const newToken = await refreshAccessToken();
    if (newToken) creds = loadCredentials();
  }

  if (creds) {
    headers["Authorization"] = `Bearer ${creds.accessToken}`;
    // Authenticated calls bind to the configured default project so upload
    // endpoints can enforce project scope. GET endpoints ignore this header.
    const defaultProject = loadConfig().defaultProject;
    if (defaultProject) headers["X-Project-Id"] = defaultProject;
  }
  if (!creds) {
    // Demo mode: always send session ID
    headers["X-Session-Id"] = loadOrCreateSessionId();
  }
  return headers;
}

export async function apiGet<T>(endpoint: string, path: string): Promise<T> {
  const res = await fetch(`${endpoint}${path}`, {
    headers: { ...(await commonHeaders()) },
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`${res.status}: ${body}`);
  }
  return res.json() as Promise<T>;
}

export async function apiPost<T>(endpoint: string, path: string, body?: unknown): Promise<T> {
  const headers: Record<string, string> = { ...(await commonHeaders()) };
  if (body) headers["Content-Type"] = "application/json";

  const res = await fetch(`${endpoint}${path}`, {
    method: "POST",
    headers,
    ...(body ? { body: JSON.stringify(body) } : {}),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`${res.status}: ${text}`);
  }
  return res.json() as Promise<T>;
}

export async function apiPatch<T>(endpoint: string, path: string, body?: unknown): Promise<T> {
  const headers: Record<string, string> = { ...(await commonHeaders()) };
  if (body) headers["Content-Type"] = "application/json";

  const res = await fetch(`${endpoint}${path}`, {
    method: "PATCH",
    headers,
    ...(body ? { body: JSON.stringify(body) } : {}),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`${res.status}: ${text}`);
  }
  return res.json() as Promise<T>;
}

export async function apiPut<T>(endpoint: string, path: string, body?: unknown): Promise<T> {
  const headers: Record<string, string> = { ...(await commonHeaders()) };
  if (body) headers["Content-Type"] = "application/json";

  const res = await fetch(`${endpoint}${path}`, {
    method: "PUT",
    headers,
    ...(body ? { body: JSON.stringify(body) } : {}),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`${res.status}: ${text}`);
  }
  return res.json() as Promise<T>;
}

export async function apiDelete(endpoint: string, path: string): Promise<void> {
  const res = await fetch(`${endpoint}${path}`, {
    method: "DELETE",
    headers: { ...(await commonHeaders()) },
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`${res.status}: ${body}`);
  }
}

// --- File helpers ---

export function parseSrc(src: string): { assetId: string; filePath: string | null } {
  const colonIdx = src.indexOf(":");
  if (colonIdx === -1) {
    return { assetId: src, filePath: null };
  }
  return { assetId: src.slice(0, colonIdx), filePath: src.slice(colonIdx + 1) };
}

export async function downloadFile(url: string, dest: string, force = false): Promise<boolean> {
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

export function localMd5(filePath: string): string {
  const data = readFileSync(filePath);
  return `md5:${createHash("md5").update(data).digest("hex")}`;
}

export function listLocalFiles(dir: string): string[] {
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

export async function* streamNdjson(endpoint: string, path: string): AsyncGenerator<FileEntry> {
  const res = await fetch(`${endpoint}${path}`, {
    headers: { ...(await commonHeaders()) },
  });
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

export async function collectFiles(endpoint: string, path: string): Promise<FileEntry[]> {
  const files: FileEntry[] = [];
  for await (const entry of streamNdjson(endpoint, path)) {
    files.push(entry);
  }
  return files;
}
