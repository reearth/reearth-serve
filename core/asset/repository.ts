import type { AssetMetadata, AssetVersion, StoredFile, UploadSession, UploadPart } from "./model";
import type { Job } from "../job/model";
import type { SiteHost } from "../site/repository";

export interface ListResult<T> {
  items: T[];
  cursor?: string;
}

/**
 * An asset's password material (ADR-013 B7).
 *
 * Deliberately *not* part of `AssetMetadata`: that type is what every asset
 * response serialises, and a hash that is never on the object is a hash that
 * cannot leak through a route somebody adds later. It is read on its own, and
 * only for an asset whose `access` is already `password`, so a public asset
 * pays nothing for the separation.
 *
 * `version` is ADR-013 B7's `passwordVersion`: it starts at 0, increments on
 * every password change, and travels inside the auth cookie so a rotation logs
 * every visitor out without server-side session state.
 */
export interface AssetProtection {
  /** Encoded PBKDF2 hash — see `core/access/password.ts`. */
  hash: string;
  /** Base64 salt. */
  salt: string;
  version: number;
}

export type ListScope =
  | { kind: "session"; sessionId: string }
  | { kind: "project"; projectId: string }
  | { kind: "workspace"; workspaceId: string }
  | { kind: "visible"; workspaceIds: readonly string[]; ownerId: string };

export interface ListOptions {
  scope: ListScope;
  limit?: number;
  cursor?: string;
}

export interface MetadataStore {
  save(asset: AssetMetadata, ttlSeconds: number): Promise<void>;
  find(id: string): Promise<AssetMetadata | null>;
  /** Password material, or null when the asset is not password-protected. */
  findProtection(id: string): Promise<AssetProtection | null>;
  /**
   * Set the access mode and, for `password`, its material.
   *
   * The store owns the version counter: setting a password increments it, and
   * clearing to `public` drops the hash and the salt but leaves the counter
   * where it is. Both halves of that matter — if the caller supplied the
   * number, unprotecting and re-protecting would restart it at 1 and an
   * outstanding cookie minted at version 1 would come back to life.
   */
  setProtection(
    id: string,
    value: { access: "public" } | { access: "password"; hash: string; salt: string },
  ): Promise<void>;
  /** `spa` is ADR-013 C1's SPA fallback flag; see `core/asset/usecase/set-spa.ts`. */
  update(id: string, patch: { activeVersionId?: string | null; expiresAt?: number; description?: string; userMeta?: Record<string, unknown>; spa?: boolean }): Promise<void>;
  delete(id: string): Promise<void>;
  list(options: ListOptions): Promise<ListResult<AssetMetadata>>;
}

export interface VersionStore {
  /**
   * Insert a new version. The `version` field on the input is ignored —
   * the store assigns the next per-asset version number atomically inside
   * the INSERT, returning the saved row. Concurrent uploaders always get
   * distinct version numbers; no SELECT MAX + INSERT race.
   */
  save(version: AssetVersion): Promise<AssetVersion>;
  find(id: string): Promise<AssetVersion | null>;
  findByAssetId(assetId: string, options?: { limit?: number; cursor?: string }): Promise<ListResult<AssetVersion>>;
  findLatest(assetId: string): Promise<AssetVersion | null>;
  /**
   * One version by its per-asset number (ADR-005's `version` column), which is
   * what a `v{n}--` preview host names (ADR-013 B4). Paging `findByAssetId`
   * would read every newer version to find it.
   */
  findByAssetAndNumber(assetId: string, version: number): Promise<AssetVersion | null>;
  /**
   * `hosting` is ADR-013 C3's parsed `_headers` / `_redirects`. It is *system*
   * metadata, written only by the extraction-completion hook and never by the
   * PATCH route, which is why it sits beside `userMeta` here rather than in it.
   */
  update(id: string, patch: Partial<Pick<AssetVersion, 'status' | 'userMeta' | 'hosting'>>): Promise<void>;
  delete(id: string): Promise<void>;
  deleteByAssetId(assetId: string): Promise<{ totalSize: number; count: number }>;
  count(assetId: string): Promise<number>;
}

/**
 * Writes that must land together or not at all (ADR-012 §3).
 *
 * The individual stores above each issue one statement; an upload or a job
 * status change touches several rows at once, and a partial write leaves the
 * asset, its job and the storage counters disagreeing. There is no interactive
 * transaction — D1 offers only an atomic `batch()` — so each composite write is
 * one method here, and the adapter turns it into one batch.
 *
 * `usageScopes` are `project:<id>` / `workspace:<id>` counters incremented by
 * the size of the asset or version being written.
 */
export interface AtomicWrites {
  /** A new asset, its optional extraction job, and storage-usage increments. */
  createAsset(input: { asset: AssetMetadata; job?: Job; usageScopes?: string[] }): Promise<void>;
  /**
   * A new version, its optional extraction job, and storage-usage increments.
   * Returns the version with the number the store assigned (see `VersionStore.save`).
   */
  createVersion(input: { version: AssetVersion; job?: Job; usageScopes?: string[] }): Promise<AssetVersion>;
  /**
   * A job row plus the row that mirrors its status: the version for a
   * version's job, the asset otherwise. A version's job may still pass the
   * asset to extend its expiry.
   */
  saveJob(input: { job: Job; asset?: AssetMetadata; version?: AssetVersion }): Promise<void>;
  /**
   * Removes the asset row and all its version rows, decrements each usage
   * scope by the asset's size plus its versions' sizes, and records
   * `cleanupPrefix` in `cleanup_pending`, so the R2 objects are always
   * reclaimed even if the inline delete that follows fails. Decrements apply
   * only while the asset row still exists, so a repeated delete is a no-op.
   *
   * The asset's active site hosts are released (ADR-013 B3) in the same write,
   * stamped `releasedAt` (default now). Releasing them in a write of their own
   * first meant a failed row delete left the asset alive with its names
   * answering 410 and locked in cooldown for 30 days (compliance#258 REL-11).
   * Returns the released rows so the caller can drop their cache entries and
   * give up certificates once the write has committed.
   */
  deleteAsset(input: {
    asset: AssetMetadata;
    usageScopes?: string[];
    cleanupPrefix: string;
    releasedAt?: number;
  }): Promise<{ releasedSiteHosts: SiteHost[] }>;
}

/**
 * Per-scope storage counters (ADR-004): `project:<id>` / `workspace:<id>`.
 *
 * Incremented in the same atomic write as the asset row (see `AtomicWrites`),
 * decremented on delete.
 */
export interface StorageUsage {
  totalSize: number;
  assetCount: number;
  updatedAt: number;
}

export interface StorageUsageStore {
  get(scope: string): Promise<StorageUsage | null>;
  increment(scope: string, sizeBytes: number): Promise<void>;
  decrement(scope: string, sizeBytes: number): Promise<void>;
  recalculate(scope: string, totalSize: number, assetCount: number): Promise<void>;
}

/** What a `FileStorage.put` reports about the bytes it stored (ADR-017 §2). */
export interface PutResult {
  /** SHA-256 of the stored bytes, lowercase hex, as computed or confirmed by the store. */
  sha256: string;
}

export interface FileStorage {
  /**
   * Store `body` under `key`.
   *
   * Integrity (ADR-017 §2) lives here because hashing a stream is runtime
   * specific (`crypto.DigestStream` on Workers, `node:crypto` on Node):
   *
   * - `options.sha256` declared → the store verifies the bytes against it and,
   *   on a mismatch, throws `ChecksumMismatchError` having written **nothing**.
   * - not declared → the store hashes the stream as it is written.
   *
   * Either way the result carries the SHA-256 of what was stored.
   */
  put(key: string, body: ReadableStream<Uint8Array>, contentType: string, size: number, options?: { contentEncoding?: string; sha256?: string }): Promise<PutResult>;
  get(key: string, range?: { offset: number; length: number }): Promise<StoredFile | null>;
  /**
   * `sha256` (lowercase hex) is present only when the store itself holds a
   * SHA-256 for the object — R2 does when the upload supplied one, which is
   * how a presigned single PUT's checksum is confirmed at completion.
   */
  head(key: string): Promise<{ size: number; contentEncoding?: string; etag?: string; sha256?: string } | null>;
  delete(key: string): Promise<void>;
  /**
   * Optional batch delete. R2 supports up to 1000 keys per call; cleanup paths
   * use this to stay under the Worker subrequest cap. Implementations without
   * batch support can omit this and callers will fall back to per-key delete.
   */
  deleteMany?(keys: string[]): Promise<void>;
  list(prefix: string, options?: { limit?: number; cursor?: string }): Promise<{ keys: string[]; cursor?: string }>;
}

export interface UploadSessionStore {
  save(session: UploadSession, ttlSeconds: number): Promise<void>;
  find(id: string): Promise<UploadSession | null>;
  delete(id: string): Promise<void>;
}

/** A presigned single PUT: the URL, plus any headers the signature binds that the client must send verbatim. */
export interface PresignedPut {
  url: string;
  /** Extra headers beyond `Content-Type` / `Content-Encoding`, e.g. `x-amz-checksum-sha256`. */
  headers: Record<string, string>;
}

export interface PresignedUrlGenerator {
  /**
   * `options.sha256` (lowercase hex) asks the store to verify the upload
   * against it on write (ADR-017 §2); the header that carries it is signed into
   * the URL and returned in `headers`.
   */
  generatePutUrl(key: string, contentType: string, expiresInSeconds: number, options?: { contentEncoding?: string; sha256?: string }): Promise<PresignedPut>;
  createMultipartUpload(key: string, contentType: string, options?: { contentEncoding?: string }): Promise<string>;
  generateUploadPartUrl(key: string, uploadId: string, partNumber: number, expiresInSeconds: number): Promise<string>;
  completeMultipartUpload(key: string, uploadId: string, parts: UploadPart[]): Promise<void>;
  abortMultipartUpload(key: string, uploadId: string): Promise<void>;
}
