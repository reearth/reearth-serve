import { deflateRawSync } from "node:zlib";
import { describe, expect, test } from "vitest";
import { MemoryFileStorage } from "../../adapters/memory/storage";
import { writeZip, type SyntheticEntry } from "../../adapters/memory/zip";
import type { FileStorage } from "../asset/repository";
import { createArchiveCache, openArchive, toArchivePath, type ArchiveOpenResult } from "./index";

const text = (s: string) => new TextEncoder().encode(s);
const PLAIN = text("hello, hostile zip!");
const CD_SIGNATURE = 0x02014b50;

function deflated(name: string, data: Uint8Array): SyntheticEntry {
  return { name, data, method: 8, compressed: new Uint8Array(deflateRawSync(data)) };
}

function patchCd(bytes: Uint8Array, index: number, fields: { compressedSize?: number; size?: number; localHeaderOffset?: number }): Uint8Array {
  const out = bytes.slice();
  const view = new DataView(out.buffer);
  const records: number[] = [];
  for (let i = 0; i + 4 <= out.byteLength; i++) if (view.getUint32(i, true) === CD_SIGNATURE) records.push(i);
  const at = records[index];
  if (fields.compressedSize !== undefined) view.setUint32(at + 20, fields.compressedSize, true);
  if (fields.size !== undefined) view.setUint32(at + 24, fields.size, true);
  if (fields.localHeaderOffset !== undefined) view.setUint32(at + 42, fields.localHeaderOffset, true);
  return out;
}

async function harness(bytes: Uint8Array) {
  const memory = new MemoryFileStorage();
  const reads: { offset?: number; length?: number }[] = [];
  const storage: FileStorage = {
    put: (...a) => memory.put(...a),
    head: (k) => memory.head(k),
    delete: (k) => memory.delete(k),
    list: (p, o) => memory.list(p, o),
    get: async (key, range) => {
      reads.push({ ...range });
      return memory.get(key, range);
    },
  };
  const source = { key: "assets/x/a.zip", size: bytes.byteLength, filename: "a.zip" };
  await memory.put(source.key, new Blob([bytes as BlobPart]).stream(), "application/zip", bytes.byteLength);
  const archives = createArchiveCache();
  const open = async (name: string, range?: { offset: number; length: number }): Promise<ArchiveOpenResult> => {
    const opened = await openArchive({ storage, archives }, source);
    if (!opened.ok) throw new Error(`open refused: ${opened.reason}`);
    return opened.reader.open(toArchivePath(name)!, { range });
  };
  return { open, reads };
}

async function served(result: ArchiveOpenResult): Promise<Uint8Array> {
  if (!result.ok) throw new Error(result.reason);
  return new Uint8Array(await new Response(result.file.body).arrayBuffer());
}

describe("an entry whose central directory claims do not fit its bytes", () => {
  const corrupt = { ok: false, reason: "corrupt" };

  test("a stored entry whose compressed size exceeds its size is corrupt, not served with central-directory bytes", async () => {
    const h = await harness(patchCd(writeZip([{ name: "a.txt", data: PLAIN }]), 0, { compressedSize: PLAIN.byteLength + 20 }));
    expect(await h.open("a.txt")).toMatchObject(corrupt);
  });

  test("a stored entry whose compressed size is under its size is corrupt, not a short body", async () => {
    const h = await harness(patchCd(writeZip([{ name: "a.txt", data: PLAIN }]), 0, { compressedSize: PLAIN.byteLength - 5 }));
    expect(await h.open("a.txt")).toMatchObject(corrupt);
  });

  test("a stored entry claiming 4 GiB in a tiny file is corrupt", async () => {
    const h = await harness(patchCd(writeZip([{ name: "a.txt", data: PLAIN }]), 0, { compressedSize: 0xffffffff, size: 0xffffffff }));
    expect(await h.open("a.txt")).toMatchObject(corrupt);
  });

  test("a deflate entry whose compressed size reaches into the central directory is corrupt", async () => {
    const entry = deflated("d.txt", text("deflated ".repeat(50)));
    const h = await harness(patchCd(writeZip([entry]), 0, { compressedSize: entry.compressed!.byteLength + 60 }));
    expect(await h.open("d.txt")).toMatchObject(corrupt);
  });

  test("a deflate entry whose compressed size runs past the end of the file is corrupt", async () => {
    const h = await harness(patchCd(writeZip([deflated("d.txt", text("abc ".repeat(40)))]), 0, { compressedSize: 0x10000 }));
    expect(await h.open("d.txt")).toMatchObject(corrupt);
  });

  test("a deflate entry with compressed size 0 and a non-empty size is corrupt", async () => {
    const h = await harness(patchCd(writeZip([deflated("d.txt", text("some bytes"))]), 0, { compressedSize: 0 }));
    expect(await h.open("d.txt")).toMatchObject(corrupt);
  });

  test("a local header offset past the end of the file is corrupt", async () => {
    const clean = writeZip([{ name: "a.txt", data: PLAIN }]);
    const h = await harness(patchCd(clean, 0, { localHeaderOffset: clean.byteLength + 100 }));
    expect(await h.open("a.txt")).toMatchObject(corrupt);
  });

  test("a local header offset into another entry's data is refused", async () => {
    const h = await harness(patchCd(writeZip([{ name: "a.txt", data: PLAIN }, { name: "b.txt", data: text("second") }]), 1, { localHeaderOffset: 40 }));
    expect((await h.open("b.txt")).ok).toBe(false);
  });

  test("a local extra length that pushes the data into the central directory is corrupt", async () => {
    const bytes = writeZip([{ name: "a.txt", data: PLAIN }]);
    new DataView(bytes.buffer).setUint16(28, 200, true);
    const h = await harness(bytes);
    expect(await h.open("a.txt")).toMatchObject(corrupt);
  });

  test("a corrupt entry is refused again from the cached directory, with no rebuild", async () => {
    const h = await harness(patchCd(writeZip([{ name: "a.txt", data: PLAIN }, { name: "b.txt", data: text("fine") }]), 0, { compressedSize: PLAIN.byteLength + 20 }));
    expect(await served(await h.open("b.txt"))).toEqual(text("fine"));
    const before = h.reads.length;
    for (let i = 0; i < 3; i++) expect(await h.open("a.txt")).toMatchObject(corrupt);
    expect(h.reads.length).toBe(before);
  });

  test("a local header that pushes data into the central directory never evicts the cached directory", async () => {
    const bytes = writeZip([{ name: "b.txt", data: text("fine") }, { name: "a.txt", data: PLAIN }]);
    new DataView(bytes.buffer).setUint16(30 + 5 + 4 + 28, 200, true);
    const h = await harness(bytes);
    expect(await served(await h.open("b.txt"))).toEqual(text("fine"));
    const before = h.reads.length;
    for (let i = 0; i < 3; i++) expect(await h.open("a.txt")).toMatchObject(corrupt);
    expect(h.reads.length - before).toBe(3);
  });
});

describe("an entry whose claims fit", () => {
  test("an empty deflate entry, compressed size 0 or not, is an empty body with no read", async () => {
    const zero = patchCd(writeZip([deflated("e.txt", new Uint8Array(0))]), 0, { compressedSize: 0 });
    for (const bytes of [zero, writeZip([deflated("e.txt", new Uint8Array(0))])]) {
      const h = await harness(bytes);
      await h.open("missing.txt");
      const before = h.reads.length;
      const result = await h.open("e.txt");
      expect(result).toMatchObject({ ok: true, file: { size: 0 }, originalSize: 0 });
      expect(result.ok && result.file.contentEncoding).toBeUndefined();
      expect(await served(result)).toEqual(new Uint8Array(0));
      expect(h.reads.length).toBe(before);
    }
  });

  test("a local extra field of 0xffff bytes is skipped and the data is exact", async () => {
    const data = text("after the biggest extra");
    const h = await harness(writeZip([{ name: "a.txt", data, localExtra: new Uint8Array(0xffff) }]));
    expect(await served(await h.open("a.txt"))).toEqual(data);
  });
});

describe("a Range a stored entry cannot satisfy", () => {
  const BIG = new Uint8Array(3 << 20).map((_, i) => (i * 13) & 0xff);

  test.each([
    ["starts at the end", { offset: BIG.byteLength, length: Number.MAX_SAFE_INTEGER }],
    ["starts past the end", { offset: BIG.byteLength + 10, length: 11 }],
    ["ends before it starts", { offset: 2_000_000, length: 100 - 2_000_000 + 1 }],
  ])("%s answers unsatisfiable with the entry size, reading nothing and keeping the directory", async (_, range) => {
    const h = await harness(writeZip([{ name: "big.bin", data: BIG }]));
    await served(await h.open("big.bin", { offset: 0, length: 10 }));
    const before = h.reads.length;
    for (let i = 0; i < 3; i++) expect(await h.open("big.bin", range)).toEqual({ ok: false, reason: "unsatisfiable", size: BIG.byteLength });
    expect(h.reads.length).toBe(before);
    expect(await served(await h.open("big.bin", { offset: 0, length: 10 }))).toEqual(BIG.subarray(0, 10));
    expect(h.reads.length - before).toBe(1);
  });

  test("an empty entry cannot satisfy bytes=0-", async () => {
    const h = await harness(writeZip([{ name: "empty.txt", data: new Uint8Array(0) }]));
    expect(await h.open("empty.txt", { offset: 0, length: Number.MAX_SAFE_INTEGER })).toEqual({ ok: false, reason: "unsatisfiable", size: 0 });
  });
});
