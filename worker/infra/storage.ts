import type { StoredFile } from "../asset/model";
import type { FileStorage } from "../asset/repository";

export class R2FileStorage implements FileStorage {
  constructor(private bucket: R2Bucket) {}

  async put(key: string, body: ArrayBuffer | ReadableStream, contentType: string): Promise<number> {
    const obj = await this.bucket.put(key, body, {
      httpMetadata: { contentType },
    });
    return obj?.size ?? 0;
  }

  async get(key: string, range?: { offset: number; length: number }): Promise<StoredFile | null> {
    const options: R2GetOptions = range
      ? { range: { offset: range.offset, length: range.length } }
      : {};

    const obj = await this.bucket.get(key, options);
    if (!obj) return null;

    const result: StoredFile = {
      body: obj.body,
      size: obj.size,
      contentType: obj.httpMetadata?.contentType ?? "application/octet-stream",
    };

    if (range) {
      result.range = {
        offset: range.offset,
        length: range.length,
        totalSize: obj.size,
      };
    }

    return result;
  }

  async head(key: string): Promise<{ size: number } | null> {
    const obj = await this.bucket.head(key);
    if (!obj) return null;
    return { size: obj.size };
  }

  async delete(key: string): Promise<void> {
    await this.bucket.delete(key);
  }
}
