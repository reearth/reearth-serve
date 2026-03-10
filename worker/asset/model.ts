export interface AssetMetadata {
  id: string;
  filename: string;
  contentType: string;
  size: number;
  createdAt: number;
  expiresAt: number;
  contentEncoding?: string;
  originalSize?: number;
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
