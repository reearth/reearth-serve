/**
 * Deduplication of presigned uploads after the fact (ADR-017 §4, post-review
 * change of 2026-11-10).
 *
 * A presigned upload session always uploads to its classic per-asset key: its
 * URL names the key, so a key that depended on what the scope holds would
 * tell the uploader. Once the uploaded bytes' hash is confirmed — at
 * completion when the store vouched for it, or when the integrity job
 * matches the declaration — and the scope holds a reusable blob with that
 * hash, the row is switched to the blob ("adoption") and the classic object
 * is retired.
 *
 * - The switch is one write: the row's `blob_key`, a conditional reference on
 *   the blob (it must still qualify, `stillAttachable`), and a `retired` row
 *   for the classic object. If the blob no longer qualifies the write fails
 *   as a whole and is repeated without adoption; the row stays on its classic
 *   key and nothing differs for anyone.
 * - The classic object is deleted by the grace sweep `BLOB_GRACE_MS` after
 *   the switch, never inline. A `/files` read or an extraction that resolved
 *   the classic key just before the switch keeps working, and the request
 *   that adopts does no extra store round trip that a non-adopting one does
 *   not.
 * - Responses, job rows, usage counters and the request's work are the same
 *   either way: the lookup runs for every declared upload whose hash is
 *   confirmed, and adoption only changes which statements ride in a write
 *   that happens anyway.
 * - A row's `blob_key` therefore moves at most once, classic → blob, and
 *   never back or between blobs (`ASSET_UPSERT_SQL` keeps an existing value).
 *
 * Only declared uploads are adopted: the declaration is what put the session
 * in a scope, and an undeclared upload behaves exactly as before ADR-017 §3.
 */
import type { AssetMetadata } from "../asset/model";
import type { BlobAdoption } from "../asset/repository";
import type { ProjectStore } from "../project/repository";
import { originalKey } from "./model";
import type { BlobRefStore } from "./repository";
import { BlobUnavailableError, blobScopeFor, findReusableBlob, reuseFailure } from "./usecase";

/**
 * The adoption a confirmed upload is written with, or null when the scope
 * holds no reusable blob with `sha256` (or the row is not adoptable: it is
 * already a blob, or has no scope).
 */
export async function findAdoption(
  blobRefs: BlobRefStore,
  scope: string | null | undefined,
  row: Pick<AssetMetadata, "id" | "filename" | "blobKey">,
  sha256: string,
  now = Date.now(),
): Promise<BlobAdoption | null> {
  if (!scope || row.blobKey) return null;
  const found = await findReusableBlob(blobRefs, scope, sha256, now);
  if (!found) return null;
  return { ref: found.ref, since: found.reuse.since, retire: { key: originalKey(row), scope, sha256 } };
}

/** `findAdoption` for an existing asset row: its scope comes from its project or demo session. */
export async function findAdoptionForAsset(
  deps: { blobRefs: BlobRefStore; projects: ProjectStore },
  asset: AssetMetadata,
  sha256: string,
  now = Date.now(),
): Promise<BlobAdoption | null> {
  if (asset.blobKey) return null;
  const scope = await blobScopeFor(deps.projects, asset.projectId, asset.sessionId);
  return findAdoption(deps.blobRefs, scope, asset, sha256, now);
}

/**
 * Run `write` with the adoption, and once more without it if the blob stopped
 * qualifying in between (the write failed on the conditional reference). Any
 * other failure is passed on. Adoption is an optimisation of storage, so
 * losing it is never an error.
 */
export async function writeWithAdoption(
  blobRefs: BlobRefStore | undefined,
  adoption: BlobAdoption | null,
  write: (adoption: BlobAdoption | null) => Promise<void>,
): Promise<BlobAdoption | null> {
  if (!adoption || !blobRefs) {
    await write(null);
    return null;
  }
  try {
    await write(adoption);
    return adoption;
  } catch (e) {
    const failure = await reuseFailure(blobRefs, adoption.ref.key, adoption.since, e);
    if (!(failure instanceof BlobUnavailableError)) throw failure;
    console.warn(`blobs: ${adoption.ref.key} stopped qualifying while ${adoption.retire.key} adopted it; the row stays on its own key`);
    await write(null);
    return null;
  }
}
