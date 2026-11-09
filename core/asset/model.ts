// Re-export shared API types
export type {
  AssetAccess,
  AssetType,
  AssetStatus,
  ArchiveFormat,
  Integrity,
  AssetUploadResult,
  PresignedUploadResult,
  MultipartUploadResult,
  UploadPart,
} from "../../shared/api";

// Re-export archive format detection (shared enum values)
import type {
  ArchiveFormat,
  AssetMetadata as ApiAssetMetadata,
  AssetVersion as ApiAssetVersion,
} from "../../shared/api";

/**
 * Ledger fields of an asset or version row that are not part of the API.
 *
 * `blobKey` is where the row's original bytes live when they are in the blob
 * layer (ADR-017 §3); absent means the classic per-asset key. Read it only
 * through `originalKey` (core/blob/model.ts). Responses drop it
 * (`toAssetResponse`, core/asset/response.ts): a storage key is not something
 * a client should come to depend on.
 */
interface StorageFields {
  blobKey?: string;
}

export type AssetVersion = ApiAssetVersion & StorageFields;
export type AssetMetadata = Omit<ApiAssetMetadata, "currentVersion"> & StorageFields & {
  currentVersion?: AssetVersion;
};

const archiveExtensions: Record<string, ArchiveFormat> = {
  ".zip": "zip",
  ".tar": "tar",
  ".tar.gz": "tar.gz",
  ".tgz": "tar.gz",
  ".tar.bz2": "tar.bz2",
};

export function detectArchiveFormat(filename: string): ArchiveFormat | null {
  const lower = filename.toLowerCase();
  for (const [ext, format] of Object.entries(archiveExtensions)) {
    if (lower.endsWith(ext)) return format;
  }
  return null;
}

// Worker-only types (not in shared — use runtime-specific APIs)

export interface StoredFile {
  body: ReadableStream;
  size: number;
  contentType: string;
  contentEncoding?: string;
  /** Entity tag of the stored object in HTTP form (quoted), when the store provides one. */
  etag?: string;
  range?: { offset: number; length: number; totalSize: number };
}

export interface UploadSession {
  id: string;
  filename: string;
  contentType: string;
  size: number;
  createdAt: number;
  expiresAt: number;
  s3UploadId?: string;
  partCount?: number;
  contentEncoding?: string;
  sessionId?: string;
  projectId?: string;
  skipExtraction?: boolean;
  /** Declared SHA-256 of the stored bytes, lowercase hex (ADR-017 §1). */
  sha256?: string;
  /**
   * The blob key this session claimed and uploads to (ADR-017 §3). Absent:
   * the session uploads to the classic `assets/{id}/{filename}`.
   */
  blobKey?: string;
  /** The claimed blob's scope, carried to completion with `blobKey`. */
  blobScope?: string;
}
