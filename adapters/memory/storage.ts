import { createHash } from "node:crypto";
import type { StoredFile } from "../../core/asset/model";
import type { FileStorage } from "../../core/asset/repository";

type Entry = {
  data: Uint8Array;
  contentType: string;
  contentEncoding?: string;
  etag: string;
};

/**
 * Map-backed `FileStorage` (ADR-012 §1).
 *
 * The default object store for the Node runtime until an S3 adapter exists,
 * and the fixture that lets the e2e suite run with no cloud credentials at
 * all. Everything lives in the process heap, so it dies with the process and
 * is only appropriate for local runs and tests.
 *
 * It enforces the declared size the way R2's `FixedLengthStream` does: a body
 * that does not deliver exactly `size` bytes is a client error, and the upload
 * route turns the thrown message into a 400.
 */
export class MemoryFileStorage implements FileStorage {
  private readonly objects = new Map<string, Entry>();

  async put(
    key: string,
    body: ReadableStream<Uint8Array>,
    contentType: string,
    size: number,
    options?: { contentEncoding?: string },
  ): Promise<void> {
    const data = await collect(body, size);
    this.objects.set(key, {
      data,
      contentType,
      contentEncoding: options?.contentEncoding,
      etag: `"${md5(data)}"`,
    });
  }

  async get(key: string, range?: { offset: number; length: number }): Promise<StoredFile | null> {
    const entry = this.objects.get(key);
    if (!entry) return null;

    if (!range) {
      return {
        body: toStream(entry.data),
        size: entry.data.byteLength,
        contentType: entry.contentType,
        contentEncoding: entry.contentEncoding,
      };
    }

    const offset = Math.min(range.offset, entry.data.byteLength);
    const length = Math.min(range.length, entry.data.byteLength - offset);
    return {
      body: toStream(entry.data.subarray(offset, offset + length)),
      // R2 reports the object's full size on a ranged get; `range.totalSize`
      // carries the same number and `core/file/handler.ts` reads both.
      size: entry.data.byteLength,
      contentType: entry.contentType,
      contentEncoding: entry.contentEncoding,
      range: { offset, length, totalSize: entry.data.byteLength },
    };
  }

  async head(key: string): Promise<{ size: number; contentEncoding?: string; etag?: string } | null> {
    const entry = this.objects.get(key);
    if (!entry) return null;
    return { size: entry.data.byteLength, contentEncoding: entry.contentEncoding, etag: entry.etag };
  }

  async delete(key: string): Promise<void> {
    this.objects.delete(key);
  }

  async deleteMany(keys: string[]): Promise<void> {
    for (const key of keys) this.objects.delete(key);
  }

  async list(prefix: string, options?: { limit?: number; cursor?: string }): Promise<{ keys: string[]; cursor?: string }> {
    const limit = options?.limit ?? 1000;
    const after = options?.cursor;
    const matching = [...this.objects.keys()]
      .filter((key) => key.startsWith(prefix))
      .sort()
      .filter((key) => (after === undefined ? true : key > after));
    const page = matching.slice(0, limit);
    return {
      keys: page,
      cursor: matching.length > limit ? page[page.length - 1] : undefined,
    };
  }

  /** Number of stored objects. For assertions only. */
  get size(): number {
    return this.objects.size;
  }
}

async function collect(body: ReadableStream<Uint8Array>, size: number): Promise<Uint8Array> {
  const out = new Uint8Array(size);
  let written = 0;
  const reader = body.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (written + value.byteLength > size) {
      await reader.cancel().catch(() => {});
      throw new Error(`body exceeds declared Content-Length ${size}`);
    }
    out.set(value, written);
    written += value.byteLength;
  }
  if (written !== size) {
    throw new Error(`body shorter than declared Content-Length ${size} (got ${written})`);
  }
  return out;
}

function toStream(data: Uint8Array): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(data);
      controller.close();
    },
  });
}

/**
 * R2 reports the object's MD5 as its ETag for a single-part upload, and the CLI
 * compares `md5:<etag>` against a locally computed digest to decide whether a
 * file is unchanged. Anything else here would make every sync look dirty.
 */
function md5(data: Uint8Array): string {
  return createHash("md5").update(data).digest("hex");
}
