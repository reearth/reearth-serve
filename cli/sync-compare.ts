import { existsSync, statSync } from "node:fs";
import type { FileEntry } from "../shared/api";
import { md5File, sha256File } from "./hash";

/**
 * Whether the local file already holds the remote entry's bytes, so
 * `file sync` can skip it.
 *
 * In order of trust:
 *
 * 1. The ledger's SHA-256 (ADR-017), when the entry has one that is
 *    `verified` and the stored bytes are what the download writes — not
 *    `contentEncoding: gzip`, where the hash names the compressed bytes and
 *    the local file holds the decompressed ones. A size mismatch settles it
 *    without reading the file.
 * 2. `hash` (`md5:<hex>`): the store's ETag for a single file, which is not an
 *    MD5 after a multipart upload, or the extractor's MD5 for an archive entry.
 * 3. Size alone, for entries with neither.
 *
 * Rows stored before ADR-017 that the backfill has not hashed, and uploads
 * still `pending` verification, carry no usable SHA-256 and take 2 or 3.
 * A local file is read only when a hash comparison is actually needed, and
 * then streamed.
 */
export async function isUnchanged(entry: FileEntry, localPath: string): Promise<boolean> {
  if (!existsSync(localPath)) return false;
  const localSize = statSync(localPath).size;
  if (entry.sha256 && entry.integrity === "verified" && !entry.contentEncoding) {
    if (localSize !== entry.size) return false;
    return (await sha256File(localPath)) === entry.sha256;
  }
  if (entry.hash) return (await md5File(localPath)) === entry.hash;
  return localSize === entry.size;
}
