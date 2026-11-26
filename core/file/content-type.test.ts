import { describe, expect, test } from "vitest";
import { ASSET_ID, fixture, MemoryVersionStore, seedEntry, SINGLE_FILE_ID, VERSION_ID } from "../../adapters/memory/fixture";
import { PROJECT_ID, siteFixture, SUFFIX } from "../../adapters/memory/site-fixture";
import type { AssetMetadata, AssetVersion } from "../asset/model";
import type { AtomicWrites } from "../asset/repository";
import { createApp } from "../app";

const SANDBOXED = { type: "application/octet-stream", disposition: /^attachment; /, csp: "sandbox" };

const cases: Array<[name: string, stored: string | undefined, sent: string, inline: boolean]> = [
  ["comma inside a parameter", "text/plain;x=,text/html", SANDBOXED.type, false],
  ["unterminated quoted parameter", 'application/json;a=",text/html', SANDBOXED.type, false],
  ["two types in a list", "text/plain, text/html", SANDBOXED.type, false],
  ["empty parameter before a comma", "image/png;,text/html", SANDBOXED.type, false],
  ["bare comma list", "text/plain,text/html", SANDBOXED.type, false],
  ["lone comma", ",", SANDBOXED.type, false],
  ["wildcard essence", "*/*; charset=utf-8", SANDBOXED.type, false],
  ["uppercase active type", "TEXT/HTML", "text/html", false],
  ["padded inline type", " \ttext/plain\t ", "text/plain", true],
  ["active type with charset", "text/html;charset=utf-8", "text/html; charset=utf-8", false],
  ["inline type with extra parameters", 'text/plain; charset="UTF-8"; format=flowed', "text/plain; charset=utf-8", true],
  ["empty", "", SANDBOXED.type, false],
  ["missing", undefined, SANDBOXED.type, false],
  ["CR LF", "text/plain\r\nX-Injected: 1", SANDBOXED.type, false],
  ["NUL", "text/plain\0text/html", SANDBOXED.type, false],
];

function expectServedAs(res: Response, sent: string, inline: boolean, name: string) {
  expect(res.status, name).toBe(200);
  expect(res.headers.get("Content-Type"), name).toBe(sent);
  if (inline) {
    expect(res.headers.get("Content-Disposition"), name).toMatch(/^inline; /);
    expect(res.headers.get("Content-Security-Policy"), name).toBeNull();
  } else {
    expect(res.headers.get("Content-Disposition"), name).toMatch(SANDBOXED.disposition);
    expect(res.headers.get("Content-Security-Policy"), name).toBe(SANDBOXED.csp);
  }
}

describe("apex delivery of a stored Content-Type (ADR-013 A4)", () => {
  test.each(cases)("single-file asset whose metadata says %s", async (name, stored, sent, inline) => {
    const { app, metadata } = await fixture();
    const asset = metadata.assets.get(SINGLE_FILE_ID)!;
    metadata.assets.set(SINGLE_FILE_ID, { ...asset, contentType: stored as string });
    expectServedAs(await app.request(`/files/${SINGLE_FILE_ID}/data.geojson`), sent, inline, name);
  });

  test.each(cases)("archive entry whose stored object says %s", async (name, stored, sent, inline) => {
    const { app, storage } = await fixture();
    const body = "<script>parent.x=1</script>";
    await storage.put(`assets/${ASSET_ID}/v/${VERSION_ID}/files/entry.bin`, new Blob([body]).stream(), stored as string, body.length);
    expectServedAs(await app.request(`/files/${ASSET_ID}/entry.bin`), sent, inline, name);
  });

  test("a site host keeps HTML inline but sends the normalized type", async () => {
    const { app, storage } = await siteFixture();
    const host = `${ASSET_ID}${SUFFIX}`;
    await seedEntry(storage, "page.html", "<p>hi</p>", "TEXT/HTML; Charset=UTF-8; x=y");
    await seedEntry(storage, "list.txt", "hi", "text/plain;x=,text/html");
    const page = await app.request(`http://${host}/page.html`, { headers: { Host: host } });
    expect(page.headers.get("Content-Type")).toBe("text/html; charset=utf-8");
    expect(page.headers.get("Content-Disposition")).toMatch(/^inline; /);
    const list = await app.request(`http://${host}/list.txt`, { headers: { Host: host } });
    expect(list.headers.get("Content-Type")).toBe("application/octet-stream");
  });
});

describe("uploading a Content-Type through the API", () => {
  async function uploadFixture() {
    const f = await fixture({ anonymousUploadEnabled: true });
    const writes: AtomicWrites = {
      ...f.deps.writes,
      async createAsset({ asset }: { asset: AssetMetadata }) { f.metadata.assets.set(asset.id, asset); },
    } as AtomicWrites;
    f.deps.writes = writes;
    return { ...f, app: createApp(f.deps) };
  }

  const uploads: Array<[name: string, header: string | undefined, stored: string]> = [
    ["comma inside a parameter", "text/plain;x=,text/html", "application/octet-stream"],
    ["unterminated quoted parameter", 'application/json;a=",text/html', "application/octet-stream"],
    ["two types in a list", "text/plain, text/html", "application/octet-stream"],
    ["empty parameter before a comma", "image/png;,text/html", "application/octet-stream"],
    ["bare comma list", "text/plain,text/html", "application/octet-stream"],
    ["lone comma", ",", "application/octet-stream"],
    ["uppercase", "TEXT/PLAIN", "text/plain"],
    ["charset kept, other parameters dropped", "text/plain; charset=UTF-8; x=y", "text/plain; charset=utf-8"],
    ["missing", undefined, "application/octet-stream"],
  ];

  test.each(uploads)("POST /api/v1/assets with %s", async (name, header, stored) => {
    const { app } = await uploadFixture();
    const body = "<script>parent.x=1</script>";
    const res = await app.request("/api/v1/assets", {
      method: "POST",
      headers: {
        "X-Filename": "data.geojson",
        "Content-Length": String(body.length),
        ...(header === undefined ? {} : { "Content-Type": header }),
      },
      body: header === undefined ? new Blob([body]).stream() : body,
      ...(header === undefined ? { duplex: "half" } : {}),
    } as RequestInit);
    expect(res.status, name).toBe(201);
    const { asset } = await res.json() as { asset: AssetMetadata };
    expect(asset.contentType, name).toBe(stored);

    const served = await app.request(`/files/${asset.id}/data.geojson`);
    expect(served.headers.get("Content-Type"), name).toBe(stored);
    expect(served.headers.get("Content-Disposition"), name).toMatch(/^inline; /);
  });
});

describe("uploading a version's Content-Type through the API", () => {
  test.each([
    ["text/plain;x=,text/html", "application/octet-stream"],
    ["Image/PNG; x=y", "image/png"],
  ])("POST /api/v1/assets/:id with %s", async (header, stored) => {
    const holder: { versions?: MemoryVersionStore } = {};
    const f = await siteFixture({
      deps: {
        writes: {
          async createVersion({ version }: { version: AssetVersion }) { return holder.versions!.save(version); },
        } as unknown as AtomicWrites,
      },
    });
    holder.versions = f.versions;
    const body = "<script>parent.x=1</script>";
    const res = await f.app.request(`/api/v1/assets/${SINGLE_FILE_ID}`, {
      method: "POST",
      headers: { ...f.auth, "X-Filename": "data.geojson", "Content-Length": String(body.length), "Content-Type": header },
      body,
    });
    expect(res.status).toBe(201);
    const { version } = await res.json() as { version: AssetVersion };
    expect(version.contentType).toBe(stored);
    expect(f.versions.versions.get(version.id)?.contentType).toBe(stored);
  });
});

describe("the API reports a stored Content-Type normalized", () => {
  test.each([
    ["terminal escape after CR LF", "text/plain\r\n\u001b[31mX", "application/octet-stream"],
    ["OSC title escape", "\u001b]0;pwned\u0007", "application/octet-stream"],
    ["empty parameter before a comma", "image/png;,text/html", "application/octet-stream"],
    ["raw SGR escape", "\u001b[31m", "application/octet-stream"],
    ["SGR escape after a type", "text/plain\u001b[31m", "application/octet-stream"],
    ["comma list", "text/plain,text/html", "application/octet-stream"],
    ["uppercase with extra parameters", "TEXT/PLAIN; Charset=UTF-8; x=y", "text/plain; charset=utf-8"],
  ])("%s", async (_name, stored, sent) => {
    const f = await siteFixture();
    for (const id of [ASSET_ID, SINGLE_FILE_ID]) {
      f.metadata.assets.set(id, { ...f.metadata.assets.get(id)!, contentType: stored });
    }
    f.versions.versions.set(VERSION_ID, { ...f.versions.versions.get(VERSION_ID)!, contentType: stored });
    const get = async (path: string) => {
      const res = await f.app.request(path, { headers: f.auth });
      expect(res.status, path).toBe(200);
      return res;
    };

    const single = (await (await get(`/api/v1/assets/${SINGLE_FILE_ID}`)).json()) as { asset: AssetMetadata };
    expect(single.asset.contentType).toBe(sent);
    const archive = (await (await get(`/api/v1/assets/${ASSET_ID}`)).json()) as { asset: AssetMetadata };
    expect(archive.asset.contentType).toBe(sent);
    expect(archive.asset.currentVersion?.contentType).toBe(sent);
    const list = (await (await get(`/api/v1/assets?projectId=${PROJECT_ID}`)).json()) as { assets: AssetMetadata[] };
    expect(list.assets.map((a) => a.contentType)).toEqual([sent, sent]);
    const versions = (await (await get(`/api/v1/assets/${ASSET_ID}/versions`)).json()) as { versions: AssetVersion[] };
    expect(versions.versions.map((v) => v.contentType)).toEqual([sent]);
    const version = (await (await get(`/api/v1/assets/${ASSET_ID}/versions/${VERSION_ID}`)).json()) as { version: AssetVersion };
    expect(version.version.contentType).toBe(sent);
    const files = (await (await get(`/api/v1/assets/${SINGLE_FILE_ID}/files`)).text()).trim().split("\n");
    expect(files.map((line) => (JSON.parse(line) as { contentType: string }).contentType)).toEqual([sent]);
  });
});

const PATHOLOGICAL: Array<[string, string]> = [
  ["unterminated quote after many empty parameters", "a/b" + "; ".repeat(5000) + '"'],
  ["many empty parameters", "text/plain" + ";  ".repeat(5000)],
  ["many padded empty parameters", "text/plain" + " ; ".repeat(5000)],
  ["many padded parameters", "text/plain" + "; a=b ".repeat(5000)],
];

describe("a pathological Content-Type is rejected quickly", () => {
  test.each(PATHOLOGICAL)("read of a seeded row: %s", async (_name, stored) => {
    const { app, metadata } = await fixture();
    metadata.assets.set(SINGLE_FILE_ID, { ...metadata.assets.get(SINGLE_FILE_ID)!, contentType: stored });
    const start = performance.now();
    const res = await app.request(`/files/${SINGLE_FILE_ID}/data.geojson`);
    expect(performance.now() - start).toBeLessThan(500);
    expectServedAs(res, SANDBOXED.type, false, _name);
  });

  test.each(PATHOLOGICAL)("upload: %s", async (_name, header) => {
    const f = await fixture({ anonymousUploadEnabled: true });
    f.deps.writes = {
      ...f.deps.writes,
      async createAsset({ asset }: { asset: AssetMetadata }) { f.metadata.assets.set(asset.id, asset); },
    } as AtomicWrites;
    const app = createApp(f.deps);
    const body = "x";
    const start = performance.now();
    const res = await app.request("/api/v1/assets", {
      method: "POST",
      headers: { "X-Filename": "a.txt", "Content-Length": "1", "Content-Type": header },
      body,
    });
    expect(performance.now() - start).toBeLessThan(500);
    expect(res.status).toBe(201);
    expect(((await res.json()) as { asset: AssetMetadata }).asset.contentType).toBe("application/octet-stream");
  });
});
