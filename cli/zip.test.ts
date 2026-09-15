/**
 * The stored-zip writer behind `upload <dir>` (ADR-013 C2).
 *
 * Every test is a round trip: write a real directory to a real file, then parse
 * it back by walking the central directory the way a reader does — including
 * the Go extractor that will open it on the server. Checking CRCs and the
 * stored method through that path is what makes "it produced a zip" mean
 * something.
 */
import { describe, expect, test } from "vitest";
import { mkdtemp, mkdir, readFile, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { crc32, collectDirectory, writeStoredZip, zipDirectory, ZIP32_MAX_ENTRIES } from "./zip";

interface ParsedEntry {
  name: string;
  method: number;
  crc: number;
  size: number;
  data: Buffer;
}

/**
 * The inverse of the writer: find the end-of-central-directory record, walk the
 * central directory, and follow each entry's offset to its local header and
 * bytes. Deliberately independent of the writer's own constants.
 */
function readStoredZip(buf: Buffer): ParsedEntry[] {
  let eocd = -1;
  for (let i = buf.length - 22; i >= 0; i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd === -1) throw new Error("no end-of-central-directory record");

  const count = buf.readUInt16LE(eocd + 10);
  const centralSize = buf.readUInt32LE(eocd + 12);
  let pos = buf.readUInt32LE(eocd + 16);
  expect(pos + centralSize).toBe(eocd);

  const entries: ParsedEntry[] = [];
  for (let i = 0; i < count; i++) {
    expect(buf.readUInt32LE(pos)).toBe(0x02014b50);
    const method = buf.readUInt16LE(pos + 10);
    const crc = buf.readUInt32LE(pos + 16);
    const compressed = buf.readUInt32LE(pos + 20);
    const size = buf.readUInt32LE(pos + 24);
    const nameLen = buf.readUInt16LE(pos + 28);
    const extraLen = buf.readUInt16LE(pos + 30);
    const commentLen = buf.readUInt16LE(pos + 32);
    const offset = buf.readUInt32LE(pos + 42);
    const name = buf.subarray(pos + 46, pos + 46 + nameLen).toString("utf8");
    // Stored means the two sizes agree; nothing downstream should have to guess.
    expect(compressed).toBe(size);

    expect(buf.readUInt32LE(offset)).toBe(0x04034b50);
    const localNameLen = buf.readUInt16LE(offset + 26);
    const localExtraLen = buf.readUInt16LE(offset + 28);
    expect(buf.readUInt32LE(offset + 14)).toBe(crc);
    expect(buf.subarray(offset + 30, offset + 30 + localNameLen).toString("utf8")).toBe(name);
    const start = offset + 30 + localNameLen + localExtraLen;

    entries.push({ name, method, crc, size, data: buf.subarray(start, start + size) });
    pos += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}

/** A directory with the given contents, under a fresh temp root. */
async function sampleDir(files: Record<string, string>): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "serve-zip-test-"));
  for (const [path, content] of Object.entries(files)) {
    const full = join(root, path);
    await mkdir(join(full, ".."), { recursive: true });
    await writeFile(full, content);
  }
  return root;
}

async function zipOf(files: Record<string, string>): Promise<ParsedEntry[]> {
  const root = await sampleDir(files);
  const dest = join(await mkdtemp(join(tmpdir(), "serve-zip-out-")), "site.zip");
  await zipDirectory(root, dest);
  return readStoredZip(await readFile(dest));
}

describe("crc32", () => {
  test("it matches the known values, seeded and unseeded", () => {
    const check = new TextEncoder().encode("123456789");
    expect(crc32(check)).toBe(0xcbf43926);
    expect(crc32(new Uint8Array())).toBe(0);
    // Seeding is what lets a file be hashed chunk by chunk.
    const data = new TextEncoder().encode("hello, world");
    expect(crc32(data.subarray(5), crc32(data.subarray(0, 5)))).toBe(crc32(data));
  });
});

describe("round trip", () => {
  test("paths, contents, CRCs and the stored method all survive", async () => {
    const files = {
      "index.html": "<!doctype html><title>site</title>",
      "assets/app.js": "console.log('hi')",
      "data/cities.json": JSON.stringify({ cities: ["kawasaki"] }),
    };
    const entries = await zipOf(files);

    expect(entries.map((e) => e.name).sort()).toEqual(Object.keys(files).sort());
    for (const entry of entries) {
      const expected = files[entry.name as keyof typeof files];
      expect(entry.method).toBe(0); // stored, never deflated
      expect(entry.data.toString("utf8")).toBe(expected);
      expect(entry.size).toBe(Buffer.byteLength(expected));
      expect(entry.crc).toBe(crc32(new Uint8Array(entry.data)));
    }
  });

  test("nested paths use forward slashes at every depth", async () => {
    const entries = await zipOf({ "a/b/c/deep.txt": "deep" });
    expect(entries[0].name).toBe("a/b/c/deep.txt");
    expect(entries[0].name).not.toContain("\\");
  });

  test("non-ASCII names and empty files are fine", async () => {
    const entries = await zipOf({ "データ/川崎.txt": "", "ok.txt": "x" });
    const names = entries.map((e) => e.name).sort();
    expect(names).toEqual(["ok.txt", "データ/川崎.txt"]);
    const empty = entries.find((e) => e.name === "データ/川崎.txt")!;
    expect(empty.size).toBe(0);
    expect(empty.crc).toBe(0);
  });

  test("binary content is not mangled", async () => {
    const root = await mkdtemp(join(tmpdir(), "serve-zip-test-"));
    const bytes = Buffer.from(Array.from({ length: 512 }, (_, i) => i % 256));
    await writeFile(join(root, "blob.bin"), bytes);
    const dest = join(await mkdtemp(join(tmpdir(), "serve-zip-out-")), "site.zip");
    await zipDirectory(root, dest);
    const [entry] = readStoredZip(await readFile(dest));
    expect(Buffer.compare(entry.data, bytes)).toBe(0);
  });

  test("the same directory always produces the same bytes", async () => {
    const root = await sampleDir({ "b.txt": "b", "a.txt": "a", "d/c.txt": "c" });
    const outDir = await mkdtemp(join(tmpdir(), "serve-zip-out-"));
    await zipDirectory(root, join(outDir, "one.zip"));
    await zipDirectory(root, join(outDir, "two.zip"));
    expect(Buffer.compare(
      await readFile(join(outDir, "one.zip")),
      await readFile(join(outDir, "two.zip")),
    )).toBe(0);
  });
});

describe("what is left out", () => {
  test("editor droppings, the repository and node_modules are skipped", async () => {
    const entries = await zipOf({
      "index.html": "x",
      ".DS_Store": "junk",
      "assets/.DS_Store": "junk",
      "assets/Thumbs.db": "junk",
      ".git/config": "junk",
      "node_modules/pkg/index.js": "junk",
    });
    expect(entries.map((e) => e.name)).toEqual(["index.html"]);
  });

  test("symbolic links are skipped and reported", async () => {
    const root = await sampleDir({ "index.html": "x", "real/data.json": "{}" });
    await symlink(join(root, "real"), join(root, "link"));
    await symlink(join(root, "index.html"), join(root, "copy.html"));

    const collected = await collectDirectory(root);
    expect(collected.entries.map((e) => e.name).sort()).toEqual(["index.html", "real/data.json"]);
    expect(collected.skippedSymlinks.sort()).toEqual(["copy.html", "link"]);

    const dest = join(await mkdtemp(join(tmpdir(), "serve-zip-out-")), "site.zip");
    const summary = await zipDirectory(root, dest);
    expect(summary.skippedSymlinks.sort()).toEqual(["copy.html", "link"]);
    expect(summary.entries).toBe(2);
  });

  test("empty directories contribute nothing", async () => {
    const root = await sampleDir({ "index.html": "x" });
    await mkdir(join(root, "empty/deeper"), { recursive: true });
    const collected = await collectDirectory(root);
    expect(collected.entries.map((e) => e.name)).toEqual(["index.html"]);
  });

  test("a directory with nothing in it is an error, not an empty upload", async () => {
    const root = await mkdtemp(join(tmpdir(), "serve-zip-test-"));
    const dest = join(await mkdtemp(join(tmpdir(), "serve-zip-out-")), "site.zip");
    await expect(zipDirectory(root, dest)).rejects.toThrow(/no files to upload/);
  });
});

describe("ZIP64 is refused, not attempted", () => {
  test("too many entries", async () => {
    const entries = Array.from({ length: ZIP32_MAX_ENTRIES + 1 }, (_, i) => ({
      name: `f${i}.txt`, file: "/dev/null", size: 0,
    }));
    await expect(writeStoredZip(entries, "/dev/null"))
      .rejects.toThrow(/Zip it yourself and upload the zip/);
  });

  test("more than 4 GiB", async () => {
    // Declared sizes only: the guard runs before a byte is read.
    const entries = [
      { name: "a.bin", file: "/dev/null", size: 3_000_000_000 },
      { name: "b.bin", file: "/dev/null", size: 2_000_000_000 },
    ];
    await expect(writeStoredZip(entries, "/dev/null"))
      .rejects.toThrow(/larger than 4 GiB/);
  });
});
