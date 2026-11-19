import { deflateRawSync } from "node:zlib";
import { describe, expect, test } from "vitest";
import { MemoryFileStorage } from "../../adapters/memory/storage";
import type { FileStorage } from "../asset/repository";
import { createArchiveCache, openArchive, toArchivePath, type ArchiveOpenResult, type ArchiveSource } from "./index";
import { writeZip, type SyntheticEntry } from "./testing";

const text = (s: string) => new TextEncoder().encode(s);
const path = (p: string) => toArchivePath(p)!;

function patterned(length: number): Uint8Array {
  return new Uint8Array(length).map((_, i) => (i * 31 + (i >> 8)) & 0xff);
}

async function harness(entries: SyntheticEntry[], options: { etags?: boolean } = {}) {
  const memory = new MemoryFileStorage();
  const reads: { offset?: number; length?: number }[] = [];
  const storage: FileStorage = {
    put: (...a) => memory.put(...a),
    head: (k) => memory.head(k),
    delete: (k) => memory.delete(k),
    list: (p, o) => memory.list(p, o),
    get: async (key, range) => {
      reads.push({ ...range });
      const file = await memory.get(key, range);
      return file && options.etags === false ? { ...file, etag: undefined } : file;
    },
  };
  const archives = createArchiveCache();
  const bytes = writeZip(entries);
  const source: ArchiveSource = { key: "assets/x/a.zip", size: bytes.byteLength, filename: "a.zip" };
  const replace = (next: Uint8Array) => memory.put(source.key, new Blob([next as BlobPart]).stream(), "application/zip", next.byteLength);
  await replace(bytes);
  const open = async (p: string, range?: { offset: number; length: number }) => {
    const opened = await openArchive({ storage, archives }, source);
    if (!opened.ok) throw new Error(opened.reason);
    return opened.reader.open(path(p), { range });
  };
  return { reads, open, replace, bytes };
}

async function body(result: ArchiveOpenResult): Promise<Uint8Array> {
  if (!result.ok) throw new Error(result.reason);
  return new Uint8Array(await new Response(result.file.body).arrayBuffer());
}

function deflated(name: string, data: Uint8Array): SyntheticEntry {
  return { name, data, method: 8, compressed: new Uint8Array(deflateRawSync(data)) };
}

describe("ArchiveReader.open", () => {
  test("a warm stored entry costs one read and returns its bytes", async () => {
    const h = await harness([{ name: "a.txt", data: text("first") }, { name: "b.txt", data: text("second entry") }]);
    await h.open("a.txt");
    const before = h.reads.length;
    const read = await h.open("b.txt");
    expect(await body(read)).toEqual(text("second entry"));
    expect(h.reads.length - before).toBe(1);
  });

  test("a stored entry with a range is one bounded read that returns exactly the range", async () => {
    const data = patterned(5000);
    const h = await harness([{ name: "tile.bin", data }]);
    await h.open("tile.bin");
    const before = h.reads.length;
    const read = await h.open("tile.bin", { offset: 1000, length: 1000 });
    expect(await body(read)).toEqual(data.subarray(1000, 2000));
    expect(read.ok && read.file.range).toEqual({ offset: 1000, length: 1000, totalSize: 5000 });
    expect(h.reads.slice(before)).toEqual([{ offset: 0, length: Math.min(30 + 8 + 0xffff + 2000, h.bytes.byteLength) }]);
  });

  test("a range deep in a stored entry probes the local header, then reads only the range", async () => {
    const data = patterned(3 << 20);
    const h = await harness([{ name: "big.bin", data, localExtra: new Uint8Array(12) }]);
    await h.open("big.bin", { offset: 0, length: 1 });
    const before = h.reads.length;
    const read = await h.open("big.bin", { offset: 2 << 20, length: 4096 });
    expect(await body(read)).toEqual(data.subarray(2 << 20, (2 << 20) + 4096));
    expect(h.reads.slice(before)).toEqual([
      { offset: 0, length: 30 + 7 },
      { offset: 30 + 7 + 12 + (2 << 20), length: 4096 },
    ]);
  });

  test("a local extra field longer than the central one is skipped", async () => {
    const h = await harness([{ name: "a.txt", data: text("after a long local extra"), localExtra: new Uint8Array(40_000) }]);
    expect(await body(await h.open("a.txt"))).toEqual(text("after a long local extra"));
  });

  test("a deflate entry is one gzip member sized from the central directory, and a range is not applied", async () => {
    const plain = text("deflated ".repeat(500));
    const h = await harness([deflated("d.txt", plain)]);
    const read = await h.open("d.txt", { offset: 10, length: 10 });
    if (!read.ok) throw new Error(read.reason);
    expect(read.file.contentEncoding).toBe("gzip");
    expect(read.file.range).toBeUndefined();
    expect(read.originalSize).toBe(plain.byteLength);
    const member = await body(read);
    expect(member.byteLength).toBe(read.file.size);
    const decoded = new Uint8Array(await new Response(new Blob([member as BlobPart]).stream().pipeThrough(new DecompressionStream("gzip"))).arrayBuffer());
    expect(decoded).toEqual(plain);
  });

  test("the etag is strong, stable, and differs between entries", async () => {
    const h = await harness([{ name: "a.txt", data: text("one") }, { name: "b.txt", data: text("two") }]);
    const a1 = await h.open("a.txt");
    const a2 = await h.open("a.txt");
    const b = await h.open("b.txt");
    const tag = (r: ArchiveOpenResult) => (r.ok ? r.file.etag : null);
    expect(tag(a1)).toMatch(/^"[^"]+"$/);
    expect(tag(a1)).toBe(tag(a2));
    expect(tag(a1)).not.toBe(tag(b));
  });

  test("encrypted and unsupported-method entries are refused without a read", async () => {
    const h = await harness([
      { name: "secret.txt", data: text("x"), flags: 1 },
      { name: "b.bz2", data: text("y"), method: 12, compressed: text("BZh") },
    ]);
    await h.open("secret.txt");
    const before = h.reads.length;
    expect(await h.open("secret.txt")).toEqual({ ok: false, reason: "encrypted" });
    expect(await h.open("b.bz2")).toEqual({ ok: false, reason: "unsupported-method" });
    expect(await h.open("missing.txt")).toEqual({ ok: false, reason: "not-found" });
    expect(h.reads.length).toBe(before);
  });

  test("a local header that contradicts a freshly read central directory is corrupt", async () => {
    const fresh = await harness([{ name: "a.txt", data: text("x") }]);
    const broken = fresh.bytes.slice();
    broken[30] = "b".charCodeAt(0);
    await fresh.replace(broken);
    expect(await fresh.open("a.txt")).toEqual({ ok: false, reason: "corrupt" });
  });

  for (const etags of [true, false]) {
    test(`a replaced original is reported as changed and read fresh next time (etags ${etags ? "on" : "off"})`, async () => {
      const h = await harness([{ name: "a.txt", data: text("aaaa") }, { name: "b.txt", data: text("bb") }], { etags });
      expect(await body(await h.open("b.txt"))).toEqual(text("bb"));
      await h.replace(writeZip([{ name: "b.txt", data: text("BB") }, { name: "a.txt", data: text("AAAA") }]));
      expect(await h.open("b.txt")).toEqual({ ok: false, reason: "changed" });
      expect(await body(await h.open("b.txt"))).toEqual(text("BB"));
    });
  }
});
