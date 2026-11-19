import { readFileSync } from "node:fs";
import { describe, expect, test, vi } from "vitest";
import { ASSET_ID, VERSION_ID } from "../../../adapters/memory/fixture";
import { siteFixture } from "../../../adapters/memory/site-fixture";
import type { MemoryFileStorage } from "../../../adapters/memory/storage";

const FIXTURES = new URL("../../../scripts/fixtures/zip/data/", import.meta.url);
const zipBytes = (name: string) => new Uint8Array(readFileSync(new URL(name, FIXTURES)));
const golden = (name: string) =>
  (JSON.parse(readFileSync(new URL(name.replace(/\.zip$/, ".golden.json"), FIXTURES), "utf8")) as { entries: { path: string; size: number; crc32: string }[] }).entries;

async function put(storage: MemoryFileStorage, key: string, bytes: Uint8Array) {
  await storage.put(key, new Blob([bytes as BlobPart]).stream(), "application/zip", bytes.byteLength);
}

type Listed = Awaited<ReturnType<typeof siteFixture>>;

async function listing(f: Listed, query = "") {
  const res = await f.app.request(`/api/v1/assets/${ASSET_ID}/files${query}`, { headers: f.auth });
  expect(res.status).toBe(200);
  expect(res.headers.get("Content-Type")).toContain("application/x-ndjson");
  return (await res.text()).split("\n").filter(Boolean).map((line) => JSON.parse(line));
}

async function unextracted(name: string) {
  const f = await siteFixture();
  const bytes = zipBytes(name);
  const version = f.versions.versions.get(VERSION_ID)!;
  f.versions.versions.set(VERSION_ID, { ...version, filename: name, size: bytes.byteLength, status: "pending", archiveFormat: "zip" });
  await put(f.storage, `assets/${ASSET_ID}/v/${VERSION_ID}/${name}`, bytes);
  return f;
}

describe("GET /api/v1/assets/:id/files on a zip nobody extracted", () => {
  test("lists every entry from the original's central directory, with crc32 hashes", async () => {
    const f = await unextracted("deflate.zip");
    const expected = golden("deflate.zip").map((e) => expect.objectContaining({ path: e.path, size: e.size, hash: `crc32:${e.crc32}` }));
    expect(await listing(f)).toEqual(expected);
  });

  test("filters by prefix", async () => {
    const f = await unextracted("deflate.zip");
    expect((await listing(f, "?prefix=dir/sub/")).map((e) => e.path)).toEqual(["dir/sub/c.bin"]);
  });

  test("gives each entry the content type its extracted copy would get", async () => {
    const f = await unextracted("deflate.zip");
    expect(await listing(f, "?prefix=dir/b")).toEqual([expect.objectContaining({ contentType: "application/geo+json" })]);
  });

  test("lists the active version, not the first one", async () => {
    const f = await unextracted("deflate.zip");
    const v2 = "v2zipversion0001";
    const bytes = zipBytes("store.zip");
    f.versions.versions.set(v2, { ...f.versions.versions.get(VERSION_ID)!, id: v2, version: 2, filename: "store.zip", size: bytes.byteLength });
    await put(f.storage, `assets/${ASSET_ID}/v/${v2}/store.zip`, bytes);
    expect((await listing(f)).map((e) => e.path)).toEqual(golden("store.zip").map((e) => e.path));
  });

  test("answers an empty listing, and says why in the log, when the original is not a zip", async () => {
    const f = await unextracted("deflate.zip");
    await put(f.storage, `assets/${ASSET_ID}/v/${VERSION_ID}/deflate.zip`, new Uint8Array(zipBytes("deflate.zip").byteLength));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(await listing(f)).toEqual([]);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("(not-zip)"));
    warn.mockRestore();
  });
});

describe("GET /api/v1/assets/:id/files when the active version cannot be listed in place", () => {
  async function overFirstUpload(activeName: string, activeBytes: Uint8Array, archiveFormat: string) {
    const f = await unextracted("deflate.zip");
    const asset = f.metadata.assets.get(ASSET_ID)!;
    f.metadata.assets.set(ASSET_ID, { ...asset, filename: "store.zip", size: zipBytes("store.zip").byteLength, archiveFormat: "zip" });
    await put(f.storage, `assets/${ASSET_ID}/store.zip`, zipBytes("store.zip"));
    const version = f.versions.versions.get(VERSION_ID)!;
    f.versions.versions.set(VERSION_ID, { ...version, filename: activeName, size: activeBytes.byteLength, archiveFormat });
    await put(f.storage, `assets/${ASSET_ID}/v/${VERSION_ID}/${activeName}`, activeBytes);
    return f;
  }

  test("a corrupt zip lists nothing, not the first upload's files", async () => {
    const f = await overFirstUpload("broken.zip", new Uint8Array(400), "zip");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(await listing(f)).toEqual([]);
    warn.mockRestore();
  });

  test("a tar.gz with no manifest lists nothing, not the first upload's files", async () => {
    const f = await overFirstUpload("data.tar.gz", new Uint8Array(400), "tar.gz");
    expect(await listing(f)).toEqual([]);
  });

  test("a manifest the extractor wrote under the asset's own prefix still answers", async () => {
    const f = await overFirstUpload("data.tar.gz", new Uint8Array(400), "tar.gz");
    const manifest = '{"path":"x.txt","size":1,"contentType":"text/plain; charset=utf-8","hash":"md5:00112233445566778899aabbccddeeff"}\n';
    await f.storage.put(`assets/${ASSET_ID}/_archive/_manifest.jsonl`, new Blob([manifest]).stream(), "application/x-ndjson", manifest.length);
    expect((await listing(f)).map((e) => e.path)).toEqual(["x.txt"]);
  });
});

test("an extracted archive's manifest still answers first, byte for byte", async () => {
  const f = await unextracted("deflate.zip");
  const manifest = '{"path":"a.txt","size":6600,"contentType":"text/plain; charset=utf-8","hash":"md5:00112233445566778899aabbccddeeff"}\n';
  await f.storage.put(`assets/${ASSET_ID}/v/${VERSION_ID}/_archive/_manifest.jsonl`, new Blob([manifest]).stream(), "application/x-ndjson", manifest.length);
  const res = await f.app.request(`/api/v1/assets/${ASSET_ID}/files`, { headers: f.auth });
  expect(await res.text()).toBe(manifest);
});
