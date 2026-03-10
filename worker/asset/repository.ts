import type { AssetMetadata, StoredFile } from "./model";

export interface MetadataStore {
  save(asset: AssetMetadata, ttlSeconds: number): Promise<void>;
  find(id: string): Promise<AssetMetadata | null>;
  delete(id: string): Promise<void>;
}

export interface FileStorage {
  put(key: string, body: ArrayBuffer | ReadableStream, contentType: string): Promise<number>;
  get(key: string, range?: { offset: number; length: number }): Promise<StoredFile | null>;
  delete(key: string): Promise<void>;
}
