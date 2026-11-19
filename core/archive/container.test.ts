import { describe, expect, test } from "vitest";
import { MemoryFileStorage } from "../../adapters/memory/storage";
import { writeZip } from "../../adapters/memory/zip";
import type { FileStorage } from "../asset/repository";
import { buildContainerIndex, createArchiveCache, openArchive, type ArchiveReader, type ArchiveSource } from "./index";

const big = (prefix = "") =>
  writeZip(Array.from({ length: 1000 }, (_, i) => ({ name: `${prefix}d${i % 10}/f${String(i).padStart(4, "0")}.txt`, data: new TextEncoder().encode(`${i}`), commentPadding: 1200 })));

async function stored(bytes: Uint8Array, filename = "a.zip") {
  const storage = new MemoryFileStorage();
  const source: ArchiveSource = { key: `assets/x/${filename}`, size: bytes.byteLength, filename };
  await storage.put(source.key, new Blob([bytes as BlobPart]).stream(), "application/zip", bytes.byteLength);
  return { storage, source, target: `assets/x/_archive/container.v1` };
}

async function listAll(storage: FileStorage, source: ArchiveSource): Promise<{ reader: ArchiveReader; paths: string[] }> {
  const opened = await openArchive({ storage, archives: createArchiveCache() }, source);
  if (!opened.ok) throw new Error(opened.reason);
  const paths: string[] = [];
  let after: string | undefined;
  do {
    const page = await opened.reader.list({ after, limit: 333 });
    paths.push(...page.entries.map((e) => e.path));
    after = page.next;
  } while (after !== undefined);
  return { reader: opened.reader, paths };
}

describe("buildContainerIndex", () => {
  test("writes an index that readers list exactly as the central directory does", async () => {
    const { storage, source, target } = await stored(big("site/"), "site.zip");
    const outcome = await buildContainerIndex(storage, source, target);
    expect(outcome).toMatchObject({ ok: true, index: target, rootPrefix: "site/" });
    if (!outcome.ok || !("index" in outcome)) throw new Error("no index");
    expect(outcome.directory.size).toBeGreaterThan(1 << 20);
    expect(outcome.directory.offset + outcome.directory.size).toBeLessThan(source.size);

    const fromIndex = await listAll(storage, { ...source, index: outcome.index });
    const fromDirectory = await listAll(storage, source);
    expect(fromIndex.paths).toHaveLength(1000);
    expect(fromIndex.paths).toEqual(fromDirectory.paths);
    expect(fromIndex.reader.rootPrefix).toBe("site/");

    const first = (await storage.get(target))!;
    await buildContainerIndex(storage, source, target);
    const again = (await storage.get(target))!;
    expect(again.etag).toBe(first.etag);
  });

  test("skips an archive whose central directory came with the tail read", async () => {
    const { storage, source, target } = await stored(writeZip([{ name: "site/a.txt", data: new Uint8Array(1) }]), "site.zip");
    const outcome = await buildContainerIndex(storage, source, target);
    expect(outcome).toMatchObject({ ok: true, skipped: "small", rootPrefix: "site/" });
    expect(await storage.head(target)).toBeNull();
  });

  test.each([
    ["entries", { maxEntries: 999, maxDirectoryBytes: 20 << 20 }],
    ["central directory bytes", { maxEntries: 100_000, maxDirectoryBytes: 1 << 20 }],
  ])("skips an archive over the limit on %s", async (_, limits) => {
    const { storage, source, target } = await stored(big("site/"), "site.zip");
    const outcome = await buildContainerIndex(storage, source, target, limits);
    expect(outcome).toMatchObject({ ok: true, skipped: "too-large", rootPrefix: "site/" });
    expect(await storage.head(target)).toBeNull();
  });

  test("refuses a file that is not a zip", async () => {
    const { storage, source, target } = await stored(new TextEncoder().encode("not an archive at all, just text"));
    expect(await buildContainerIndex(storage, source, target)).toEqual({ ok: false, reason: "not-zip" });
  });

  test("a failed put throws", async () => {
    const { storage, source, target } = await stored(big());
    const failing: FileStorage = {
      put: () => Promise.reject(new Error("bucket unavailable")),
      get: (k, r) => storage.get(k, r),
      head: (k) => storage.head(k),
      delete: (k) => storage.delete(k),
      list: (p, o) => storage.list(p, o),
    };
    await expect(buildContainerIndex(failing, source, target)).rejects.toThrow("bucket unavailable");
  });
});
