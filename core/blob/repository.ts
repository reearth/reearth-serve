import type { BlobRefKey } from "./model";

export type BlobState = "uploading" | "verifying" | "ready" | "deleting";

/** A row of the blob ledger (`blob_refs`, migration 0009). */
export interface BlobRef extends BlobRefKey {
  refCount: number;
  state: BlobState;
  claimId?: string;
  claimExpiresAt?: number;
  zeroSince?: number;
  createdAt: number;
  updatedAt: number;
}

/**
 * The blob ledger (ADR-017 §3, §5).
 *
 * Reference counts move only inside `AtomicWrites` — in the same batch that
 * creates or deletes the asset or version row — so a count can never disagree
 * with the rows that hold the key. This port has the transitions that happen
 * outside those writes: reserving a key before bytes are written, claiming
 * one for an upload session, settling verification, and the sweeps.
 *
 * Every transition is one conditional statement, so two Workers racing on the
 * same key cannot both win. `deleting` is the lock a sweep takes before it
 * removes an object: nothing reserves, claims or attaches to a key in that
 * state, so the object cannot be rewritten between the sweep's decision and
 * its delete.
 */
export interface BlobRefStore {
  find(key: string): Promise<BlobRef | null>;
  /**
   * Prepare a key for a store-verified write (a direct upload through the
   * Worker). Succeeds when the key is free, `ready`, or held by a claim that
   * has expired; the row is then `ready`, and if nothing references it yet its
   * grace clock restarts at `now` so no sweep can take it while the bytes are
   * in flight. False when another upload's claim, an unverified upload, or a
   * sweep holds the key: the caller stores at the classic key instead.
   */
  reserve(ref: BlobRefKey, now: number): Promise<boolean>;
  /**
   * Claim a key for an upload session that is not store-verified (presigned
   * multipart, or a presigned single PUT). Only a free key, or one whose claim
   * has expired, can be claimed — never one that holds bytes somebody may rely
   * on (ADR-017 §3, "one writer per blob").
   *
   * - `claimed`: the row is `uploading`, held by `claimId` until `expiresAt`.
   * - `busy`: another live claim holds it (the route answers 409).
   * - `exists`: the key holds, or is about to hold, bytes (`ready`,
   *   `verifying`, `deleting`).
   */
  claim(ref: BlobRefKey, claimId: string, expiresAt: number, now: number): Promise<"claimed" | "busy" | "exists">;
  /** Give up a claim that never completed (session creation failed). */
  releaseClaim(key: string, claimId: string): Promise<void>;
  /** The verification job confirmed the hash: `verifying` → `ready`. */
  markVerified(key: string, now: number): Promise<void>;
  /**
   * Lock an unreferenced blob for deletion: `ready` / `verifying` with
   * `ref_count = 0` and `zero_since <= zeroBefore` becomes `deleting`. False
   * when the row does not qualify (someone attached to it, or it is not old
   * enough).
   */
  markDeleting(key: string, zeroBefore: number, now: number): Promise<boolean>;
  /**
   * Lock a key that has no ledger row at all (an orphan): inserts a `deleting`
   * row only if none exists. False when a row appeared in the meantime.
   */
  markOrphanDeleting(ref: BlobRefKey, now: number): Promise<boolean>;
  /** Drop a `deleting` row once its object is gone. */
  removeDeleted(key: string): Promise<void>;
  /**
   * Keys the grace sweep should delete: unreferenced past `zeroBefore`, plus
   * any `deleting` row a crashed sweep left behind.
   */
  listSweepable(zeroBefore: number, limit: number): Promise<string[]>;
  /** Delete `uploading` claims that expired before `now`. Returns how many. */
  dropExpiredClaims(now: number, limit: number): Promise<number>;
  /** Which of `keys` have a ledger row. */
  existing(keys: string[]): Promise<Set<string>>;
}
