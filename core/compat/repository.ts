/**
 * The compat_* tables behind one port (ADR-019).
 *
 * `claim`, `bind`, `releaseClaim`, `lease`, `nextGeneration` and
 * `updateUpload` are each one step with compare-and-set semantics, so two
 * writers racing on one key or one upload session cannot both win.
 */
import type {
  Binding, BindingKind, BucketName, CompatBucket, CompatCredential, CredentialId,
  ExactHashes, FolderKey, ObjectKey, UploadId, UploadPhase, UploadSession,
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

export type VersionRecord = { generation: number; hashes: ExactHashes };

export type ClaimResult =
  /** This call inserted the claim or took over a stale one. `token` guards bind and release. */
  | { kind: "claimed"; token: ClaimToken }
  /** The key already names an asset. */
  | { kind: "bound"; binding: Binding }
  /** Another writer's fresh claim holds the key. Retryable. */
  | { kind: "busy" };

export type DeleteBucketResult = "deleted" | "absent" | "not_empty";

export type UploadTransition = { id: UploadId; revision: number; phase: UploadPhase };

export interface CompatStore {
  findBucket(name: BucketName): Promise<CompatBucket | null>;
  listBuckets(projectId: string): Promise<CompatBucket[]>;
  /** False when the name is taken, in any project. */
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
   * lost to a takeover or the key names another asset. With `upload`, the
   * bind and that transition happen together or not at all.
   */
  bind(bucket: BucketName, key: BindingKey, token: ClaimToken, assetId: string, upload?: UploadTransition): Promise<boolean>;
  /** Drop the claim `token` this writer failed to fill. No-op once bound or taken over. */
  releaseClaim(bucket: BucketName, key: BindingKey, token: ClaimToken): Promise<void>;
  deleteBinding(bucket: BucketName, key: BindingKey): Promise<void>;
  /**
   * Lease the bound `key` at `now` for one overwrite or delete. False while
   * another fresh lease (not older than `staleBefore`) holds it, or when the
   * key is not bound.
   */
  lease(bucket: BucketName, key: BindingKey, token: LeaseToken, now: number, staleBefore: number): Promise<boolean>;
  /** Drop the lease `token`. No-op once it was taken over or the row is gone. */
  releaseLease(bucket: BucketName, key: BindingKey, token: LeaseToken): Promise<void>;
  /** Bound rows with key in [from, until), ascending by key, at most `limit`. */
  scanBindings(bucket: BucketName, from: string, until: string | null, limit: number): Promise<Binding[]>;

  /**
   * A generation for a write to `bucket`: `atLeast`, or one more than the
   * highest generation the bucket issued before when that is larger. The
   * bucket keeps its high mark across object deletes, so no key sees a
   * generation twice.
   */
  nextGeneration(bucket: BucketName, atLeast: number): Promise<number>;
  findRecord(objectRef: string): Promise<VersionRecord | null>;
  putRecord(objectRef: string, assetId: string, record: VersionRecord): Promise<void>;

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
