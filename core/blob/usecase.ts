/**
 * Where an upload's bytes go, and how blobs leave (ADR-017 §3, §5; phase P2).
 *
 * Placement. A declared hash gets a blob key, unless the ledger says the key
 * is not safe to write right now; then the upload is stored at the classic
 * per-asset key exactly as an undeclared one would be. Falling back never
 * changes what the client sees — the URL is ID-based either way.
 *
 * Deduplication (ADR-017 §4, phase P3). When the scope already holds the
 * declared bytes — the blob is `ready` and some row references it — the
 * upload reuses them: a direct upload still receives and hashes its whole
 * body but does not write it, and a presigned session issues no upload URL.
 * Only the uploader's own scope is ever looked up, so whether the bytes exist
 * in another workspace never changes what happens (the key differs).
 *
 * Otherwise:
 *
 * - A direct upload through the Worker is store-verified: a mismatch writes
 *   nothing, so writing a key that is `ready` but unreferenced (a reservation
 *   by a concurrent upload, or bytes in their grace period) can only write
 *   identical bytes. It reserves the key and writes.
 * - A presigned upload is not store-verified at write time (multipart never,
 *   a single PUT only if the store kept the checksum), so it may write only a
 *   key nobody else relies on: it claims a free key, gets 409 while another
 *   session's claim is live, and falls back to its classic key when the blob
 *   holds bytes that cannot be reused (`verifying`, `deleting`, or `ready`
 *   with no reference).
 *
 * Removal. Rows release references in the batch that deletes them; objects
 * are deleted only here, by the cleanup cron, a grace period after the count
 * reaches zero — or at once when the integrity job rejects bytes that only
 * the rejected upload referenced.
 */
import type { FileStorage } from "../asset/repository";
import type { KeyValue } from "../kv/port";
import type { SubrequestBudget } from "../cleanup/usecase";
import type { ProjectStore } from "../project/repository";
import type { BlobRef, BlobRefStore } from "./repository";
import { BLOB_GRACE_MS, BLOB_PREFIX, blobRefKey, blobScope, parseBlobKey, type BlobRefKey } from "./model";

/** What an upload needs to place declared bytes in the blob layer. */
export interface BlobContext {
  refs: BlobRefStore;
  /** `blobScope` of the asset's project. */
  scope: string;
}

/** The blob scope of an asset in `projectId` (none: a demo upload). See `blobScope`. */
export async function blobScopeFor(projects: ProjectStore, projectId: string | null | undefined): Promise<string> {
  if (!projectId) return blobScope(null);
  const project = await projects.find(projectId);
  return blobScope({ id: projectId, workspaceId: project?.workspaceId });
}

/**
 * Where to write an upload, and the blob it references when that is a blob
 * key. `reuse`: the blob already holds the declared bytes, so nothing is
 * written and the reference is attached with `existing` (see `BlobAttach`).
 */
export interface Placement {
  key: string;
  ref?: BlobRefKey;
  reuse?: true;
}

/**
 * True when an upload may reuse this blob instead of writing it: `ready`
 * (verified bytes, no sweep holding it) and referenced by at least one row.
 * A row is written only after its bytes are in place (§5) and an object is
 * deleted only once its count is zero, so a referenced `ready` blob has its
 * object. A `ready` row at zero does not qualify: it may be a reservation
 * whose upload failed and left nothing behind.
 */
export function isReusable(row: BlobRef | null): boolean {
  return row !== null && row.state === "ready" && row.refCount > 0;
}

/** The reusable blob for `sha256` in `scope`, as a placement, or null. Looks in that scope only. */
export async function findReusableBlob(blobRefs: BlobRefStore, scope: string, sha256: string): Promise<Placement | null> {
  const ref = blobRefKey(scope, sha256);
  return isReusable(await blobRefs.find(ref.key)) ? { key: ref.key, ref, reuse: true } : null;
}

/**
 * Placement of a direct (store-verified) upload: the existing blob when it
 * can be reused, else the blob key when the ledger lets this upload write it,
 * else `classicKey`.
 */
export async function placeDirectUpload(
  blobRefs: BlobRefStore,
  scope: string,
  sha256: string | undefined,
  classicKey: string,
  now = Date.now(),
): Promise<Placement> {
  if (!sha256) return { key: classicKey };
  const reusable = await findReusableBlob(blobRefs, scope, sha256);
  if (reusable) return reusable;
  const ref = blobRefKey(scope, sha256);
  if (await blobRefs.reserve(ref, now)) return { key: ref.key, ref };
  return { key: classicKey };
}

/**
 * An upload that reused a blob found it gone, or no longer reusable, when it
 * came to attach to it — the rows that referenced it were deleted while the
 * body was in flight. Its body has been consumed and not stored, so there is
 * nothing to record; the route answers 409 and the client uploads again,
 * which then writes the bytes in full.
 */
export class BlobUnavailableError extends Error {
  constructor(readonly key: string) {
    super(BLOB_UNAVAILABLE_MESSAGE);
    this.name = "BlobUnavailableError";
  }
}

export const BLOB_UNAVAILABLE_MESSAGE =
  "The stored copy of this content was deleted while the upload was in progress; nothing was stored. Upload again";

/**
 * Called when the row write of an upload that reused `key` failed. The
 * conditional attach (`BlobAttach.existing`) fails the write when the blob no
 * longer qualifies; reading the row again tells that apart from any other
 * failure without parsing a driver's error message. Returns the error to throw.
 */
export async function reuseFailure(blobRefs: BlobRefStore, key: string, error: unknown): Promise<unknown> {
  const row = await blobRefs.find(key).catch(() => undefined);
  if (row === undefined) return error;
  return isReusable(row) ? error : new BlobUnavailableError(key);
}

/**
 * Another upload session holds the claim on this blob (ADR-017 §3, "one
 * writer per blob"). The route answers 409; the client retries once that
 * session completes or expires.
 */
export class BlobClaimedError extends Error {
  constructor(readonly key: string) {
    super(BLOB_CLAIMED_MESSAGE);
    this.name = "BlobClaimedError";
  }
}

export const BLOB_CLAIMED_MESSAGE =
  "Another upload of the same content is in progress in this workspace; retry once it completes or its session expires";

/**
 * Placement of a presigned upload session with a declared hash: the existing
 * blob when it can be reused (the session then uploads nothing); otherwise a
 * claim on the blob key until the session expires, or `classicKey` when the
 * blob holds bytes that cannot be reused. Throws `BlobClaimedError` while
 * another session's claim is live.
 */
export async function placeSessionUpload(
  blobRefs: BlobRefStore,
  scope: string,
  sha256: string | undefined,
  classicKey: string,
  claim: { id: string; expiresAt: number },
  now = Date.now(),
  /** A further check on reusable bytes; false treats them as not reusable. */
  canReuse?: (key: string) => Promise<boolean>,
): Promise<Placement> {
  if (!sha256) return { key: classicKey };
  const reusable = await findReusableBlob(blobRefs, scope, sha256);
  if (reusable && (!canReuse || await canReuse(reusable.key))) return reusable;
  const ref = blobRefKey(scope, sha256);
  const outcome = await blobRefs.claim(ref, claim.id, claim.expiresAt, now);
  if (outcome === "busy") throw new BlobClaimedError(ref.key);
  if (outcome === "exists") return { key: classicKey };
  return { key: ref.key, ref };
}

/** Any age: for a blob whose bytes are known bad, the grace period does not apply. */
const ANY_AGE = Number.MAX_SAFE_INTEGER;

/**
 * Delete a blob the integrity job rejected — but only while nothing else
 * references it (ADR-017 §3). The rejected row's reference has already been
 * released; if another row still holds the key, the bytes stay. Returns
 * whether the object was deleted.
 *
 * Deduplication does not change this: only a `ready` blob is reused, and a
 * rejected blob is one that never left `verifying`, so the rejected upload's
 * claim is normally its only reference and `markDeleting` (which requires a
 * count of zero) is what keeps bytes another row holds.
 */
export async function discardRejectedBlob(
  blobRefs: BlobRefStore,
  storage: FileStorage,
  key: string,
  now = Date.now(),
): Promise<boolean> {
  if (!(await blobRefs.markDeleting(key, ANY_AGE, now))) return false;
  await storage.delete(key);
  await blobRefs.removeDeleted(key);
  return true;
}

/**
 * Drop the claim of a session whose upload was refused at completion (the
 * store's hash differs from the declared one). The object goes first: until
 * the claim is released nobody else may write the key, so the delete cannot
 * hit bytes another upload put there.
 */
export async function discardClaimedUpload(
  blobRefs: BlobRefStore,
  storage: FileStorage,
  key: string,
  claimId: string,
): Promise<void> {
  await storage.delete(key);
  await blobRefs.releaseClaim(key, claimId);
}

/** Rows per tick for the grace sweep and the expired-claim purge. */
const SWEEP_BATCH = 100;
/** `blobs/` keys listed per tick by the orphan reconciliation (ADR-017 §5). */
export const ORPHAN_PAGE_SIZE = 200;
/** Where the orphan reconciliation's listing cursor is kept between ticks. */
export const ORPHAN_CURSOR_KEY = "blob-sweep:orphan-cursor";
// Longer than a cron period; if it lapses the listing simply starts over.
const ORPHAN_CURSOR_TTL_SECONDS = 24 * 3600;

export interface BlobSweepResult {
  droppedClaims: number;
  /** Unreferenced blobs past the grace period, deleted. */
  swept: string[];
  /** Objects in `blobs/` with no ledger row, deleted. */
  orphans: string[];
  budgetExhausted: boolean;
}

/**
 * One cleanup-cron pass over the blob layer:
 *
 * 1. drop `uploading` claims whose session has expired (a partial multipart
 *    upload is left to the store's own abort policy, as before ADR-017);
 * 2. delete blobs that have had no reference for `BLOB_GRACE_MS`;
 * 3. reconcile one page of `blobs/` against the ledger and delete objects
 *    that have no row and were written more than `BLOB_GRACE_MS` ago — bytes
 *    whose row write failed after they landed. The page cursor is kept in
 *    `cache` between ticks; losing it restarts the listing, nothing more.
 *
 * Every delete first takes the `deleting` lock in the ledger, so an upload
 * that reserves the key at the same moment either wins (and the sweep backs
 * off) or sees the lock and stores at its classic key.
 */
export async function sweepBlobs(
  deps: { blobRefs: BlobRefStore; storage: FileStorage; cache: KeyValue },
  budget: SubrequestBudget,
  now = Date.now(),
): Promise<BlobSweepResult> {
  const result: BlobSweepResult = { droppedClaims: 0, swept: [], orphans: [], budgetExhausted: false };
  const zeroBefore = now - BLOB_GRACE_MS;

  if (!budget.canAfford(2)) return { ...result, budgetExhausted: true };
  result.droppedClaims = await deps.blobRefs.dropExpiredClaims(now, SWEEP_BATCH);
  const due = await deps.blobRefs.listSweepable(zeroBefore, SWEEP_BATCH);
  budget.charge(2);

  for (const key of due) {
    // lock + delete + row removal, plus a find for a lock a crashed sweep left
    if (!budget.canAfford(4)) return { ...result, budgetExhausted: true };
    let locked = await deps.blobRefs.markDeleting(key, zeroBefore, now);
    budget.charge();
    if (!locked) {
      locked = (await deps.blobRefs.find(key))?.state === "deleting";
      budget.charge();
    }
    if (!locked) continue;
    await deps.storage.delete(key);
    await deps.blobRefs.removeDeleted(key);
    budget.charge(2);
    result.swept.push(key);
  }

  // cursor read + list + ledger lookup + cursor write
  if (!budget.canAfford(4)) return { ...result, budgetExhausted: true };
  const cursor = (await deps.cache.get(ORPHAN_CURSOR_KEY)) ?? undefined;
  const page = await deps.storage.list(BLOB_PREFIX, { limit: ORPHAN_PAGE_SIZE, cursor });
  const known = await deps.blobRefs.existing(page.keys);
  budget.charge(3);

  for (const key of page.keys) {
    if (known.has(key)) continue;
    const ref = parseBlobKey(key);
    if (!ref) continue; // not ours to judge
    // head + lock + delete + row removal, keeping one for the cursor write
    if (!budget.canAfford(5)) {
      // Resume at this page next time rather than skipping what is left of it.
      return { ...result, budgetExhausted: true };
    }
    const head = await deps.storage.head(key);
    budget.charge();
    if (head?.uploadedAt === undefined || head.uploadedAt > zeroBefore) continue;
    if (!(await deps.blobRefs.markOrphanDeleting({ key, ...ref }, now))) {
      budget.charge();
      continue;
    }
    await deps.storage.delete(key);
    await deps.blobRefs.removeDeleted(key);
    budget.charge(3);
    result.orphans.push(key);
  }

  if (page.cursor) await deps.cache.put(ORPHAN_CURSOR_KEY, page.cursor, { ttlSeconds: ORPHAN_CURSOR_TTL_SECONDS });
  else if (cursor) await deps.cache.delete(ORPHAN_CURSOR_KEY);
  budget.charge();
  return result;
}
