import { deflateRawSync } from "node:zlib";
import { describe, expect, test, vi } from "vitest";
import { ASSET_ID, fixture, protect, VERSION_ID } from "../../adapters/memory/fixture";
import { writeZip, type SyntheticEntry } from "../../adapters/memory/zip";

const ZIP = "site.zip";
const ORIGINAL = `assets/${ASSET_ID}/v/${VERSION_ID}/${ZIP}`;
const text = (s: string) => new TextEncoder().encode(s);
const DEFLATED = "deflated geojson ".repeat(200);
const STORED = new Uint8Array(4000).map((_, i) => (i * 7) & 0xff);

function deflated(name: string, data: string): SyntheticEntry {
  const bytes = text(data);
  return { name, data: bytes, method: 8, compressed: new Uint8Array(deflateRawSync(bytes)) };
}

const SITE: SyntheticEntry[] = [
  { name: "index.html", data: text("<!doctype html><title>in place</title>") },
  { name: "404.html", data: text("<!doctype html><title>gone</title>") },
  { name: "docs/index.html", data: text("<!doctype html><title>docs</title>") },
  deflated("dir/a.geojson", DEFLATED),
  { name: "tile.bin", data: STORED },
  { name: "secret.txt", data: text("x"), flags: 1 },
  { name: "b.bz2", data: text("y"), method: 12, compressed: text("BZh") },
];

type Status = "pending" | "ready" | "failed" | undefined;

function arrived(entries: SyntheticEntry[] = SITE, status: Status = "pending") {
  return arrivedBytes(writeZip(entries), status);
}

async function arrivedBytes(bytes: Uint8Array, status: Status = "pending") {
  const f = await fixture();
  const version = f.versions.versions.get(VERSION_ID)!;
  f.versions.versions.set(VERSION_ID, { ...version, size: bytes.byteLength, status, archiveFormat: "zip" });
  await f.storage.delete(ORIGINAL);
  await f.storage.put(ORIGINAL, new Blob([bytes as BlobPart]).stream(), "application/zip", bytes.byteLength);
  const replace = async (next: Uint8Array) => {
    await f.storage.put(ORIGINAL, new Blob([next as BlobPart]).stream(), "application/zip", next.byteLength);
  };
  const get = (path: string, headers?: Record<string, string>) => f.app.request(`/files/${ASSET_ID}/${path}`, { headers });
  return { ...f, bytes, get, replace };
}

async function gunzip(res: Response): Promise<string> {
  const body = await res.arrayBuffer();
  return new Response(new Blob([body]).stream().pipeThrough(new DecompressionStream("gzip"))).text();
}

describe("serving a zip entry in place, before extraction", () => {
  test("a stored entry comes back with its length", async () => {
    const f = await arrived();
    const res = await f.get("index.html");
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("text/html; charset=utf-8");
    expect(res.headers.get("Content-Length")).toBe(String(SITE[0].data.byteLength));
    expect(await res.text()).toBe("<!doctype html><title>in place</title>");
  });

  test("a deflate entry is passed through as one gzip member to a client that accepts gzip", async () => {
    const f = await arrived();
    const res = await f.get("dir/a.geojson", { "Accept-Encoding": "gzip" });
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Encoding")).toBe("gzip");
    expect(res.headers.get("Vary")).toBe("Accept-Encoding");
    expect(await gunzip(res)).toBe(DEFLATED);
  });

  test("a deflate entry is decoded for a client without gzip, with the entry's size", async () => {
    const f = await arrived();
    const res = await f.get("dir/a.geojson");
    expect(res.headers.get("Content-Encoding")).toBeNull();
    expect(res.headers.get("Content-Length")).toBe(String(DEFLATED.length));
    expect(res.headers.get("ETag")).toMatch(/^W\//);
    expect(await res.text()).toBe(DEFLATED);
  });

  test("a Range on a stored entry is 206 with exactly those bytes, from one storage read when warm", async () => {
    const f = await arrived();
    await f.get("tile.bin");
    const get = vi.spyOn(f.storage, "get");
    const res = await f.get("tile.bin", { Range: "bytes=1000-1999" });
    expect(res.status).toBe(206);
    expect(res.headers.get("Content-Range")).toBe("bytes 1000-1999/4000");
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(STORED.subarray(1000, 2000));
    expect(get.mock.calls.filter(([key]) => key === ORIGINAL)).toHaveLength(1);
  });

  test("a Range on a deflate entry is 206 with the decoded bytes", async () => {
    const f = await arrived();
    const res = await f.get("dir/a.geojson", { Range: "bytes=10-29", "Accept-Encoding": "gzip" });
    expect(res.status).toBe(206);
    expect(res.headers.get("Content-Encoding")).toBeNull();
    expect(res.headers.get("Content-Range")).toBe(`bytes 10-29/${DEFLATED.length}`);
    expect(await res.text()).toBe(DEFLATED.slice(10, 30));
  });

  test("If-None-Match with the returned ETag is 304 with no body", async () => {
    const f = await arrived();
    const etag = (await f.get("tile.bin")).headers.get("ETag")!;
    const res = await f.get("tile.bin", { "If-None-Match": etag });
    expect(res.status).toBe(304);
    expect(await res.text()).toBe("");
  });

  test("an encrypted entry and an unsupported method answer 501", async () => {
    const f = await arrived();
    expect((await f.get("secret.txt")).status).toBe(501);
    expect((await f.get("b.bz2")).status).toBe(501);
  });

  test("a local header that contradicts the central directory answers 502", async () => {
    const entries = [{ name: "a.txt", data: text("x") }];
    const f = await arrived(entries);
    const broken = f.bytes.slice();
    broken[30] = "b".charCodeAt(0);
    await f.replace(broken);
    expect((await f.get("a.txt")).status).toBe(502);
  });

  test("an original replaced after its directory was cached is re-read and served", async () => {
    const f = await arrived([{ name: "a.txt", data: text("aaaa") }, { name: "b.txt", data: text("bb") }]);
    expect(await (await f.get("b.txt")).text()).toBe("bb");
    await f.replace(writeZip([{ name: "b.txt", data: text("BB") }, { name: "a.txt", data: text("AAAA") }]));
    const res = await f.get("b.txt");
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("BB");
  });

  test("the directory index, the redirect probe and 404.html come from the central directory", async () => {
    const f = await arrived();
    expect(await (await f.app.request(`/files/${ASSET_ID}/`)).text()).toBe("<!doctype html><title>in place</title>");
    expect(await (await f.get("docs/")).text()).toBe("<!doctype html><title>docs</title>");
    const redirect = await f.app.request(`http://localhost/files/${ASSET_ID}/docs`);
    expect(redirect.status).toBe(301);
    expect(redirect.headers.get("Location")).toBe(`http://localhost/files/${ASSET_ID}/docs/`);
    const missing = await f.get("nope.js");
    expect(missing.status).toBe(404);
    expect(await missing.text()).toBe("<!doctype html><title>gone</title>");
  });

  test("the SPA fallback serves the in-place index.html", async () => {
    const f = await arrived();
    f.metadata.assets.set(ASSET_ID, { ...f.metadata.assets.get(ASSET_ID)!, spa: true });
    const res = await f.get("map/harbor");
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("<!doctype html><title>in place</title>");
  });

  test("_headers and _redirects apply from the original and are never served", async () => {
    const f = await arrived([
      ...SITE,
      { name: "_headers", data: text("/index.html\n  X-From-Zip: yes\n") },
      { name: "_redirects", data: text("/old /index.html 301\n") },
    ]);
    expect((await f.get("index.html")).headers.get("X-From-Zip")).toBe("yes");
    expect((await f.get("old")).status).toBe(301);
    expect((await f.get("_headers")).status).toBe(404);
  });

  test("_headers still apply on the first request after the original is rewritten", async () => {
    const headers = { name: "_headers", data: text("/index.html\n  X-From-Zip: yes\n") };
    const f = await arrived([{ name: "index.html", data: text("one") }, headers]);
    expect((await f.get("index.html")).headers.get("X-From-Zip")).toBe("yes");
    await f.replace(writeZip([{ name: "index.html", data: text("two") }, headers]));
    const res = await f.get("index.html");
    expect(await res.text()).toBe("two");
    expect(res.headers.get("X-From-Zip")).toBe("yes");
  });

  test("a protected asset is challenged before the original is read", async () => {
    const f = await arrived();
    await protect(f.metadata, ASSET_ID, "hunter2");
    const get = vi.spyOn(f.storage, "get");
    expect((await f.get("index.html")).status).toBe(401);
    expect(get).not.toHaveBeenCalled();
    const ok = await f.get("index.html", { Authorization: `Basic ${btoa("x:hunter2")}` });
    expect(ok.status).toBe(200);
  });
});

describe("a zip uploaded with extraction skipped", () => {
  test("is read in place, rules included, without probing an extracted tree first", async () => {
    const f = await arrived([...SITE, { name: "_headers", data: text("/index.html\n  X-From-Zip: yes\n") }], undefined);
    await f.get("index.html");
    const get = vi.spyOn(f.storage, "get");
    const res = await f.get("index.html");
    expect(res.headers.get("X-From-Zip")).toBe("yes");
    expect(get.mock.calls.map(([key]) => key)).toEqual([ORIGINAL, ORIGINAL]);
  });
});

describe("an archive that finished extraction", () => {
  test("serves the extracted object, not the in-place entry", async () => {
    const f = await arrived([{ name: "index.html", data: text("from the original") }], "ready");
    const res = await f.get("index.html");
    expect(await res.text()).not.toBe("from the original");
    expect(res.headers.get("ETag")).toMatch(/^"[0-9a-f]{32}"$/);
  });

  test("answers 404 for an entry the extractor did not write, without reading the original", async () => {
    const f = await arrived(SITE, "ready");
    const get = vi.spyOn(f.storage, "get");
    for (const path of ["secret.txt", "b.bz2", "tile.bin", "nope.js"]) {
      expect((await f.get(path)).status, path).toBe(404);
    }
    expect(get.mock.calls.filter(([key]) => key === ORIGINAL)).toEqual([]);
  });
});

describe("a failed extraction", () => {
  test("still serves entries in place", async () => {
    const f = await arrived(SITE, "failed");
    expect(await (await f.get("index.html")).text()).toBe("<!doctype html><title>in place</title>");
  });
});

describe("an entry whose central directory claims do not fit the original", () => {
  const CD_SIGNATURE = 0x02014b50;
  const PLAIN = text("hello, hostile zip!");

  function patchCompressedSize(bytes: Uint8Array, compressedSize: number): Uint8Array {
    const out = bytes.slice();
    const view = new DataView(out.buffer);
    for (let i = 0; i + 4 <= out.byteLength; i++) {
      if (view.getUint32(i, true) === CD_SIGNATURE) {
        view.setUint32(i + 20, compressedSize, true);
        return out;
      }
    }
    throw new Error("no central directory record");
  }

  test.each([
    ["a stored entry claiming 20 bytes more than it has", [{ name: "a.txt", data: PLAIN }], PLAIN.byteLength + 20],
    ["a stored entry claiming 5 bytes fewer than it has", [{ name: "a.txt", data: PLAIN }], PLAIN.byteLength - 5],
    ["a deflate entry claiming data past the end of the file", [deflated("a.txt", "abc ".repeat(40))], 0x10000],
  ])("%s answers 502 before any body", async (_, entries, compressedSize) => {
    const f = await arrivedBytes(patchCompressedSize(writeZip(entries), compressedSize));
    const res = await f.get("a.txt", { "Accept-Encoding": "gzip" });
    expect(res.status).toBe(502);
    expect(res.headers.get("Content-Type")).toMatch(/^application\/json/);
    expect(await res.json()).toEqual({ error: expect.any(String) });
  });
});

describe("a Range an in-place entry cannot satisfy", () => {
  const BIG = new Uint8Array(3 << 20).map((_, i) => (i * 13) & 0xff);

  test.each([
    ["starts at the end", `bytes=${BIG.byteLength}-`],
    ["starts past the end", `bytes=${BIG.byteLength + 10}-${BIG.byteLength + 20}`],
    ["ends before it starts", "bytes=2000000-100"],
  ])("%s answers 416 with the entry size, never reading the entry or rebuilding the directory", async (_, range) => {
    const f = await arrived([{ name: "big.bin", data: BIG }]);
    await (await f.get("big.bin", { Range: "bytes=0-9" })).arrayBuffer();
    const get = vi.spyOn(f.storage, "get");
    for (let i = 0; i < 3; i++) {
      const res = await f.get("big.bin", { Range: range });
      expect(res.status).toBe(416);
      expect(res.headers.get("Content-Range")).toBe(`bytes */${BIG.byteLength}`);
    }
    expect(get).not.toHaveBeenCalled();
    const ok = await f.get("big.bin", { Range: "bytes=0-9" });
    expect(new Uint8Array(await ok.arrayBuffer())).toEqual(BIG.subarray(0, 10));
    expect(get.mock.calls).toHaveLength(1);
  });

  test("a deflate entry answers 416 past its decoded size", async () => {
    const f = await arrived();
    const res = await f.get("dir/a.geojson", { Range: `bytes=${DEFLATED.length}-` });
    expect(res.status).toBe(416);
    expect(res.headers.get("Content-Range")).toBe(`bytes */${DEFLATED.length}`);
  });
});
