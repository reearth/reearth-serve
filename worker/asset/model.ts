export type AssetType = "file" | "archive";
export type AssetStatus = "ready" | "extracting" | "failed";
export type ArchiveFormat = "zip" | "tar" | "tar.gz" | "tar.bz2";

export interface AssetMetadata {
  id: string;
  filename: string;
  contentType: string;
  size: number;
  createdAt: number;
  expiresAt: number;
  contentEncoding?: string;
  originalSize?: number;
  // Phase 1: archive support
  type?: AssetType;
  status?: AssetStatus;
  archiveFormat?: ArchiveFormat;
  fileCount?: number;
  extractedSize?: number;
  jobId?: string;
}

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

export interface StoredFile {
  body: ReadableStream;
  size: number;
  contentType: string;
  contentEncoding?: string;
  range?: { offset: number; length: number; totalSize: number };
}

export interface AssetUploadResult {
  asset: AssetMetadata;
  url: string;
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

export interface PresignedUploadResult {
  uploadId: string;
  url: string;
  method: "PUT";
  headers: Record<string, string>;
  contentEncoding?: string;
  expiresAt: number;
}

export interface MultipartUploadResult {
  uploadId: string;
  parts: { partNumber: number; url: string }[];
  contentEncoding?: string;
  expiresAt: number;
}

export interface UploadPart {
  partNumber: number;
  etag: string;
}
