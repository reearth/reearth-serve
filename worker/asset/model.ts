// Re-export shared API types
export type {
  AssetType,
  AssetStatus,
  ArchiveFormat,
  AssetMetadata,
  AssetUploadResult,
  PresignedUploadResult,
  MultipartUploadResult,
  UploadPart,
} from "../../shared/api";

// Re-export archive format detection (shared enum values)
import type { ArchiveFormat } from "../../shared/api";

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
}
