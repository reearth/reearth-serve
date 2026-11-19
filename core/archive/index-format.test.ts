import { describe, expect, test } from "vitest";
import { MemoryFileStorage } from "../../adapters/memory/storage";
import { writeZip } from "../../adapters/memory/zip";
import { encodeIndex, readFence, readHeader, readPage, type IndexInputs } from "./index-format";
import { directoryTable } from "./reader";
import { entryAt } from "./table";
import { crc32, locateDirectory } from "./zip/directory";

async function inputs(names: string[], filename = "a.zip"): Promise<IndexInputs> {
  const bytes = writeZip(names.map((name, i) => ({ name, data: new TextEncoder().encode(`${i}`) })));
  const storage = new MemoryFileStorage();
  await storage.put(filename, new Blob([bytes as BlobPart]).stream(), "application/zip", bytes.byteLength);
  const located = await locateDirectory(storage, filename, bytes.byteLength);
  if (!located.ok) throw new Error(located.reason);
  const read = await directoryTable(storage, { key: filename, size: bytes.byteLength, filename }, located.directory);
  if (!read.ok) throw new Error(read.reason);
  return { table: read.table, rules: read.rules, directory: located.directory, directoryRecordCount: read.directoryRecordCount, sourceSize: bytes.byteLength };
}

function encode(input: IndexInputs): Uint8Array {
  const bytes = encodeIndex(input);
  if (!bytes) throw new Error("index did not encode");
  return bytes;
}

function decode(bytes: Uint8Array, expect: { size: number; etag: string | undefined }) {
  const head = readHeader(bytes, { sourceSize: expect.size, sourceEtag: expect.etag, objectSize: bytes.byteLength });
  if (!head.ok) return head;
  const fence = readFence(bytes, head.header, bytes.byteLength);
  if (!fence.ok) return fence;
  const entries = fence.fence.pages.flatMap((page) => {
    const table = readPage(bytes.subarray(page.offset, page.offset + page.length), page, head.header.directory.offset);
    if (!table) throw new Error("page failed its CRC");
    return Array.from({ length: table.count }, (_, i) => entryAt(table, i));
  });
  return { ok: true as const, header: head.header, rootPrefix: fence.fence.rootPrefix, entries };
}

const numbered = (n: number) => Array.from({ length: n }, (_, i) => `d${i % 9}/sub${i % 4}/f${String(i).padStart(5, "0")}.txt`);

function rewriteHeaderCrc(bytes: Uint8Array): void {
  new DataView(bytes.buffer, bytes.byteOffset).setUint32(124, crc32(bytes.subarray(0, 124)), true);
}

describe("container index encoding", () => {
  test.each([
    ["empty", [] as string[], "a.zip"],
    ["one entry", ["only.txt"], "a.zip"],
    ["255 entries", numbered(255), "a.zip"],
    ["256 entries", numbered(256), "a.zip"],
    ["257 entries", numbered(257), "a.zip"],
    ["1,200 entries", numbered(1200), "a.zip"],
    ["a root prefix", numbered(300).map((n) => `site/${n}`), "site.zip"],
    ["non-ASCII names", ["日本語/ファイル.txt", "Ａ.txt", "\u{1F600}/x.txt", "café.geojson", "z.txt"], "a.zip"],
  ])("round trips %s", async (_, names, filename) => {
    const input = await inputs(names, filename);
    const bytes = encode(input);
    const decoded = decode(bytes, { size: input.sourceSize, etag: input.directory.etag });
    if (!decoded.ok) throw new Error(decoded.reason);
    expect(decoded.entries).toEqual(Array.from({ length: input.table.count }, (_, i) => entryAt(input.table, i)));
    expect(decoded.rootPrefix).toBe(input.rules.rootPrefix);
    expect(decoded.header).toMatchObject({
      legacy: input.rules.legacy,
      count: input.table.count,
      directoryRecordCount: input.directoryRecordCount,
      sourceSize: input.sourceSize,
      sourceEtag: input.directory.etag,
      directory: { offset: input.directory.offset, size: input.directory.size },
      baseOffset: input.directory.baseOffset,
    });
    expect(encode(await inputs(names, filename))).toEqual(bytes);
  });

  test("an etag that does not fit the header refuses to encode", async () => {
    const input = await inputs(["a.txt"]);
    expect(encodeIndex({ ...input, directory: { ...input.directory, etag: `"${"f".repeat(60)}"` } })).toBeNull();
  });

  describe("rejects", () => {
    test.each([
      ["magic", (b: Uint8Array) => { b[0] ^= 0xff; }],
      ["version", (b: Uint8Array) => { b[8] = 2; rewriteHeaderCrc(b); }],
      ["header-crc", (b: Uint8Array) => { b[33] ^= 0x01; }],
      ["fence-crc", (b: Uint8Array) => { b[140] ^= 0x01; }],
      ["truncated", (b: Uint8Array) => b.subarray(0, 100)],
    ])("%s", async (reason, damage) => {
      const input = await inputs(numbered(600));
      const bytes = encode(input).slice();
      const damaged = damage(bytes) ?? bytes;
      expect(decode(damaged, { size: input.sourceSize, etag: input.directory.etag })).toEqual({ ok: false, reason });
    });

    test("a source of another size", async () => {
      const input = await inputs(numbered(10));
      expect(decode(encode(input), { size: input.sourceSize + 1, etag: input.directory.etag })).toEqual({ ok: false, reason: "size" });
    });

    test("a source with another etag", async () => {
      const input = await inputs(numbered(10));
      expect(decode(encode(input), { size: input.sourceSize, etag: '"other"' })).toEqual({ ok: false, reason: "etag" });
    });

    test("an etag missing on either side", async () => {
      const input = await inputs(numbered(10));
      expect(decode(encode(input), { size: input.sourceSize, etag: undefined })).toEqual({ ok: false, reason: "etag" });
      const unrecorded = encode({ ...input, directory: { ...input.directory, etag: undefined } });
      expect(decode(unrecorded, { size: input.sourceSize, etag: input.directory.etag })).toEqual({ ok: false, reason: "etag" });
    });

    test("a page whose bytes fail its CRC", async () => {
      const input = await inputs(numbered(600));
      const bytes = encode(input).slice();
      const head = readHeader(bytes, { sourceSize: input.sourceSize, sourceEtag: input.directory.etag, objectSize: bytes.byteLength });
      if (!head.ok) throw new Error(head.reason);
      const fence = readFence(bytes, head.header, bytes.byteLength);
      if (!fence.ok) throw new Error(fence.reason);
      const page = fence.fence.pages[1];
      bytes[page.offset + 7] ^= 0x01;
      expect(readPage(bytes.subarray(page.offset, page.offset + page.length), page, head.header.directory.offset)).toBeNull();
    });
  });
});
