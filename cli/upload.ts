import { readFileSync, statSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { lookup } from "./mime";
import { PATHS } from "../shared/paths";
import { apiPatch, apiPost, promptPasswordTwice, SITE_PASSWORD_ENV } from "./helpers";
import { loadCredentials } from "./config";
import type { AssetMetadata, AssetUploadResult, SiteHost } from "../shared/api";
import { output } from "./helpers";
import { zipDirectory } from "./zip";
import {
  bufferSource, preparePayload, uploadDirect, uploadLargeFile, uploadVersionDirect, uploadViaSession,
} from "./transfer";

/** Over this size `upload` streams the file from disk instead of reading it into memory. */
const LARGE_FILE_THRESHOLD = 1024 * 1024 * 1024; // 1 GiB

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
  if (!opts.direct && fileSize > LARGE_FILE_THRESHOLD) {
    const large = await uploadLargeFile(opts.endpoint, filePath, fileName, contentType, fileSize, opts.skipExtraction);
    if (!large) {
      console.error("Error: Server does not support presigned uploads; file is too large for direct upload.");
      process.exit(1);
    }
    await finish(large, opts);
    return;
  }

  const payload = preparePayload(fileName, contentType, new Uint8Array(readFileSync(filePath)), opts.skipExtraction);
  const direct = () => uploadDirect(opts.endpoint, payload);

  let result: AssetUploadResult;
  if (opts.direct) {
    result = await direct();
  } else {
    const presigned = await uploadViaSession(opts.endpoint, {
      fileName, contentType, originalSize: payload.originalSize, encoding: payload.encoding, sha256: payload.sha256,
      skipExtraction: payload.skipExtraction, source: bufferSource(payload.data),
    });
    result = presigned ?? await direct();
  }

  await finish(result, opts);
}

/** Options of `asset upload <id> <file>`. */
export interface VersionUploadOptions {
  endpoint: string;
  json: boolean;
  skipExtraction?: boolean;
  /**
   * How long to wait, in minutes, while the asset's first upload is still
   * being verified (ADR-017 P5). 0 fails at once.
   */
  waitMinutes: number;
}

/**
 * `asset upload <id> <file>`: a new version, always through the Worker (the
 * server has no upload sessions for versions). Declares the hash like every
 * upload and sends the whole file.
 */
export async function doUploadVersion(assetId: string, filePath: string, opts: VersionUploadOptions): Promise<void> {
  try {
    statSync(filePath);
  } catch {
    console.error(`Error: File not found: ${filePath}`);
    process.exit(1);
  }
  const fileName = basename(filePath);
  const payload = preparePayload(fileName, lookup(fileName), new Uint8Array(readFileSync(filePath)), opts.skipExtraction);
  const data = await uploadVersionDirect(opts.endpoint, assetId, payload, opts.waitMinutes * 60_000);
  if (opts.json) {
    output(data, true);
  } else {
    console.log(`Version ${data.version.version} created: ${data.version.id}`);
    console.log(data.url);
  }
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
