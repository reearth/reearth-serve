import { afterEach, beforeAll, beforeEach, describe, expect, test, vi } from "vitest";
import { MemoryFileStorage } from "../../adapters/memory/storage";
import { writeZip } from "../../adapters/memory/zip";
import type { FileStorage } from "../asset/repository";
import { createArchiveCache, openArchive, toArchivePath, type ArchivePath, type ArchiveReader, type ArchiveSource } from "./index";
import { encodeIndex } from "./index-format";
import { directoryTable } from "./reader";
import { crc32, locateDirectory } from "./zip/directory";

const enc = new TextEncoder();
const dec = new TextDecoder();

const HEADER = 128;
const FENCE = 20;
const RECORD = 52;
const PAGE = 256;
const H = { rootLen: 14, count: 16, pageCount: 20, cdOffset: 40, fenceEnd: 64, fenceCrc: 72, headerCrc: 124 };
const R = { nameOffset: 0, compressed: 16, size: 24, localOffset: 32, nameLength: 44 };

const dv = (b: Uint8Array) => new DataView(b.buffer, b.byteOffset, b.byteLength);
const fenceAt = (b: Uint8Array, p: number) => HEADER + dv(b).getUint16(H.rootLen, true) + p * FENCE;
const pageOff = (b: Uint8Array, p: number) => dv(b).getFloat64(fenceAt(b, p), true);
const pageLen = (b: Uint8Array, p: number) => dv(b).getUint32(fenceAt(b, p) + 8, true);
const countOf = (b: Uint8Array, p: number) => Math.min(PAGE, dv(b).getUint32(H.count, true) - p * PAGE);
const recAt = (b: Uint8Array, p: number, i: number) => pageOff(b, p) + i * RECORD;

/** Recompute every page, fence and header CRC-32, so only the structural checks can catch an edit. */
function refresh(b: Uint8Array): Uint8Array {
  const v = dv(b);
  for (let p = 0; p < v.getUint32(H.pageCount, true); p++) {
    const off = pageOff(b, p);
    v.setUint32(fenceAt(b, p) + 12, crc32(b.subarray(off, off + pageLen(b, p))), true);
  }
  v.setUint32(H.fenceCrc, crc32(b.subarray(HEADER, v.getFloat64(H.fenceEnd, true))), true);
  v.setUint32(H.headerCrc, crc32(b.subarray(0, H.headerCrc)), true);
  return b;
}

const zipOf = (names: string[], tag = "a") => writeZip(names.map((name, i) => ({ name, data: enc.encode(`${tag}${i}-${"y".repeat(i % 11)}`) })));
const names600 = Array.from({ length: 600 }, (_, i) => `d${i % 7}/f${String(i).padStart(4, "0")}.txt`);
const names20 = names600.slice(0, 20);
const PROBES = ["nope.txt", "d0/", "d0/f0000.txt~", "zzz"];

async function put(storage: FileStorage, key: string, bytes: Uint8Array) {
  await storage.put(key, new Blob([bytes as BlobPart]).stream(), "application/octet-stream", bytes.byteLength);
}

function wrapped(inner: FileStorage, get: FileStorage["get"], head: FileStorage["head"] = (k) => inner.head(k)): FileStorage {
  return { put: (...a) => inner.put(...a), delete: (k) => inner.delete(k), list: (p, o) => inner.list(p, o), head, get };
}

async function indexOf(zip: Uint8Array, filename = "x.zip"): Promise<Uint8Array> {
  const memory = new MemoryFileStorage();
  await put(memory, "src", zip);
  const located = await locateDirectory(memory, "src", zip.byteLength);
  if (!located.ok) throw new Error(located.reason);
  const read = await directoryTable(memory, { key: "src", size: zip.byteLength, filename }, located.directory);
  if (!read.ok) throw new Error(read.reason);
  const bytes = encodeIndex({ ...read, directory: located.directory, sourceSize: zip.byteLength });
  if (!bytes) throw new Error("index did not encode");
  return bytes;
}

async function answers(reader: ArchiveReader, names: string[], full: boolean) {
  const settle = async (f: () => Promise<unknown>) => {
    try {
      return await f();
    } catch (e) {
      return { threw: e instanceof Error ? e.message : String(e) };
    }
  };
  const listing = await settle(async () => {
    const entries: unknown[] = [];
    let after: string | undefined;
    for (;;) {
      const page = await reader.list({ after, limit: 1000 });
      entries.push(...page.entries, ...page.commonPrefixes);
      if (page.next === undefined) return entries;
      after = page.next;
    }
  });
  const stat: Record<string, unknown> = {};
  for (const n of [...names, ...PROBES]) stat[n] = await settle(() => reader.stat(toArchivePath(n) as ArchivePath));
  const open: Record<string, unknown> = {};
  if (full) {
    for (const n of names) {
      open[n] = await settle(async () => {
        const r = await reader.open(toArchivePath(n) as ArchivePath);
        if (!r.ok) return { reason: r.reason };
        return { size: r.file.size, etag: r.file.etag, body: dec.decode(await new Response(r.file.body).arrayBuffer()) };
      });
    }
  }
  return { rootPrefix: reader.rootPrefix, entryCount: reader.entryCount, listing, stat, open };
}

interface ServeOptions {
  filename?: string;
  full?: boolean;
  names?: string[];
  wrap?: (s: FileStorage) => FileStorage;
}

/** The answers with `index` as the zip's container index, next to the central directory's answers for the same zip. */
async function serve(index: Uint8Array, zip: Uint8Array, opts: ServeOptions = {}) {
  const memory = new MemoryFileStorage();
  const src: ArchiveSource = { key: "src", size: zip.byteLength, filename: opts.filename ?? "x.zip", index: "idx" };
  await put(memory, src.key, zip);
  await put(memory, "idx", index);
  const storage = opts.wrap ? opts.wrap(memory) : memory;
  const names = opts.names ?? names600;
  const full = opts.full ?? true;
  const indexed = await openArchive({ storage, archives: createArchiveCache() }, src);
  const cd = await openArchive({ storage: memory, archives: createArchiveCache() }, { ...src, index: undefined });
  if (!indexed.ok || !cd.ok) throw new Error("fixture did not open");
  return { indexed: await answers(indexed.reader, names, full), cd: await answers(cd.reader, names, full) };
}

async function expectCentralDirectoryAnswers(index: Uint8Array, zip: Uint8Array, opts?: ServeOptions) {
  const { indexed, cd } = await serve(index, zip, opts);
  expect(indexed).toEqual(cd);
}

let warn: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  warn = vi.spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(() => warn.mockRestore());

let good: Uint8Array;
let zipA: Uint8Array;
let big: Uint8Array;
let bigZip: Uint8Array;
beforeAll(async () => {
  zipA = zipOf(names600, "a");
  good = await indexOf(zipA);
  bigZip = zipOf(Array.from({ length: 3000 }, (_, i) => `dir${i % 9}/file-${String(i).padStart(6, "0")}-name.txt`), "c");
  big = await indexOf(bigZip);
});

describe("a fresh index", () => {
  test("answers exactly what the central directory answers over three pages", async () => {
    await expectCentralDirectoryAnswers(good, zipA);
  });
});

describe("an accidentally damaged index falls back to the central directory", () => {
  test("every single-byte flip over a 20-entry index", async () => {
    const zip = zipOf(names20, "a");
    const small = await indexOf(zip);
    const { cd } = await serve(small, zip, { full: false, names: names20 });
    const wrong: number[] = [];
    for (let i = 0; i < small.byteLength; i++) {
      const b = small.slice();
      b[i] ^= 0xff;
      const { indexed } = await serve(b, zip, { full: false, names: names20 });
      if (JSON.stringify(indexed) !== JSON.stringify(cd)) wrong.push(i);
    }
    expect(wrong).toEqual([]);
  }, 120_000);

  test.each([0, 1, 64, 127, 128])("truncated to %i bytes", async (length) => {
    await expectCentralDirectoryAnswers(good.slice(0, length), zipA);
  });

  test("truncated at every fence and page boundary", async () => {
    const rootEnd = HEADER + dv(good).getUint16(H.rootLen, true);
    const fenceEnd = dv(good).getFloat64(H.fenceEnd, true);
    const cuts = new Set([rootEnd, rootEnd + 1, fenceEnd - 1, fenceEnd, fenceEnd + 1, good.byteLength - 1]);
    for (let p = 0; p < 3; p++) for (const c of [pageOff(good, p), pageOff(good, p) + 1, pageOff(good, p) + pageLen(good, p) - 1]) cuts.add(c);
    for (const cut of cuts) await expectCentralDirectoryAnswers(good.slice(0, cut), zipA);
  }, 120_000);
});

describe("an index for an original replaced at the same key falls back on a cold open", () => {
  const before = writeZip([{ name: "x.txt", data: enc.encode("aaaa") }, { name: "y.txt", data: enc.encode("bb") }]);
  const after = writeZip([{ name: "p.txt", data: enc.encode("aaaa") }, { name: "q.txt", data: enc.encode("bb") }]);

  test("list and stat answer the new original when the first call is a listing", async () => {
    expect(after.byteLength).toBe(before.byteLength);
    const memory = new MemoryFileStorage();
    const source: ArchiveSource = { key: "assets/x/a.zip", size: after.byteLength, filename: "a.zip", index: "assets/x/_archive/container.v1" };
    await put(memory, source.key, before);
    const located = await locateDirectory(memory, source.key, source.size);
    if (!located.ok) throw new Error(located.reason);
    const read = await directoryTable(memory, source, located.directory);
    if (!read.ok) throw new Error(read.reason);
    await put(memory, source.index!, encodeIndex({ ...read, directory: located.directory, sourceSize: source.size })!);
    await put(memory, source.key, after);

    const opened = await openArchive({ storage: memory, archives: createArchiveCache() }, source);
    const fresh = await openArchive({ storage: memory, archives: createArchiveCache() }, { ...source, index: undefined });
    if (!opened.ok || !fresh.ok) throw new Error("did not open");
    expect(await opened.reader.list({})).toEqual(await fresh.reader.list({}));
    expect(await opened.reader.stat(toArchivePath("x.txt")!)).toBeNull();
    expect((await opened.reader.stat(toArchivePath("p.txt")!))?.path).toBe("p.txt");
  });

  test("an index without a recorded etag is not trusted", async () => {
    const memory = new MemoryFileStorage();
    const noEtags = wrapped(
      memory,
      async (k, r) => {
        const f = await memory.get(k, r);
        return f && { ...f, etag: undefined };
      },
    );
    await put(memory, "src", before);
    const located = await locateDirectory(noEtags, "src", before.byteLength);
    if (!located.ok) throw new Error(located.reason);
    expect(located.directory.etag).toBeUndefined();
    const read = await directoryTable(noEtags, { key: "src", size: before.byteLength, filename: "x.zip" }, located.directory);
    if (!read.ok) throw new Error(read.reason);
    const index = encodeIndex({ ...read, directory: located.directory, sourceSize: before.byteLength })!;
    await expectCentralDirectoryAnswers(index, after, { names: ["x.txt", "p.txt"] });
  });

  test("an original whose store reports no etag does not trust the index", async () => {
    const index = await indexOf(before);
    let indexReads = 0;
    await expectCentralDirectoryAnswers(index, after, {
      names: ["x.txt", "p.txt"],
      wrap: (s) =>
        wrapped(
          s,
          (k, r) => {
            if (k === "idx") indexReads++;
            return s.get(k, r);
          },
          async (k) => {
            const h = await s.head(k);
            return h && { ...h, etag: undefined };
          },
        ),
    });
    expect(indexReads).toBeLessThanOrEqual(1);
  });
});

describe("an index that breaks the format's structure falls back, even with valid checksums", () => {
  test("header count lowered by one", async () => {
    const b = good.slice();
    dv(b).setUint32(H.count, 599, true);
    await expectCentralDirectoryAnswers(refresh(b), zipA);
  });

  test("header count raised by one", async () => {
    const b = good.slice();
    dv(b).setUint32(H.count, 601, true);
    await expectCentralDirectoryAnswers(refresh(b), zipA);
  });

  test("header count lowered within the same page count", async () => {
    const names = Array.from({ length: 300 }, (_, i) => `f${String(i).padStart(4, "0")}.txt`);
    const zip = writeZip(names.map((name) => ({ name, data: enc.encode("d") })));
    const b = await indexOf(zip);
    dv(b).setUint32(H.count, 260, true);
    dv(b).setUint32(H.headerCrc, crc32(b.subarray(0, H.headerCrc)), true);
    await expectCentralDirectoryAnswers(b, zip, { names, full: false });
  });

  test("pages 0 and 1 swapped in the fence", async () => {
    const b = good.slice();
    const f0 = fenceAt(b, 0);
    const f1 = fenceAt(b, 1);
    const first = b.slice(f0, f0 + 12);
    b.set(b.slice(f1, f1 + 12), f0);
    b.set(first, f1);
    await expectCentralDirectoryAnswers(refresh(b), zipA);
  });

  test("a fence first name that does not ascend", async () => {
    const b = good.slice();
    const namesAt = HEADER + dv(b).getUint16(H.rootLen, true) + 3 * FENCE;
    const second = namesAt + dv(b).getUint32(fenceAt(b, 0) + 16, true);
    b.fill(0x7e, second, second + dv(b).getUint32(fenceAt(b, 1) + 16, true));
    await expectCentralDirectoryAnswers(refresh(b), zipA);
  });

  test("a name offset past its page's name heap", async () => {
    const b = good.slice();
    dv(b).setUint32(recAt(b, 0, 5) + R.nameOffset, 0xfffff000, true);
    await expectCentralDirectoryAnswers(refresh(b), zipA);
  });

  test("a name length grown into its neighbour", async () => {
    const b = good.slice();
    const at = recAt(b, 0, 7) + R.nameLength;
    dv(b).setUint32(at, dv(b).getUint32(at, true) + 3, true);
    await expectCentralDirectoryAnswers(refresh(b), zipA);
  });

  test("records out of order within a page", async () => {
    const b = good.slice();
    const r3 = recAt(b, 0, 3);
    const r4 = recAt(b, 0, 4);
    const third = b.slice(r3, r3 + RECORD);
    b.set(b.slice(r4, r4 + RECORD), r3);
    b.set(third, r4);
    await expectCentralDirectoryAnswers(refresh(b), zipA);
  });

  test("an entry whose data runs past the central directory", async () => {
    const b = good.slice();
    const last = recAt(b, 2, countOf(b, 2) - 1);
    dv(b).setFloat64(last + R.size, dv(b).getFloat64(last + R.size, true) + 1000, true);
    dv(b).setFloat64(last + R.compressed, dv(b).getFloat64(last + R.compressed, true) + 1000, true);
    await expectCentralDirectoryAnswers(refresh(b), zipA);
  });

  test("a negative local header offset, in a store that rejects negative ranges", async () => {
    const b = good.slice();
    dv(b).setFloat64(recAt(b, 0, 0) + R.localOffset, -1, true);
    await expectCentralDirectoryAnswers(refresh(b), zipA, {
      wrap: (s) =>
        wrapped(s, async (k, r) => {
          if (r && r.offset < 0) throw new Error("InvalidRange: negative offset");
          return s.get(k, r);
        }),
    });
  });
});

describe("reads of the index never allocate past the index object's size", () => {
  async function largestIndexRead(index: Uint8Array, zip: Uint8Array) {
    const requested: number[] = [];
    await expectCentralDirectoryAnswers(index, zip, {
      full: false,
      wrap: (s) =>
        wrapped(s, (k, r) => {
          if (k === "idx") requested.push(r?.length ?? Infinity);
          return s.get(k, r);
        }),
    });
    return Math.max(0, ...requested);
  }

  test("a header that claims a 300 MB fence", async () => {
    const b = big.slice();
    dv(b).setFloat64(H.fenceEnd, 300_000_000, true);
    expect(await largestIndexRead(refresh(b), bigZip)).toBeLessThanOrEqual(b.byteLength);
  });

  test("a header that claims 2^32-1 entries and the matching fence", async () => {
    const b = big.slice();
    const pages = Math.ceil(0xffffffff / PAGE);
    dv(b).setUint32(H.count, 0xffffffff, true);
    dv(b).setUint32(H.pageCount, pages, true);
    dv(b).setFloat64(H.fenceEnd, HEADER + dv(b).getUint16(H.rootLen, true) + pages * FENCE, true);
    dv(b).setUint32(H.headerCrc, crc32(b.subarray(0, H.headerCrc)), true);
    expect(await largestIndexRead(b, bigZip)).toBeLessThanOrEqual(b.byteLength);
  });

  test("a page that claims 512 MB", async () => {
    const b = good.slice();
    dv(b).setUint32(fenceAt(b, 0) + 8, 512 * 1024 * 1024, true);
    expect(await largestIndexRead(refresh(b), zipA)).toBeLessThanOrEqual(b.byteLength);
  });
});

describe("a storage error on the index path falls back instead of rejecting", () => {
  const failing = (when: (key: string, range?: { offset: number; length: number }) => boolean) => (s: FileStorage) =>
    wrapped(s, async (k, r) => {
      if (when(k, r)) throw new Error("storage unavailable");
      return s.get(k, r);
    });

  test("the index head read", async () => {
    await expectCentralDirectoryAnswers(good, zipA, { wrap: failing((k, r) => k === "idx" && r?.offset === 0) });
  });

  test("a page read", async () => {
    await expectCentralDirectoryAnswers(good, zipA, { wrap: failing((k, r) => k === "idx" && (r?.offset ?? 0) > 0) });
  });

  test("the original's metadata read", async () => {
    await expectCentralDirectoryAnswers(good, zipA, {
      wrap: (s) =>
        wrapped(
          s,
          (k, r) => s.get(k, r),
          async () => {
            throw new Error("storage unavailable");
          },
        ),
    });
  });
});
