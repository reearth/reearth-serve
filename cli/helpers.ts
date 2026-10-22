import { createHash } from "node:crypto";
import { createWriteStream, existsSync, mkdirSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { Writable } from "node:stream";
import type { AssetMetadata, AssetVersion, FileEntry, Job } from "../shared/api";
import { loadConfig, loadCredentials, loadOrCreateSessionId, loadSessionId, saveSessionId } from "./config";
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
  // Hosting switches (ADR-013). Both are server-side defaults when absent, so
  // they are only printed when the server actually reports them.
  if (asset.access) lines.push(`Access:       ${asset.access}`);
  if (asset.spa !== undefined) lines.push(`SPA:          ${asset.spa ? "on" : "off"}`);
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
  lines.push(...formatHosting(v.hosting));
  return lines.join("\n");
}

/**
 * The `_headers` / `_redirects` summary (ADR-013 C3).
 *
 * Counts, then every warning on its own line: a rule the author wrote and the
 * parser refused is invisible on the site itself, so the only place it can be
 * noticed is here and in the API response this reads.
 */
function formatHosting(hosting: AssetVersion["hosting"]): string[] {
  if (!hosting) return [];
  const counts = `${hosting.headers.length} header rule(s), ${hosting.redirects.length} redirect rule(s)`;
  const lines = [`Hosting:      ${counts}`];
  for (const warning of hosting.warnings) lines.push(`  warning:    ${warning}`);
  return lines;
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

/** `on` / `off`, the spelling every boolean switch in this CLI takes. */
export function parseOnOff(value: string, flag: string): boolean {
  if (value === "on") return true;
  if (value === "off") return false;
  throw new Error(`${flag} takes on or off`);
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

/**
 * Adopt a server-issued session ID from a response.
 *
 * The server only trusts session IDs it issued itself: when a request
 * carries an unknown or expired X-Session-Id, the server mints a fresh one
 * and returns it in the response's X-Session-Id header. Persist it so the
 * next request (e.g. completing an upload session created in this request)
 * is attributed to the same session — otherwise multi-request flows like
 * presigned uploads fail their ownership check.
 */
export function adoptSessionId(res: Response): void {
  if (loadCredentials()) return;
  const issued = res.headers.get("X-Session-Id");
  if (issued && issued !== loadSessionId()) {
    saveSessionId(issued);
  }
}

export async function apiGet<T>(endpoint: string, path: string): Promise<T> {
  const res = await fetch(`${endpoint}${path}`, {
    headers: { ...(await commonHeaders()) },
  });
  adoptSessionId(res);

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
  adoptSessionId(res);

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
  adoptSessionId(res);

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
  adoptSessionId(res);

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
  adoptSessionId(res);

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

export async function downloadFile(
  url: string,
  dest: string,
  force = false,
  headers: Record<string, string> = {},
): Promise<boolean> {
  if (!force && existsSync(dest)) {
    return false; // skipped
  }
  const res = await fetch(url, { headers });
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

export async function* streamNdjson(
  endpoint: string,
  path: string,
  extraHeaders: Record<string, string> = {},
): AsyncGenerator<FileEntry> {
  const res = await fetch(`${endpoint}${path}`, {
    headers: { ...extraHeaders, ...(await commonHeaders()) },
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

export async function collectFiles(
  endpoint: string,
  path: string,
  extraHeaders: Record<string, string> = {},
): Promise<FileEntry[]> {
  const files: FileEntry[] = [];
  for await (const entry of streamNdjson(endpoint, path, extraHeaders)) {
    files.push(entry);
  }
  return files;
}

// --- Site passwords (ADR-013 B7) ---

/**
 * Where a site password may come from, in order: the environment (so a script
 * or a CI job can set it once) and `--password`, which prompts.
 *
 * Never a command-line *value*: an argument is visible in `ps`, in shell
 * history and in CI logs, which is exactly what a shared password must not be.
 */
export const SITE_PASSWORD_ENV = "REEARTH_SERVE_SITE_PASSWORD";

/**
 * Read a password without echoing it.
 *
 * `readline` is put in raw mode and the terminal is written to directly, so
 * nothing lands in the scrollback. With no TTY (a pipe, a CI runner) the
 * environment variable is the supported route and this refuses rather than
 * silently reading a line from stdin.
 */
export async function promptPassword(label: string): Promise<string> {
  const { createInterface } = await import("node:readline");
  if (!process.stdin.isTTY) {
    throw new Error(`${label} requires a terminal; set ${SITE_PASSWORD_ENV} instead`);
  }
  const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: true });
  try {
    return await new Promise<string>((resolve) => {
      const onKeypress = (chunk: Buffer | string) => {
        // Re-print the prompt without the characters readline just echoed.
        const text = String(chunk);
        if (text !== "\r" && text !== "\n") {
          process.stdout.write(`\r[2K${label}: `);
        }
      };
      process.stdin.on("data", onKeypress);
      rl.question(`${label}: `, (answer) => {
        process.stdin.off("data", onKeypress);
        process.stdout.write("\n");
        resolve(answer);
      });
    });
  } finally {
    rl.close();
  }
}

/** Ask twice and refuse a mismatch — a typo here locks a site out of itself. */
export async function promptPasswordTwice(): Promise<string> {
  const first = await promptPassword("Password");
  const second = await promptPassword("Confirm password");
  if (first !== second) throw new Error("Passwords do not match");
  return first;
}

/**
 * The `Authorization: Basic` header a protected site's files are fetched with,
 * or `{}` when no password is configured.
 *
 * The user half is ignored by the server, so it is a fixed label rather than
 * anything about the caller.
 */
export function basicAuthHeader(password: string | undefined): Record<string, string> {
  if (!password) return {};
  return { Authorization: `Basic ${Buffer.from(`viewer:${password}`).toString("base64")}` };
}

/**
 * Resolve a site password for a download command: the environment first, then
 * `--password`, which prompts.
 */
export async function resolveSitePassword(flag: boolean | undefined): Promise<string | undefined> {
  const fromEnv = process.env[SITE_PASSWORD_ENV];
  if (fromEnv) return fromEnv;
  if (!flag) return undefined;
  return promptPassword("Site password");
}
