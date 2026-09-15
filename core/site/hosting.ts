/**
 * Reading `_headers` and `_redirects` out of a freshly extracted archive
 * (ADR-013 C3).
 *
 * **Who parses, and when.** The Worker does, once, when an extraction job
 * reports `completed` — not the Go container. The container streams entries
 * and must keep doing exactly that (ADR-011); teaching it a second file format
 * would put parsing, limits and a denylist in the one process that has no
 * business knowing what a header means. The two files are small and named in
 * advance, so reading them back after the fact is a couple of bounded `get`s
 * on a path that runs once per upload.
 *
 * The parsed result is stored as system metadata — on the version when the job
 * names one, on the asset when it does not (a first upload creates no version
 * row). Existing rows have no `hosting` and behave exactly as before.
 */

import { decompressStream } from "../asset/compression";
import type { FileStorage } from "../asset/repository";
import {
  boundHosting,
  MAX_CONTROL_FILE_BYTES,
  parseHeaders,
  parseRedirects,
  type SiteHosting,
} from "./rules";

/** The two names, at the root of the extracted tree. Never served (see the handler). */
export const HEADERS_FILE = "_headers";
export const REDIRECTS_FILE = "_redirects";

/** True for a request path that names one of the control files. */
export function isControlFile(filePath: string): boolean {
  return filePath === HEADERS_FILE || filePath === REDIRECTS_FILE;
}

/**
 * Where an extracted entry may live.
 *
 * Both layouts, in the same order the file handler tries them: the versioned
 * one first, the pre-ADR-005 one second. The Cloudflare launcher still passes
 * only the asset ID to the container, so a version's files land in the legacy
 * prefix in production; a probe that only knew the versioned key would find
 * nothing there.
 */
function candidateKeys(assetId: string, versionId: string | undefined, name: string): string[] {
  const keys: string[] = [];
  if (versionId) keys.push(`assets/${assetId}/v/${versionId}/files/${name}`);
  keys.push(`assets/${assetId}/files/${name}`);
  return keys;
}

type ControlFile = { kind: "text"; text: string } | { kind: "tooLarge" } | { kind: "missing" };

async function readControlFile(
  storage: FileStorage,
  keys: string[],
): Promise<ControlFile> {
  for (const key of keys) {
    const file = await storage.get(key);
    if (!file) continue;
    // The stored size bounds the read before a byte is decoded: a 2 GB file
    // named `_headers` must not be pulled into the Worker to be rejected.
    if (file.size > MAX_CONTROL_FILE_BYTES) {
      await file.body.cancel().catch(() => {});
      return { kind: "tooLarge" };
    }
    const body = file.contentEncoding === "gzip" ? decompressStream(file.body) : file.body;
    const text = await new Response(body).text();
    return { kind: "text", text };
  }
  return { kind: "missing" };
}

/**
 * Read and parse both control files for one extracted archive.
 *
 * Returns `null` when neither file is present, which is the common case and
 * the one that must leave no trace on the row.
 */
export async function readSiteHosting(
  storage: FileStorage,
  opts: { assetId: string; versionId?: string },
): Promise<SiteHosting | null> {
  const [headersFile, redirectsFile] = await Promise.all([
    readControlFile(storage, candidateKeys(opts.assetId, opts.versionId, HEADERS_FILE)),
    readControlFile(storage, candidateKeys(opts.assetId, opts.versionId, REDIRECTS_FILE)),
  ]);

  if (headersFile.kind === "missing" && redirectsFile.kind === "missing") return null;

  const warnings: string[] = [];
  let headers: SiteHosting["headers"] = [];
  let redirects: SiteHosting["redirects"] = [];

  if (headersFile.kind === "tooLarge") {
    warnings.push(`_headers ignored: the file is larger than ${MAX_CONTROL_FILE_BYTES} bytes`);
  } else if (headersFile.kind === "text") {
    const parsed = parseHeaders(headersFile.text);
    headers = parsed.rules;
    warnings.push(...parsed.warnings);
  }

  if (redirectsFile.kind === "tooLarge") {
    warnings.push(`_redirects ignored: the file is larger than ${MAX_CONTROL_FILE_BYTES} bytes`);
  } else if (redirectsFile.kind === "text") {
    const parsed = parseRedirects(redirectsFile.text);
    redirects = parsed.rules;
    warnings.push(...parsed.warnings);
  }

  return boundHosting({ headers, redirects, warnings });
}

/** Where a freshly parsed rule set belongs. */
export type HostingPlacement =
  | { on: "asset"; hosting: SiteHosting }
  | { on: "version"; versionId: string; hosting: SiteHosting }
  | null;

/**
 * The completion hook: one function, called from the internal job-status
 * route, which is the only place a job becomes `completed` (the Node runtime's
 * only launcher is `none`, and the cleanup cron can only fail a job).
 *
 * It answers *where* the rules go rather than writing them, so the asset-row
 * case can ride the same atomic write as the status mirror (ADR-012 §3) and
 * the version case can follow it immediately. Anything that goes wrong here is
 * logged and swallowed: a site whose `_redirects` could not be read is a site
 * without redirects, not a failed extraction.
 */
export async function hostingOnExtractionComplete(
  storage: FileStorage,
  job: { assetId: string; versionId?: string },
  asset: { type?: string } | null,
): Promise<HostingPlacement> {
  if (!asset || asset.type !== "archive") return null;
  try {
    const hosting = await readSiteHosting(storage, {
      assetId: job.assetId,
      versionId: job.versionId,
    });
    if (!hosting) return null;
    return job.versionId
      ? { on: "version", versionId: job.versionId, hosting }
      : { on: "asset", hosting };
  } catch (e) {
    console.error(`Failed to read site hosting rules for ${job.assetId}:`, e);
    return null;
  }
}

/**
 * The rules in force for one delivered request.
 *
 * The version's rules win when it has any, and the asset's stand in otherwise —
 * the same "versioned first, legacy second" order `locate()` uses for the bytes
 * themselves, so the rules and the files a request sees always come from the
 * same upload. A preview host resolves to a version before it reaches here, so
 * `v3--name` gets version 3's rules for free.
 */
export function hostingFor(
  asset: { hosting?: SiteHosting },
  version: { hosting?: SiteHosting } | null,
): SiteHosting | null {
  return version?.hosting ?? asset.hosting ?? null;
}
