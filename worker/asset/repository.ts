import type { AssetMetadata, StoredFile, UploadSession, UploadPart } from "./model";

export interface ListResult<T> {
  items: T[];
  cursor?: string;
}

export interface MetadataStore {
  save(asset: AssetMetadata, ttlSeconds: number): Promise<void>;
  find(id: string): Promise<AssetMetadata | null>;
  delete(id: string): Promise<void>;
  list(options?: { limit?: number; cursor?: string }): Promise<ListResult<AssetMetadata>>;
}

export interface FileStorage {
  put(key: string, body: ReadableStream<Uint8Array>, contentType: string, size: number, options?: { contentEncoding?: string }): Promise<void>;
  get(key: string, range?: { offset: number; length: number }): Promise<StoredFile | null>;
  head(key: string): Promise<{ size: number; contentEncoding?: string; etag?: string } | null>;
  delete(key: string): Promise<void>;
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
