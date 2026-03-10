import type { AssetMetadata, StoredFile, UploadSession, UploadPart } from "./model";

export interface MetadataStore {
  save(asset: AssetMetadata, ttlSeconds: number): Promise<void>;
  find(id: string): Promise<AssetMetadata | null>;
  delete(id: string): Promise<void>;
}

export interface FileStorage {
  put(key: string, body: ArrayBuffer | ReadableStream, contentType: string): Promise<number>;
  get(key: string, range?: { offset: number; length: number }): Promise<StoredFile | null>;
  head(key: string): Promise<{ size: number } | null>;
  delete(key: string): Promise<void>;
}

export interface UploadSessionStore {
  save(session: UploadSession, ttlSeconds: number): Promise<void>;
  find(id: string): Promise<UploadSession | null>;
  delete(id: string): Promise<void>;
}

export interface PresignedUrlGenerator {
  generatePutUrl(key: string, contentType: string, expiresInSeconds: number): Promise<string>;
  createMultipartUpload(key: string, contentType: string): Promise<string>;
  generateUploadPartUrl(key: string, uploadId: string, partNumber: number, expiresInSeconds: number): Promise<string>;
  completeMultipartUpload(key: string, uploadId: string, parts: UploadPart[]): Promise<void>;
  abortMultipartUpload(key: string, uploadId: string): Promise<void>;
}
