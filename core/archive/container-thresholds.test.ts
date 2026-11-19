import { describe, expect, test } from "vitest";
import { MemoryFileStorage } from "../../adapters/memory/storage";
import { writeZip } from "../../adapters/memory/zip";
import { buildContainerIndex, type ArchiveSource } from "./index";

const TARGET = "r/_archive/container.v1";
const CD_RECORD = 46;

async function outcome(zip: Uint8Array) {
  const storage = new MemoryFileStorage();
  const source: ArchiveSource = { key: "r/a.zip", size: zip.byteLength, filename: "a.zip" };
  await storage.put(source.key, new Blob([zip as BlobPart]).stream(), "application/zip", zip.byteLength);
  const built = await buildContainerIndex(storage, source, TARGET);
  if (!built.ok) throw new Error(built.reason);
  const stored = await storage.get(TARGET);
  return {
    result: "index" in built ? "index" : built.skipped,
    directorySize: built.directory.size,
    bytes: stored && new Uint8Array(await new Response(stored.body).arrayBuffer()),
    rebuild: () => buildContainerIndex(storage, source, TARGET).then(async () => new Uint8Array(await new Response((await storage.get(TARGET))!.body).arrayBuffer())),
  };
}

const names = (n: number, commentPadding = 0) => Array.from({ length: n }, (_, i) => ({ name: `f${String(i).padStart(6, "0")}`, data: new Uint8Array(0), commentPadding }));

/** 1,024 records of `perRecord` central directory bytes each, the first grown by `extra`. */
function directoryOf(perRecord: number, extra: number) {
  const list = names(1024, perRecord - CD_RECORD - "f000000".length);
  list[0].commentPadding += extra;
  return writeZip(list);
}

describe("container index thresholds", () => {
  test("100,000 entries are indexed, byte-identically on a rerun, and 100,001 are too large", async () => {
    const atLimit = await outcome(writeZip(names(100_000)));
    expect(atLimit.result).toBe("index");
    expect(await atLimit.rebuild()).toEqual(atLimit.bytes);
    expect((await outcome(writeZip(names(100_001)))).result).toBe("too-large");
  }, 120_000);

  test("a 20 MiB central directory is indexed and one byte more is too large", async () => {
    const limit = 20 * 1024 * 1024;
    expect(await outcome(directoryOf(20480, 0)).then((o) => [o.result, o.directorySize])).toEqual(["index", limit]);
    expect(await outcome(directoryOf(20480, 1)).then((o) => [o.result, o.directorySize])).toEqual(["too-large", limit + 1]);
  }, 120_000);

  test("a central directory that fits the last MiB with its end record is small", async () => {
    const fits = 1024 * 1024 - 22;
    expect(await outcome(directoryOf(1024, -22)).then((o) => [o.result, o.directorySize, o.bytes])).toEqual(["small", fits, null]);
    expect(await outcome(directoryOf(1024, -21)).then((o) => [o.result, o.directorySize])).toEqual(["index", fits + 1]);
  }, 120_000);
});
