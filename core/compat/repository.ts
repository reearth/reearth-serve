/**
 * The compat_* tables behind one port (ADR-019).
 *
 * `claim`, `bind`, `releaseClaim`, `lease`, `records` and `updateUpload`
 * are each one atomic step with compare-and-set semantics, so two writers
 * racing on one key or one upload session cannot both win.
 */
import type {
  Binding, BindingKind, BucketName, CompatBucket, CompatCredential, CredentialId,
  ExactHashes, FolderKey, ObjectInfo, ObjectKey, UploadId, UploadPhase, UploadSession,
} from "./model";

export type BindingKey = ObjectKey | FolderKey;

export type ClaimToken = string & { readonly __brand: "ClaimToken" };

export function newClaimToken(): ClaimToken {
  return crypto.randomUUID() as ClaimToken;
}

export type LeaseToken = string & { readonly __brand: "LeaseToken" };

export function newLeaseToken(): LeaseToken {
  return crypto.randomUUID() as LeaseToken;
}

/**
 * A new bucket's high mark: the clock in microseconds. A deleted bucket of the
 * same name issued fewer generations than microseconds it lived, so a
 * recreated bucket never reissues one of them.
 */
export function generationSeed(): number {
  return Date.now() * 1000;
}

/** A version's generation, and its exact hashes when a layer write stored them. */
export type VersionRecord = { generation: number; hashes: ExactHashes | null };

/** A version `records` reads or stores: the asset or version id, its asset, and the hashes a layer write computed. */
export type RecordRef = { objectRef: string; assetId: string; hashes?: ExactHashes };

export type ClaimResult =
  /** This call inserted the claim or took over a stale one. `token` guards bind and release. */
  | { kind: "claimed"; token: ClaimToken }
  /** The key already names an asset. */
  | { kind: "bound"; binding: Binding }
  /** Another writer's fresh claim holds the key. Retryable. */
  | { kind: "busy" };

export type DeleteBucketResult = "deleted" | "absent" | "not_empty";

/**
 * A resumable commit's publish (ADR-019 §3), applied by `AtomicWrites` in the
 * same atomic write as the asset or version row it names. The write applies
 * only while the session is still at `upload.revision` and `hold` still holds:
 * the unfilled claim `token` for a new key, which the write fills with
 * `assetId`, or the lease `token` on the binding that names `assetId` for an
 * overwrite, whose pinned version the write clears. In the same write the
 * next generation is issued from the bucket's high mark, the hash record of
 * `objectRef` is stored at it, the `reclaim` prefixes (the bytes of the
 * session's earlier owners) are queued for cleanup, and the session moves to
 * committed with `result` at it. Otherwise nothing is written and the write throws `HoldLost`.
 */
export type CompatPublish = {
  upload: { id: UploadId; revision: number };
  hold: { kind: "claim" | "lease"; bucket: BucketName; key: ObjectKey; token: string; assetId: string };
  record: { objectRef: string; hashes: ExactHashes };
  result: Omit<ObjectInfo, "generation">;
  reclaim: string[];
};

export interface CompatStore {
  findBucket(name: BucketName): Promise<CompatBucket | null>;
  listBuckets(projectId: string): Promise<CompatBucket[]>;
  /** False when the name is taken, in any project. A new bucket's high mark starts at `generationSeed()`. */
  insertBucket(bucket: CompatBucket): Promise<boolean>;
  /**
   * Remove an empty bucket of `projectId`, revoke its credentials at
   * `revokedAt` and drop its upload sessions, all or nothing. A bucket that
   * still binds a key is left alone.
   */
  deleteBucket(projectId: string, name: BucketName, revokedAt: number): Promise<DeleteBucketResult>;
  /**
   * Remove every bucket of `projectId` with its bindings and upload sessions,
   * and delete the project's credentials, all or nothing. The assets stay.
   */
  deleteProject(projectId: string): Promise<void>;

  /** Bound rows only; a claim with no asset yet reads as absent. */
  findBinding(bucket: BucketName, key: BindingKey): Promise<Binding | null>;
  /** Claim `key` at `now`. A claim older than `staleBefore` is abandoned and may be taken over. */
  claim(bucket: BucketName, key: BindingKey, kind: BindingKind, now: number, staleBefore: number): Promise<ClaimResult>;
  /**
   * Fill the claim `token` with `assetId`. True when the row now names
   * `assetId`, including a repeat of the same bind; false when the claim was
   * lost to a takeover or the key names another asset.
   */
  bind(bucket: BucketName, key: BindingKey, token: ClaimToken, assetId: string): Promise<boolean>;
  /** Drop the claim `token` this writer failed to fill. No-op once bound or taken over. */
  releaseClaim(bucket: BucketName, key: BindingKey, token: ClaimToken): Promise<void>;
  deleteBinding(bucket: BucketName, key: BindingKey): Promise<void>;
  /**
   * Lease the bound `key` at `now` for one overwrite or delete. False while
   * another fresh lease (not older than `staleBefore`) holds it, or when the
   * key is not bound.
   */
  lease(bucket: BucketName, key: BindingKey, token: LeaseToken, now: number, staleBefore: number): Promise<boolean>;
  /** Refresh the lease `token` at `now`. False once it was released, taken over or swept. */
  renewLease(bucket: BucketName, key: BindingKey, token: LeaseToken, now: number): Promise<boolean>;
  /** Refresh the unfilled claim `token` at `now`. False once it was released, taken over or swept. */
  renewClaim(bucket: BucketName, key: BindingKey, token: ClaimToken, now: number): Promise<boolean>;
  /** Drop the lease `token`. No-op once it was taken over or the row is gone. */
  releaseLease(bucket: BucketName, key: BindingKey, token: LeaseToken): Promise<void>;
  /** Bound rows with key in [from, until), ascending by key, at most `limit`. */
  scanBindings(bucket: BucketName, from: string, until: string | null, limit: number): Promise<Binding[]>;

  /**
   * The record of each ref, keyed by `objectRef`. A ref with no record gets
   * one at the next generation above `bucket`'s high mark, which rises with
   * it, all in one atomic write, so every generation is unique in the bucket
   * and later than every one issued before. A stored record keeps its
   * generation, so concurrent callers converge on the first; a ref's `hashes`
   * fill a stored record that has none. The high mark survives object
   * deletes. Refs of a bucket that is gone are left out.
   */
  records(bucket: BucketName, refs: RecordRef[]): Promise<Map<string, VersionRecord>>;
  /** The stored record of `objectRef`, never storing one. */
  findRecord(objectRef: string): Promise<VersionRecord | null>;

  findCredential(id: CredentialId): Promise<CompatCredential | null>;
  findCredentialByEmail(clientEmail: string): Promise<CompatCredential | null>;
  /**
   * Insert only while the credential's bucket exists in its project, checked
   * in the same step as the insert. False when the bucket is gone.
   */
  insertCredential(credential: CompatCredential): Promise<boolean>;
  listCredentials(projectId: string): Promise<CompatCredential[]>;
  /** Revoke a credential of `projectId`. Keeps the first revocation time. False when no such credential. */
  revokeCredential(projectId: string, id: CredentialId, at: number): Promise<boolean>;

  createUpload(session: UploadSession): Promise<void>;
  findUpload(id: UploadId): Promise<UploadSession | null>;
  /** Set the phase and bump the revision, only from `revision`. False when another request moved the session first, or it is gone. */
  updateUpload(id: UploadId, revision: number, phase: UploadPhase): Promise<boolean>;
  listExpiredUploads(now: number, limit: number): Promise<UploadSession[]>;
  /** Remove the session, only from `revision` when given. False when it moved first or is gone. */
  deleteUpload(id: UploadId, revision?: number): Promise<boolean>;
  /** Drop claims that never named an asset and clear leases, each held since before `staleBefore`. */
  sweepStaleHolds(staleBefore: number): Promise<{ claims: number; leases: number }>;
}
