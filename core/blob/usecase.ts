/**
 * Where an upload's bytes go, and how blobs leave (ADR-017 §3, §5; phases
 * P2–P3, amended by the post-review change of 2026-11-10).
 *
 * Deduplication is never visible to the uploader (ADR-017 §4). The uploader
 * always sends the whole file and the server always reads it; what a
 * duplicate saves is storage, silently.
 *
 * - A direct upload through the Worker is store-verified: a mismatch writes
 *   nothing. A declared hash gets the blob key. When the scope already holds
 *   those bytes (`isReusable`) the body is still read to its end and hashed,
 *   then discarded instead of written (core/blob/direct-upload.ts);
 *   otherwise the upload reserves the key and writes. When the key is held
 *   by a sweep or by an unverified upload, the upload goes to its classic
 *   key. The response is the same in every case.
 * - A presigned upload session always uploads to its classic per-asset key.
 *   Its URL names the key, so a key that depended on what the scope holds
 *   would tell the uploader. Once the bytes' hash is confirmed, the row is
 *   switched to the scope's identical blob if there is one, and the classic
 *   object is retired (core/blob/adoption.ts). Sessions never write a blob
 *   key, so nothing else can race them for one, and there is no claim.
 *
 * Only the uploader's own scope is ever looked up, so whether the bytes exist
 * in another workspace never changes what happens (the key differs).
 *
 * Removal. Rows release references in the batch that deletes them; objects
 * are deleted only here, by the cleanup cron, a grace period after the count
 * reaches zero (or after a classic object was retired) — or at once when the
 * integrity job rejects bytes that only the rejected upload referenced.
 */
import type { FileStorage } from "../asset/repository";
import type { KeyValue } from "../kv/port";
import type { SubrequestBudget } from "../cleanup/usecase";
import type { ProjectStore } from "../project/repository";
import type { BlobRef, BlobRefStore } from "./repository";
import { attachThreshold, BLOB_GRACE_MS, BLOB_PREFIX, blobRefKey, blobScope, parseBlobKey, type BlobRefKey } from "./model";

/** What an upload needs to place declared bytes in the blob layer. */
export interface BlobContext {
  refs: BlobRefStore;
  /** `blobScope` of the asset's project, or of the demo session. */
  scope: string;
}

/**
 * The blob scope of an asset in `projectId`, or of a demo upload by
 * `sessionId` when there is no project. See `blobScope`; null when a demo
 * upload has no usable session ID.
 */
export async function blobScopeFor(
  projects: ProjectStore,
  projectId: string | null | undefined,
  sessionId?: string | null,
): Promise<string | null> {
  if (!projectId) return blobScope(null, sessionId);
  const project = await projects.find(projectId);
  return blobScope({ id: projectId, workspaceId: project?.workspaceId });
}

/**
 * Where to write a direct upload, and the blob it references when that is a
 * blob key. `reuse`: the blob already holds the declared bytes, so nothing is
 * written and the reference is attached with `existing` (see `BlobAttach`);
 * `since` is when the blob was looked up, which the attach needs.
 */
export interface Placement {
  key: string;
  ref?: BlobRefKey;
  reuse?: { since: number };
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

/**
 * Whether a blob found reusable at `since` can still be attached to: `ready`,
 * and either still referenced or unreferenced only since after `since`.
 *
 * Why the second case is safe: a blob that was referenced at `since` had no
 * `zero_since`; if its last row was deleted afterwards, `zero_since` is later
 * than `since`, and no sweep may take it (`markDeleting`) until
 * `BLOB_GRACE_MS` after that. So its object is still there for a day. A
 * `ready` row at zero that was never referenced after `since` — a
 * reservation by an upload that failed — has an older `zero_since`, or a
 * re-reservation's newer one only after a sweep had to wait out the grace
 * period first. Uploads take minutes, not a day, so in practice the attach
 * fails only if the ledger is wrong. The skew allowance loosens the check by
 * minutes against a grace period of a day.
 *
 * Mirrored in SQL by `blobAttachExistingStatements` (adapters/sql/blob-refs.ts).
 */
export function stillAttachable(row: BlobRef | null, since: number): boolean {
  if (row === null || row.state !== "ready") return false;
  return row.refCount > 0 || (row.zeroSince !== undefined && row.zeroSince >= attachThreshold(since));
}

/**
 * The reusable blob for `sha256` in `scope`, as a placement, or null. Looks in
 * that scope only. `since` is taken before the lookup, so any later release
 * of the blob's last reference is stamped after it.
 */
export async function findReusableBlob(
  blobRefs: BlobRefStore,
  scope: string,
  sha256: string,
  now = Date.now(),
): Promise<(Placement & { ref: BlobRefKey; reuse: { since: number } }) | null> {
  const ref = blobRefKey(scope, sha256);
  return isReusable(await blobRefs.find(ref.key)) ? { key: ref.key, ref, reuse: { since: now } } : null;
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
  const reusable = await findReusableBlob(blobRefs, scope, sha256, now);
  if (reusable) return reusable;
  const ref = blobRefKey(scope, sha256);
  if (await blobRefs.reserve(ref, now)) return { key: ref.key, ref };
  return { key: classicKey };
}

/**
 * A direct upload that read its body to the end but did not store it found,
 * when it came to write its row, that it could not reference the stored
 * copy it meant to share. Nothing was recorded; the route answers 409 and the
 * client uploads again, which then writes the bytes in full.
 *
 * With `stillAttachable` this needs the ledger to disagree with the store
 * (the object missing under a referenced blob) or an upload that took longer
 * than `BLOB_GRACE_MS`. The message says only that the upload must be
 * repeated: it is the one answer only a duplicate can get, so it does not
 * name the duplicate.
 */
export class BlobUnavailableError extends Error {
  constructor(readonly key: string) {
    super(BLOB_UNAVAILABLE_MESSAGE);
    this.name = "BlobUnavailableError";
  }
}

export const BLOB_UNAVAILABLE_MESSAGE =
  "The upload could not be stored because of a concurrent change; nothing was stored. Upload again";

/**
 * Called when the row write of an upload that attaches to an existing blob
 * failed. The conditional attach (`BlobAttach.existing`) fails the write when
 * the blob no longer qualifies; reading the row again tells that apart from
 * any other failure without parsing a driver's error message. Returns the
 * error to throw (or, for adoption, to fall back on).
 */
export async function reuseFailure(blobRefs: BlobRefStore, key: string, since: number, error: unknown): Promise<unknown> {
  const row = await blobRefs.find(key).catch(() => undefined);
  if (row === undefined) return error;
  return stillAttachable(row, since) ? error : new BlobUnavailableError(key);
}

/** Any age: for a blob whose bytes are known bad, the grace period does not apply. */
const ANY_AGE = Number.MAX_SAFE_INTEGER;

/**
 * Delete a blob the integrity job rejected — but only while nothing else
 * references it (ADR-017 §3). The rejected row's reference has already been
 * released; if another row still holds the key, the bytes stay. Returns
 * whether the object was deleted.
 *
 * Only rows written before the post-review change can reach this: a blob is
 * `verifying` only when a presigned session claimed it, and sessions no
 * longer write blob keys. Kept so such rows still settle correctly. Only a
 * `ready` blob is reused, so the rejected upload's reference is normally the
 * only one, and `markDeleting` (which requires a count of zero) is what keeps
 * bytes another row holds.
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
 * 1. drop `uploading` claims whose session has expired (only claims written
 *    before the post-review change exist; sessions no longer claim);
 * 2. delete blobs that have had no reference for `BLOB_GRACE_MS`, and
 *    classic objects retired by adoption `BLOB_GRACE_MS` ago;
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
