/**
 * The bytes of a direct upload through the Worker (ADR-017 §2–§4): where they
 * go, and whether they are written at all.
 *
 * Shared by the first upload (`uploadAsset`) and a new version
 * (`uploadVersion`), which differ only in the row they write afterwards.
 *
 * - No declared hash, or a blob key this upload may write: `storage.put`, as
 *   before. The store verifies a declared hash and writes nothing on a
 *   mismatch.
 * - The scope already holds the declared bytes (`isReusable`): the body is
 *   still read to its end and hashed, a mismatch is still
 *   `ChecksumMismatchError`, but nothing is written. The caller attaches with
 *   `BlobAttach.existing`, which fails the row write if the blob stopped
 *   qualifying meanwhile. This path needs the whole body: what it saves is a
 *   second copy in storage, never the transfer (ADR-017 §4).
 * - An empty body is an upload of zero bytes and nothing else. With a declared
 *   hash other than the empty-string SHA-256 it is a mismatch (422), decided
 *   before the ledger is consulted: there is no way to ask for stored bytes by
 *   hash alone.
 *
 * Runtime-agnostic (ADR-012): hashing goes through `FileStorage.digest`.
 */
import type { FileStorage } from "../asset/repository";
import { ChecksumMismatchError, EMPTY_SHA256 } from "../asset/integrity";
import type { BlobRefKey } from "./model";
import { BlobUnavailableError, placeDirectUpload, type BlobContext, type Placement } from "./usecase";

export interface DirectUploadBody {
  body: ReadableStream<Uint8Array>;
  /** Content-Length: the number of bytes `body` must deliver. */
  size: number;
  contentType: string;
  contentEncoding?: string;
  /** Declared SHA-256 of `body`, lowercase hex. */
  sha256?: string;
}

export interface StoredDirectUpload {
  /** Storage key of the bytes: the blob key, or `classicKey`. */
  key: string;
  /** The blob the row must reference, when `key` is one. */
  ref?: BlobRefKey;
  /**
   * The bytes were already stored and were not written by this upload; the
   * blob was found reusable at `since` (for `BlobAttach.existing`).
   */
  reuse?: { since: number };
  /** SHA-256 of the stored bytes. */
  sha256: string;
  /** Size of the stored bytes. */
  size: number;
}

export async function storeDirectUpload(
  storage: FileStorage,
  blob: BlobContext | undefined,
  file: DirectUploadBody,
  classicKey: string,
  now = Date.now(),
): Promise<StoredDirectUpload> {
  const declared = file.sha256;

  // Zero bytes hash to the empty-string SHA-256 and to nothing else. The
  // answer does not depend on what the scope holds, so the ledger is not
  // looked at: a hash-only request is just a wrong declaration.
  if (file.size === 0 && declared && declared !== EMPTY_SHA256) {
    await file.body.cancel().catch(() => {});
    throw new ChecksumMismatchError(declared, EMPTY_SHA256);
  }

  const placement: Placement = blob
    ? await placeDirectUpload(blob.refs, blob.scope, declared, classicKey, now)
    : { key: classicKey };

  if (placement.reuse && declared) {
    const { sha256 } = await storage.digest(file.body, file.size);
    if (sha256 !== declared) throw new ChecksumMismatchError(declared, sha256);
    return confirmReuse(storage, placement, declared, placement.reuse);
  }

  // Declared or not, the store hands back the hash of what it stored, so the
  // row is `verified` either way (ADR-017 §2). A declared mismatch throws
  // here, before any row exists and with nothing stored.
  const stored = await storage.put(placement.key, file.body, file.contentType, file.size, {
    ...(file.contentEncoding && { contentEncoding: file.contentEncoding }),
    ...(declared && { sha256: declared }),
  });
  return { key: placement.key, ...(placement.ref && { ref: placement.ref }), sha256: stored.sha256, size: file.size };
}

/**
 * The finalisation of an upload whose bytes the scope already held: a `head`
 * of the blob where a fresh upload has its `put`.
 *
 * Why this is comparable enough. Up to the last byte the two paths do the
 * same thing at the client's pace: read the whole body and hash it (`digest`
 * here, the store's own hashing inside `put` there). What remains after the
 * last byte is one store round trip in each — the `put`'s commit, or this
 * `head` — followed by the same row write and the same response. The `head`
 * is not filler: it confirms the object is there before a row is written to
 * point at it (the ledger's `isReusable` already implies it; a missing object
 * means the ledger is wrong, and the upload is refused rather than recorded).
 * Writing the bytes again to equalise the cost exactly was rejected: it gives
 * up the write it saves for a difference of one round trip's variance, which
 * edge timing noise already swamps. The residual is listed in ADR-017's open
 * issues.
 */
async function confirmReuse(
  storage: FileStorage,
  placement: Placement,
  sha256: string,
  reuse: { since: number },
): Promise<StoredDirectUpload> {
  const head = await storage.head(placement.key);
  if (!head) throw new BlobUnavailableError(placement.key);
  return { key: placement.key, ...(placement.ref && { ref: placement.ref }), reuse, sha256, size: head.size };
}
