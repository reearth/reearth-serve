import { readdirSync, readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { MemoryFileStorage } from "../../adapters/memory/storage";
import { writeZip, type SyntheticEntry } from "../../adapters/memory/zip";
import type { FileStorage } from "../asset/repository";
import { createArchiveCache, openArchive, toArchivePath, type ArchiveReader, type ArchiveSource } from "./index";
import { encodeIndex, readFence, readHeader } from "./index-format";
import { buildView, directoryTable } from "./reader";
import type { ListQuery, TableView } from "./views";
import { locateDirectory } from "./zip/directory";

const FIXTURES = new URL("../../scripts/fixtures/zip/data/", import.meta.url);
const text = (s: string) => new TextEncoder().encode(s);

function counting(inner: FileStorage, options: { etags?: boolean } = {}) {
  const reads: { key: string; offset?: number; length?: number }[] = [];
  const heads: string[] = [];
  const storage: FileStorage = {
    put: (...a) => inner.put(...a),
    head: async (k) => {
      heads.push(k);
      const head = await inner.head(k);
      return head && options.etags === false ? { ...head, etag: undefined } : head;
    },
    delete: (k) => inner.delete(k),
    list: (p, o) => inner.list(p, o),
    get: async (key, range) => {
      reads.push({ key, ...range });
      const file = await inner.get(key, range);
      return file && options.etags === false ? { ...file, etag: undefined } : file;
    },
  };
  return { storage, reads, heads };
}

async function put(storage: FileStorage, key: string, bytes: Uint8Array) {
  await storage.put(key, new Blob([bytes as BlobPart]).stream(), "application/octet-stream", bytes.byteLength);
}

async function indexBytes(storage: FileStorage, source: ArchiveSource): Promise<Uint8Array> {
  const located = await locateDirectory(storage, source.key, source.size);
  if (!located.ok) throw new Error(located.reason);
  const read = await directoryTable(storage, source, located.directory);
  if (!read.ok) throw new Error(read.reason);
  const bytes = encodeIndex({ ...read, directory: located.directory, sourceSize: source.size });
  if (!bytes) throw new Error("index did not encode");
  return bytes;
}

async function harness(bytes: Uint8Array, filename = "a.zip", options: { etags?: boolean } = {}) {
  const memory = new MemoryFileStorage();
  const { storage, reads, heads } = counting(memory, options);
  const source: ArchiveSource = { key: `assets/x/${filename}`, size: bytes.byteLength, filename, index: `assets/x/${filename}.idx` };
  await put(memory, source.key, bytes);
  await put(memory, source.index!, await indexBytes(memory, source));
  const archives = createArchiveCache();
  const open = async (): Promise<ArchiveReader> => {
    const opened = await openArchive({ storage, archives }, source);
    if (!opened.ok) throw new Error(opened.reason);
    return opened.reader;
  };
  const indexReads = () => reads.filter((r) => r.key === source.index).length;
  const distrusted = () => archives.distrusted(`${source.key}#${source.size}`);
  return { memory, storage, reads, heads, source, archives, open, indexReads, distrusted };
}

async function views(bytes: Uint8Array, filename: string): Promise<{ memory: TableView; indexed: TableView }> {
  const h = await harness(bytes, filename);
  const memory = await buildView(h.storage, { ...h.source, index: undefined }, () => {});
  const indexed = await buildView(h.storage, h.source, () => {});
  if (!memory.ok || !indexed.ok) throw new Error("fixture did not open");
  expect(indexed.view.from).toBe("index");
  return { memory: memory.view, indexed: indexed.view };
}

async function walk(view: TableView, query: Omit<ListQuery, "after">, after = "") {
  const pages = [];
  for (;;) {
    const page = await view.list({ ...query, after });
    pages.push(page);
    if (page.next === undefined) return pages;
    after = page.next;
  }
}

async function bodyOf(reader: ArchiveReader, path: string): Promise<string> {
  const read = await reader.open(toArchivePath(path)!);
  if (!read.ok) throw new Error(read.reason);
  return new TextDecoder().decode(await new Response(read.file.body).arrayBuffer());
}

async function allPaths(reader: ArchiveReader): Promise<string[]> {
  const out: string[] = [];
  let after: string | undefined;
  do {
    const page = await reader.list({ after, limit: 1000 });
    out.push(...page.entries.map((e) => e.path));
    after = page.next;
  } while (after !== undefined);
  return out;
}

const nested: SyntheticEntry[] = Array.from({ length: 1100 }, (_, i) => ({
  name: i % 50 === 0 ? `root${i}.txt` : `a${i % 5}/b${i % 13}/${i % 3 ? "c/" : ""}f${String(i).padStart(5, "0")}.txt`,
  data: text(`entry ${i}`),
}));

const archives: [string, Uint8Array][] = [
  ...readdirSync(FIXTURES)
    .filter((f) => f.endsWith(".zip"))
    .map((f) => [f, new Uint8Array(readFileSync(new URL(f, FIXTURES)))] as [string, Uint8Array]),
  ["nested.zip", writeZip(nested)],
];

let warn: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  warn = vi.spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(() => warn.mockRestore());

describe("IndexedView answers exactly what MemoryView answers", () => {
  test.each(archives)("%s", async (filename, bytes) => {
    const { memory, indexed } = await views(bytes, filename);
    expect(indexed.rootPrefix).toBe(memory.rootPrefix);
    expect(indexed.entryCount).toBe(memory.entryCount);
    expect(indexed.etag).toBe(memory.etag);

    const paths = (await walk(memory, { prefix: "", delimiter: "", limit: 10_000 })).flatMap((p) => p.entries.map((e) => e.path));
    for (const path of paths) {
      expect(await indexed.find(path)).toEqual(await memory.find(path));
      expect(await indexed.find(`${path}~`)).toBeNull();
    }
    for (const miss of ["", "!", "zzzz", "a0/", "\u{10FFFF}"]) expect(await indexed.find(miss)).toEqual(await memory.find(miss));

    const prefixes = new Set([""]);
    for (const path of paths) {
      const segments = path.split("/");
      for (let n = 1; n < segments.length; n++) prefixes.add(`${segments.slice(0, n).join("/")}/`);
      prefixes.add(path.slice(0, 1));
    }
    for (const prefix of prefixes) {
      for (const delimiter of ["/", ""]) {
        for (const limit of [1, 7, 256, 1000]) {
          if (limit === 1 && prefix === "" && paths.length > 300) continue;
          expect(await walk(indexed, { prefix, delimiter, limit }), JSON.stringify({ prefix, delimiter, limit })).toEqual(
            await walk(memory, { prefix, delimiter, limit }),
          );
        }
      }
    }

    const boundaries = paths.length > 300 ? paths.filter((_, i) => i % 256 <= 1 || i % 256 >= 254 || i % 37 === 0) : paths;
    for (const after of boundaries) {
      for (const delimiter of ["/", ""]) {
        for (const limit of [1, 7, 256]) {
          const query = { prefix: "", delimiter, after, limit };
          expect(await indexed.list(query), JSON.stringify(query)).toEqual(await memory.list(query));
        }
      }
    }
  });
});

describe("storage reads with an index", () => {
  test("a cold find and open costs a HEAD of the original beside the index head, one page and the entry; a warm one costs the entry", async () => {
    const h = await harness(writeZip(nested));
    const path = "a1/b1/c/f00001.txt";
    expect(await bodyOf(await h.open(), path)).toBe("entry 1");
    expect(h.heads).toEqual([h.source.key]);
    expect(h.reads.map((r) => r.key)).toEqual([h.source.index, h.source.index, h.source.key]);

    h.reads.length = 0;
    h.heads.length = 0;
    expect(await bodyOf(await h.open(), path)).toBe("entry 1");
    expect(h.heads).toEqual([]);
    expect(h.reads.map((r) => r.key)).toEqual([h.source.key]);
  });

  test("a fence past the first 64 KiB costs one more read, once", async () => {
    const page = (k: number, j: number) => `${String(k).padStart(4, "0")}/${j === 0 ? "0".repeat(4000) : `${String(j).padStart(3, "0")}x`}`;
    const names = Array.from({ length: 20 * 256 }, (_, i) => page(Math.floor(i / 256), i % 256));
    const h = await harness(writeZip(names.map((name) => ({ name, data: new Uint8Array(0) }))));
    const reader = await h.open();
    const last = names[names.length - 1];
    expect((await reader.stat(toArchivePath(last)!))?.path).toBe(last);
    expect(h.indexReads()).toBe(3);
  });
});

describe("an index that does not match falls back to the central directory", () => {
  const entries = [{ name: "x.txt", data: text("aaaa") }, { name: "y.txt", data: text("bb") }];

  test("a missing index object", async () => {
    const h = await harness(writeZip(nested));
    await h.memory.delete(h.source.index!);
    const reader = await h.open();
    expect(await bodyOf(reader, "root50.txt")).toBe("entry 50");
    expect(await allPaths(reader)).toHaveLength(1100);
    h.reads.length = 0;
    await h.open();
    expect(h.indexReads()).toBe(0);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining(h.source.index!));
  });

  test("garbage where the index should be", async () => {
    const h = await harness(writeZip(nested));
    await put(h.memory, h.source.index!, new Uint8Array(5000).map((_, i) => (i * 7) & 0xff));
    const reader = await h.open();
    expect(await bodyOf(reader, "root50.txt")).toBe("entry 50");
    expect(await allPaths(reader)).toHaveLength(1100);
    h.reads.length = 0;
    await h.open();
    expect(h.indexReads()).toBe(0);
  });

  test("an index for another zip of the same size, caught by its etag on open", async () => {
    const h = await harness(writeZip(entries));
    const other = writeZip([{ name: "x.txt", data: text("AAAA") }, { name: "y.txt", data: text("BB") }]);
    expect(other.byteLength).toBe(h.source.size);
    await put(h.memory, h.source.key, other);

    expect(await bodyOf(await h.open(), "x.txt")).toBe("AAAA");
    const reader = await h.open();
    const fresh = await openArchive({ storage: h.storage, archives: createArchiveCache() }, { ...h.source, index: undefined });
    if (!fresh.ok) throw new Error(fresh.reason);
    expect(await reader.list({})).toEqual(await fresh.reader.list({}));
    expect(await bodyOf(reader, "y.txt")).toBe("BB");
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("not used (etag)"));
    h.reads.length = 0;
    await h.open();
    expect(h.indexReads()).toBe(0);
  });

  test("a store without etags never uses the index", async () => {
    const h = await harness(writeZip(entries), "a.zip", { etags: false });
    const other = writeZip([{ name: "y.txt", data: text("BB") }, { name: "x.txt", data: text("AAAA") }]);
    expect(other.byteLength).toBe(h.source.size);
    await put(h.memory, h.source.key, other);

    expect(await bodyOf(await h.open(), "x.txt")).toBe("AAAA");
    const reader = await h.open();
    expect(await bodyOf(reader, "y.txt")).toBe("BB");
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("not used (etag)"));
    h.reads.length = 0;
    await h.open();
    expect(h.indexReads()).toBe(0);
  });

  test("a page that fails its CRC-32", async () => {
    const h = await harness(writeZip(nested));
    const index = new Uint8Array(await new Response((await h.memory.get(h.source.index!))!.body).arrayBuffer());
    const original = await h.memory.head(h.source.key);
    const head = readHeader(index, { sourceSize: h.source.size, sourceEtag: original?.etag, objectSize: index.byteLength });
    if (!head.ok) throw new Error(head.reason);
    const fence = readFence(index, head.header, index.byteLength);
    if (!fence.ok) throw new Error(fence.reason);
    index[fence.fence.pages[2].offset + 9] ^= 0x01;
    await put(h.memory, h.source.index!, index);

    const reader = await h.open();
    expect(await bodyOf(reader, "root0.txt")).toBe("entry 0");
    expect(await allPaths(reader)).toEqual(nested.map((e) => e.name).sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b))));
    h.reads.length = 0;
    const next = await h.open();
    expect(await bodyOf(next, "root0.txt")).toBe("entry 0");
    expect(h.indexReads()).toBe(0);
    expect(h.distrusted()).toBe(true);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("CRC-32"));
  });
});
