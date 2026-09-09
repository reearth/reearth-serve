import type { AssetMetadata, AssetVersion, StoredFile, UploadSession, UploadPart } from "./model";
import type { Job } from "../job/model";

export interface ListResult<T> {
  items: T[];
  cursor?: string;
}

export interface MetadataStore {
  save(asset: AssetMetadata, ttlSeconds: number): Promise<void>;
  find(id: string): Promise<AssetMetadata | null>;
  update(id: string, patch: { activeVersionId?: string | null; expiresAt?: number; description?: string; userMeta?: Record<string, unknown> }): Promise<void>;
  delete(id: string): Promise<void>;
  // scope exactly one of: sessionId, projectId, workspaceId (caller-verified
  // membership), or accessibleByUser (membership-driven across all workspaces).
  // Unscoped calls return an empty result — use a scope explicitly.
  list(options?: {
    limit?: number;
    cursor?: string;
    sessionId?: string;
    projectId?: string;
    workspaceId?: string;
    accessibleByUser?: string;
  }): Promise<ListResult<AssetMetadata>>;
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
  update(id: string, patch: Partial<Pick<AssetVersion, 'status' | 'userMeta'>>): Promise<void>;
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
  /** A job row plus the asset row that mirrors its status. */
  saveJob(input: { job: Job; asset?: AssetMetadata }): Promise<void>;
}

export interface FileStorage {
  put(key: string, body: ReadableStream<Uint8Array>, contentType: string, size: number, options?: { contentEncoding?: string }): Promise<void>;
  get(key: string, range?: { offset: number; length: number }): Promise<StoredFile | null>;
  head(key: string): Promise<{ size: number; contentEncoding?: string; etag?: string } | null>;
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

export interface PresignedUrlGenerator {
  generatePutUrl(key: string, contentType: string, expiresInSeconds: number, options?: { contentEncoding?: string }): Promise<string>;
  createMultipartUpload(key: string, contentType: string, options?: { contentEncoding?: string }): Promise<string>;
  generateUploadPartUrl(key: string, uploadId: string, partNumber: number, expiresInSeconds: number): Promise<string>;
  completeMultipartUpload(key: string, uploadId: string, parts: UploadPart[]): Promise<void>;
  abortMultipartUpload(key: string, uploadId: string): Promise<void>;
}
