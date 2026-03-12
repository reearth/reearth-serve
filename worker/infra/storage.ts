import type { StoredFile } from "../asset/model";
import type { FileStorage } from "../asset/repository";

export class R2FileStorage implements FileStorage {
  constructor(private bucket: R2Bucket) {}

  async put(key: string, body: ReadableStream<Uint8Array>, contentType: string, size: number, options?: { contentEncoding?: string }): Promise<void> {
    const { readable, writable } = new FixedLengthStream(size);
    body.pipeTo(writable).catch(() => {}); // errors propagate through readable
    await this.bucket.put(key, readable, {
      httpMetadata: {
        contentType,
        ...(options?.contentEncoding && { contentEncoding: options.contentEncoding }),
      },
    });
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
      contentEncoding: obj.httpMetadata?.contentEncoding,
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

  async head(key: string): Promise<{ size: number; contentEncoding?: string; etag?: string } | null> {
    const obj = await this.bucket.head(key);
    if (!obj) return null;
    return { size: obj.size, contentEncoding: obj.httpMetadata?.contentEncoding, etag: obj.etag };
  }

  async delete(key: string): Promise<void> {
    await this.bucket.delete(key);
  }

  async list(prefix: string, options?: { limit?: number; cursor?: string }): Promise<{ keys: string[]; cursor?: string }> {
    const result = await this.bucket.list({
      prefix,
      limit: options?.limit ?? 1000,
      cursor: options?.cursor,
    });
    return {
      keys: result.objects.map((obj) => obj.key),
      cursor: result.truncated ? result.cursor : undefined,
    };
  }
}
