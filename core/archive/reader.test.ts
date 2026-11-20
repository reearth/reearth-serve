import { readdirSync, readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";
import { MemoryFileStorage } from "../../adapters/memory/storage";
import type { FileStorage } from "../asset/repository";
import { createArchiveCache, openArchive, toArchivePath, type ArchiveReader, type ArchiveSource } from "./index";
import { writeZip, type SyntheticEntry } from "./testing";

const FIXTURES = new URL("../../scripts/fixtures/zip/data/", import.meta.url);

interface Golden {
  archive: string;
  entries: { path: string; size: number; crc32: string }[];
}

function goldens(): Golden[] {
  return readdirSync(FIXTURES)
    .filter((f) => f.endsWith(".golden.json"))
    .map((f) => JSON.parse(readFileSync(new URL(f, FIXTURES), "utf8")) as Golden);
}

function counting(inner: FileStorage) {
  const reads: { offset?: number; length?: number }[] = [];
  const storage: FileStorage = {
    put: (...a) => inner.put(...a),
    head: (k) => inner.head(k),
    delete: (k) => inner.delete(k),
    list: (p, o) => inner.list(p, o),
    get: (key, range) => {
      reads.push({ ...range });
      return inner.get(key, range);
    },
  };
  return { storage, reads };
}

async function put(storage: FileStorage, key: string, bytes: Uint8Array, contentEncoding?: string) {
  await storage.put(key, new Blob([bytes as BlobPart]).stream(), "application/zip", bytes.byteLength, contentEncoding ? { contentEncoding } : undefined);
}

async function stored(bytes: Uint8Array, filename = "a.zip") {
  const memory = new MemoryFileStorage();
  const { storage, reads } = counting(memory);
  const source: ArchiveSource = { key: `assets/x/${filename}`, size: bytes.byteLength, filename };
  await put(storage, source.key, bytes);
  return { storage, reads, source, archives: createArchiveCache() };
}

async function open(deps: { storage: FileStorage; archives: ReturnType<typeof createArchiveCache> }, source: ArchiveSource): Promise<ArchiveReader> {
  const opened = await openArchive(deps, source);
  if (!opened.ok) throw new Error(`open refused: ${opened.reason}`);
  return opened.reader;
}

async function listAll(reader: ArchiveReader, limit: number, prefix?: string) {
  const out = [];
  let after: string | undefined;
  for (;;) {
    const page = await reader.list({ prefix, after, limit });
    out.push(...page.entries);
    if (page.next === undefined) return out;
    after = page.next;
  }
}

const hex = (n: number) => n.toString(16).padStart(8, "0");
const many = (n: number, name = (i: number) => `d${String(Math.floor(i / 1000)).padStart(3, "0")}/f${String(i).padStart(6, "0")}.txt`): SyntheticEntry[] =>
  Array.from({ length: n }, (_, i) => ({ name: name(i), data: new TextEncoder().encode(String(i)) }));

describe("openArchive lists every fixture as its golden list says", () => {
  test.each(goldens().map((g) => [g.archive, g] as const))("%s", async (archive, golden) => {
    const bytes = new Uint8Array(readFileSync(new URL(archive, FIXTURES)));
    const deps = await stored(bytes, archive);
    const reader = await open(deps, deps.source);
    const listed = (await listAll(reader, 2)).map((e) => ({ path: e.path, size: e.size, crc32: hex(e.crc32) }));
    expect(listed).toEqual(golden.entries);
  });

  test("a single root folder named after the archive is stripped and reported", async () => {
    const deps = await stored(new Uint8Array(readFileSync(new URL("site.zip", FIXTURES))), "site.zip");
    expect((await open(deps, deps.source)).rootPrefix).toBe("site/");
  });

  test("stat answers an entry's size, CRC-32 and content type, and null for a path no entry has", async () => {
    const deps = await stored(new Uint8Array(readFileSync(new URL("deflate.zip", FIXTURES))), "deflate.zip");
    const reader = await open(deps, deps.source);
    expect(await reader.stat(toArchivePath("dir/b.geojson")!)).toMatchObject({
      path: "dir/b.geojson",
      size: 42,
      contentType: "application/geo+json",
      readable: true,
    });
    expect(await reader.stat(toArchivePath("dir/missing.txt")!)).toBeNull();
  });
});

describe("listing semantics", () => {
  const names = ["a/1.txt", "a/b/2.txt", "a/b/3.txt", "a/c/4.txt", "a/z.txt", "b.txt", "c/5.txt"];

  test("delimiter rolls entries up into common prefixes, and `after` resumes past a returned prefix", async () => {
    const deps = await stored(writeZip(names.map((name) => ({ name, data: new Uint8Array(1) }))));
    const reader = await open(deps, deps.source);

    const pages = [];
    let after: string | undefined;
    do {
      const page = await reader.list({ prefix: "a/", delimiter: "/", after, limit: 2 });
      pages.push({ entries: page.entries.map((e) => e.path), prefixes: page.commonPrefixes, next: page.next });
      after = page.next;
    } while (after !== undefined);

    expect(pages).toEqual([
      { entries: ["a/1.txt"], prefixes: ["a/b/"], next: "a/b/" },
      { entries: ["a/z.txt"], prefixes: ["a/c/"], next: undefined },
    ]);
  });

  test("without a delimiter, `after` is an exclusive lower bound and the prefix filters", async () => {
    const deps = await stored(writeZip(names.map((name) => ({ name, data: new Uint8Array(1) }))));
    const reader = await open(deps, deps.source);
    const page = await reader.list({ after: "a/b/2.txt", limit: 3 });
    expect(page.entries.map((e) => e.path)).toEqual(["a/b/3.txt", "a/c/4.txt", "a/z.txt"]);
    expect(page.next).toBe("a/z.txt");
    expect((await listAll(reader, 10, "a/b/")).map((e) => e.path)).toEqual(["a/b/2.txt", "a/b/3.txt"]);
  });

  test("order is UTF-8 byte order, the order ListObjectsV2 promises", async () => {
    const deps = await stored(writeZip(["\u{1F600}.txt", "Ａ.txt", "Z.txt", "a.txt"].map((name) => ({ name, data: new Uint8Array(1) }))));
    const reader = await open(deps, deps.source);
    expect((await listAll(reader, 10)).map((e) => e.path)).toEqual(["Z.txt", "a.txt", "Ａ.txt", "\u{1F600}.txt"]);
  });
});

describe("storage reads", () => {
  test("a Zip64 archive of 70,000 entries lists every entry in two cold reads and none warm", async () => {
    const deps = await stored(writeZip(many(70_000)));
    const reader = await open(deps, deps.source);
    expect(deps.reads).toHaveLength(2);
    expect(reader.entryCount).toBe(70_000);

    const entries = await listAll(reader, 10_000);
    expect(entries).toHaveLength(70_000);
    expect(entries[entries.length - 1].path).toBe("d069/f069999.txt");

    deps.reads.length = 0;
    await listAll(await open(deps, deps.source), 10_000);
    expect(deps.reads).toHaveLength(0);
  });

  test("concurrent cold opens of one archive share a single central directory read", async () => {
    const deps = await stored(writeZip(many(10)));
    await Promise.all([open(deps, deps.source), open(deps, deps.source), open(deps, deps.source)]);
    expect(deps.reads).toHaveLength(1);
  });

  test("a central directory above 32 MiB is streamed per query instead of held, and still lists exactly", async () => {
    const entries = many(520).map((e) => ({ ...e, commentPadding: 0xffff }));
    const deps = await stored(writeZip(entries));
    const reader = await open(deps, deps.source);
    deps.reads.length = 0;

    const listed = await listAll(reader, 1000);
    expect(listed.map((e) => e.path)).toEqual(entries.map((e) => e.name));
    expect(deps.reads.length).toBeGreaterThan(0);
  });
});

describe("staleness", () => {
  test("a new size for the same key opens the new archive, not the cached one", async () => {
    const deps = await stored(writeZip(many(3)));
    expect(await listAll(await open(deps, deps.source), 10)).toHaveLength(3);

    const bigger = writeZip(many(5));
    await put(deps.storage, deps.source.key, bigger);
    expect(await listAll(await open(deps, { ...deps.source, size: bigger.byteLength }), 10)).toHaveLength(5);
  });

  test("a streamed central directory that changed under the same size evicts the cache, and the next open sees the new entries", async () => {
    const before = many(520, (i) => `old/${String(i).padStart(6, "0")}`).map((e) => ({ ...e, commentPadding: 0xffff }));
    const after = many(520, (i) => `new/${String(i).padStart(6, "0")}`).map((e) => ({ ...e, commentPadding: 0xffff }));
    const deps = await stored(writeZip(before));
    const reader = await open(deps, deps.source);

    await put(deps.storage, deps.source.key, writeZip(after));
    await expect(reader.list({ limit: 1 })).rejects.toThrow(/changed/);

    const page = await (await open(deps, deps.source)).list({ limit: 1 });
    expect(page.entries.map((e) => e.path)).toEqual(["new/000000"]);
  });
});

describe("refusals", () => {
  test.each([
    ["not-zip", () => new TextEncoder().encode("this is a text file named .zip, not an archive")],
    ["not-zip", () => writeZip(many(3)).slice(0, -10)],
    ["multi-disk", () => {
      const bytes = writeZip(many(3));
      new DataView(bytes.buffer).setUint16(bytes.byteLength - 22 + 4, 1, true);
      return bytes;
    }],
    ["corrupt", () => {
      const bytes = writeZip(many(3));
      const view = new DataView(bytes.buffer);
      view.setUint32(bytes.byteLength - 22 + 12, view.getUint32(bytes.byteLength - 22 + 12, true) - 1, true);
      return bytes;
    }],
  ])("%s", async (reason, make) => {
    const deps = await stored(make());
    expect(await openArchive(deps, deps.source)).toEqual({ ok: false, reason });
  });

  test("missing original", async () => {
    const deps = await stored(writeZip(many(1)));
    expect(await openArchive(deps, { ...deps.source, key: "assets/x/gone.zip" })).toEqual({ ok: false, reason: "missing" });
  });

  test("an original stored with a content encoding", async () => {
    const memory = new MemoryFileStorage();
    const bytes = writeZip(many(1));
    await put(memory, "k.zip", bytes, "gzip");
    expect(await openArchive({ storage: memory, archives: createArchiveCache() }, { key: "k.zip", size: bytes.byteLength, filename: "k.zip" }))
      .toEqual({ ok: false, reason: "encoded-original" });
  });

  test("a refusal is not cached: the archive opens once its bytes exist", async () => {
    const deps = await stored(writeZip(many(1)));
    const later = { ...deps.source, key: "assets/x/later.zip" };
    expect(await openArchive(deps, later)).toEqual({ ok: false, reason: "missing" });
    await put(deps.storage, later.key, writeZip(many(1)));
    expect((await openArchive(deps, later)).ok).toBe(true);
  });
});

test("toArchivePath accepts only paths an entry can carry", () => {
  expect(toArchivePath("a/b.txt")).toBe("a/b.txt");
  for (const bad of ["", "/a", "a/", "a//b", "./a", "a/../b", "a\\b"]) expect(toArchivePath(bad)).toBeNull();
});
