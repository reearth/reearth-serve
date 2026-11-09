import type { StoredFile } from "../../core/asset/model";
import type { FileStorage, PutResult } from "../../core/asset/repository";
import { bytesToHex, ChecksumMismatchError } from "../../core/asset/integrity";

export class R2FileStorage implements FileStorage {
  constructor(private bucket: R2Bucket) {}

  /**
   * Integrity (ADR-017 §2). A declared SHA-256 is handed to R2, which hashes
   * what it receives and refuses the write on a mismatch — nothing is stored.
   * Without one, each chunk is written to a `DigestStream` on its way to R2
   * and the digest is returned once the put has committed.
   */
  async put(key: string, body: ReadableStream<Uint8Array>, contentType: string, size: number, options?: { contentEncoding?: string; sha256?: string }): Promise<PutResult> {
    const { readable, writable } = new FixedLengthStream(size);
    const httpMetadata = {
      contentType,
      ...(options?.contentEncoding && { contentEncoding: options.contentEncoding }),
    };

    if (options?.sha256) {
      const expected = options.sha256.toLowerCase();
      body.pipeTo(writable).catch(() => {}); // errors propagate through readable
      try {
        await this.bucket.put(key, readable, { httpMetadata, sha256: expected });
      } catch (e) {
        if (isChecksumError(e)) throw new ChecksumMismatchError(expected);
        throw e;
      }
      return { sha256: expected };
    }

    // Hash in line rather than with `tee()`: a tee lets the fast branch (the
    // digest) run ahead and the slow one (R2) buffer the difference, which for
    // a 100 MB body is most of the Worker's memory. A transform keeps R2's
    // backpressure on the whole pipe.
    // `crypto.DigestStream` is Workers-only; the project's `crypto` type is the
    // DOM one, which does not know it.
    const { DigestStream: Digest } = crypto as unknown as { DigestStream: typeof DigestStream };
    const digest = new Digest("SHA-256");
    const digestWriter = digest.getWriter();
    const hashing = new TransformStream<Uint8Array, Uint8Array>({
      async transform(chunk, controller) {
        await digestWriter.write(chunk);
        controller.enqueue(chunk);
      },
      async flush() {
        await digestWriter.close();
      },
    });
    body.pipeThrough(hashing).pipeTo(writable).catch(() => {}); // errors propagate through readable
    await this.bucket.put(key, readable, { httpMetadata });
    return { sha256: bytesToHex(await digest.digest) };
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
      etag: obj.httpEtag,
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

  async head(key: string): Promise<{ size: number; contentEncoding?: string; etag?: string; sha256?: string } | null> {
    const obj = await this.bucket.head(key);
    if (!obj) return null;
    // R2 keeps a SHA-256 only when the upload supplied one (binding `sha256`
    // option, or an S3 `x-amz-checksum-sha256` header).
    const sha256 = obj.checksums?.sha256;
    return {
      size: obj.size,
      contentEncoding: obj.httpMetadata?.contentEncoding,
      etag: obj.etag,
      ...(sha256 && { sha256: bytesToHex(sha256) }),
    };
  }

  async delete(key: string): Promise<void> {
    await this.bucket.delete(key);
  }

  async deleteMany(keys: string[]): Promise<void> {
    if (keys.length === 0) return;
    // R2Bucket.delete accepts up to 1000 keys per call; chunk to be safe.
    const CHUNK = 1000;
    for (let i = 0; i < keys.length; i += CHUNK) {
      await this.bucket.delete(keys.slice(i, i + CHUNK));
    }
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

/**
 * R2 reports a digest mismatch as a thrown error whose message names the
 * checksum ("The SHA-256 checksum you specified did not match what we
 * received", code 10037). The wording is not a stable API, so the match is
 * loose; anything else is rethrown untouched.
 */
function isChecksumError(e: unknown): boolean {
  const msg = e instanceof Error ? e.message : String(e);
  return /sha-?256|checksum|digest|10037/i.test(msg);
}
