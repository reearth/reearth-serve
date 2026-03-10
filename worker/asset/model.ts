export interface AssetMetadata {
  id: string;
  filename: string;
  contentType: string;
  size: number;
  createdAt: number;
  expiresAt: number;
}

export interface StoredFile {
  body: ReadableStream;
  size: number;
  contentType: string;
  range?: { offset: number; length: number; totalSize: number };
}

export interface AssetUploadResult {
  asset: AssetMetadata;
  url: string;
}
