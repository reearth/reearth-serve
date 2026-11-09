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
 *   still read to its end and hashed (§4: finishing early would be a signal,
 *   and the hash is what makes the row `verified`), a mismatch is still
 *   `ChecksumMismatchError`, but nothing is written. The caller attaches with
 *   `BlobAttach.existing`, which fails the row write if the blob stopped
 *   qualifying meanwhile.
 * - An empty body with a declared hash is how a client asks for a version
 *   without transfer (§4). It is an ordinary upload of zero bytes: it reuses
 *   the blob when the scope has one, and otherwise its bytes (none) are checked
 *   against the declaration like any other body — a mismatch unless the
 *   declaration is the empty-string hash, in which case an empty file is
 *   stored. Nothing about other scopes enters into it.
 *
 * Runtime-agnostic (ADR-012): hashing goes through `FileStorage.digest`.
 */
import type { FileStorage } from "../asset/repository";
import { ChecksumMismatchError, EMPTY_SHA256 } from "../asset/integrity";
import type { BlobRefKey } from "./model";
import { BlobUnavailableError, findReusableBlob, placeDirectUpload, type BlobContext, type Placement } from "./usecase";

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
  /** The bytes were already stored and were not written by this upload. */
  reused: boolean;
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

  // Zero bytes cannot hash to anything but the empty-string SHA-256, so such
  // a declaration is satisfiable only by bytes the scope already holds. No
  // reservation, no write: there is nothing to put.
  if (file.size === 0 && declared && declared !== EMPTY_SHA256) {
    await file.body.cancel().catch(() => {});
    const reusable = blob ? await findReusableBlob(blob.refs, blob.scope, declared) : null;
    if (!reusable) throw new ChecksumMismatchError(declared, EMPTY_SHA256);
    return confirmReuse(storage, reusable, declared);
  }

  const placement: Placement = blob
    ? await placeDirectUpload(blob.refs, blob.scope, declared, classicKey, now)
    : { key: classicKey };

  if (placement.reuse && declared) {
    const { sha256 } = await storage.digest(file.body, file.size);
    if (sha256 !== declared) throw new ChecksumMismatchError(declared, sha256);
    return confirmReuse(storage, placement, declared);
  }

  // Declared or not, the store hands back the hash of what it stored, so the
  // row is `verified` either way (ADR-017 §2). A declared mismatch throws
  // here, before any row exists and with nothing stored.
  const stored = await storage.put(placement.key, file.body, file.contentType, file.size, {
    ...(file.contentEncoding && { contentEncoding: file.contentEncoding }),
    ...(declared && { sha256: declared }),
  });
  return { key: placement.key, ...(placement.ref && { ref: placement.ref }), reused: false, sha256: stored.sha256, size: file.size };
}

/**
 * The finalisation of a reused upload: a `head` of the blob where a fresh
 * upload has its `put`. It is one store round trip in place of another, it
 * confirms the object is there before a row is written to point at it, and it
 * supplies the size an empty-bodied request does not carry. The ledger's
 * `isReusable` already implies the object exists; a missing one here would
 * mean the ledger is wrong, and the upload is refused rather than recorded.
 *
 * Matching the write's cost exactly is not needed for §4: reuse only ever
 * happens inside the uploader's own scope, where "these bytes are already
 * here" is not a secret. An upload whose bytes exist only in another
 * workspace writes them like any fresh upload, so its timing is a fresh
 * upload's.
 */
async function confirmReuse(storage: FileStorage, placement: Placement, sha256: string): Promise<StoredDirectUpload> {
  const head = await storage.head(placement.key);
  if (!head) throw new BlobUnavailableError(placement.key);
  return { key: placement.key, ...(placement.ref && { ref: placement.ref }), reused: true, sha256, size: head.size };
}
