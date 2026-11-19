import { readdirSync, readFileSync } from "node:fs";
import { deflateRawSync } from "node:zlib";
import { describe, expect, test } from "vitest";
import { MemoryFileStorage } from "../../adapters/memory/storage";
import { createArchiveCache, openArchive, toArchivePath } from "./index";
import { gzipMember } from "./transmux";
import { crc32 } from "./zip/directory";

const FIXTURES = new URL("../../scripts/fixtures/zip/data/", import.meta.url);

interface Golden {
  archive: string;
  entries: { path: string; size: number; crc32: string }[];
}

const goldens = readdirSync(FIXTURES)
  .filter((f) => f.endsWith(".golden.json"))
  .map((f) => JSON.parse(readFileSync(new URL(f, FIXTURES), "utf8")) as Golden);

async function bytesOf(stream: ReadableStream<Uint8Array>): Promise<Uint8Array> {
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

const gunzip = (member: Uint8Array) => bytesOf(new Blob([member as BlobPart]).stream().pipeThrough(new DecompressionStream("gzip")));

describe("gzipMember", () => {
  test("wraps raw deflate as one member that DecompressionStream reads to the end", async () => {
    const plain = new TextEncoder().encode("a".repeat(70_000) + "tail");
    const member = await bytesOf(gzipMember(new Blob([deflateRawSync(plain) as BlobPart]).stream(), crc32(plain), plain.byteLength));
    expect([...member.subarray(0, 4)]).toEqual([0x1f, 0x8b, 8, 0]);
    expect(await gunzip(member)).toEqual(plain);
  });

  test("a wrong trailer CRC fails the decode instead of passing silently", async () => {
    const plain = new TextEncoder().encode("checked by the client");
    const member = await bytesOf(gzipMember(new Blob([deflateRawSync(plain) as BlobPart]).stream(), crc32(plain) ^ 1, plain.byteLength));
    await expect(gunzip(member)).rejects.toThrow();
  });
});

describe("every deflate entry of every fixture round-trips through DecompressionStream", () => {
  for (const golden of goldens) {
    test(golden.archive, async () => {
      const bytes = new Uint8Array(readFileSync(new URL(golden.archive, FIXTURES)));
      const storage = new MemoryFileStorage();
      const key = `assets/x/${golden.archive}`;
      await storage.put(key, new Blob([bytes as BlobPart]).stream(), "application/zip", bytes.byteLength);
      const opened = await openArchive({ storage, archives: createArchiveCache() }, { key, size: bytes.byteLength, filename: golden.archive });
      if (!opened.ok) throw new Error(opened.reason);

      for (const entry of golden.entries) {
        const read = await opened.reader.open(toArchivePath(entry.path)!);
        if (!read.ok) throw new Error(`${entry.path}: ${read.reason}`);
        const body = await bytesOf(read.file.body);
        const plain = read.file.contentEncoding === "gzip" ? await gunzip(body) : body;
        if (read.file.contentEncoding === "gzip") expect(body.byteLength).toBe(read.file.size);
        expect({ path: entry.path, size: plain.byteLength, crc32: crc32(plain).toString(16).padStart(8, "0") }).toEqual(entry);
        expect(read.originalSize).toBe(entry.size);
      }
    });
  }
});
