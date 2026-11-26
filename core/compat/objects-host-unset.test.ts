import { describe, expect, test } from "vitest";
import { createHash } from "node:crypto";
import { ASSET_ID, protect, seedHosting, seedNotFoundPage, SINGLE_FILE_ID } from "../../adapters/memory/fixture";
import { siteFixture, SUFFIX } from "../../adapters/memory/site-fixture";
import { parseHeaders, parseRedirects } from "../site/rules";

const API_HOST = "storage.example.test";

const HOSTS = { apex: "example.test", assetSite: `${ASSET_ID}${SUFFIX}`, unknownSite: `nosuch${SUFFIX}`, api: API_HOST };

const PATHS: [string, string][] = [
  ["GET", `/files/${ASSET_ID}/`], ["GET", `/files/${ASSET_ID}/docs`], ["GET", `/files/${ASSET_ID}/nope`],
  ["GET", `/files/${ASSET_ID}/_headers`], ["GET", `/files/${ASSET_ID}/_redirects`], ["GET", `/files/${ASSET_ID}/old`],
  ["GET", `/files/${ASSET_ID}/assets/app.js`], ["HEAD", `/files/${ASSET_ID}/index.html`], ["OPTIONS", `/files/${ASSET_ID}/index.html`],
  ["GET", `/files/${SINGLE_FILE_ID}/data.geojson`], ["GET", `/files/${SINGLE_FILE_ID}/docs`], ["GET", "/files/0000000000000000/x"],
  ["GET", "/"], ["GET", "/docs"], ["GET", "/nope"], ["GET", "/old"], ["GET", "/assets/app.js"], ["HEAD", "/index.html"], ["OPTIONS", "/index.html"],
];

const MODES = ["public", "password", "restricted"] as const;

const VISITORS: Record<(typeof MODES)[number], Record<string, Record<string, string>>> = {
  public: { anonymous: {}, gzip: { "Accept-Encoding": "gzip" }, range: { Range: "bytes=0-3" } },
  password: { anonymous: {}, basic: { Authorization: `Basic ${btoa("u:pw")}` } },
  restricted: { anonymous: {} },
};

async function world(mode: (typeof MODES)[number]) {
  const f = await siteFixture({ deps: { compatApiHost: API_HOST, compatObjectsHost: undefined } });
  await seedNotFoundPage(f.storage);
  const headers = parseHeaders("/*\n  X-From-Rules: yes");
  const redirects = parseRedirects("/old /index.html 301");
  seedHosting(f.versions, { headers: headers.rules, redirects: redirects.rules, warnings: [] });
  for (const id of [ASSET_ID, SINGLE_FILE_ID]) {
    if (mode === "password") await protect(f.metadata, id, "pw");
    if (mode === "restricted") await f.metadata.setProtection(id, { access: "restricted" });
  }
  return f;
}

async function answer(res: Response) {
  const body = new Uint8Array(await res.arrayBuffer());
  const headers = Object.fromEntries([...res.headers]
    .filter(([name]) => name !== "date")
    .map(([name, value]) => [name, name === "x-session-id" ? "<session>" : value]));
  return { status: res.status, headers, body: `${body.length} ${createHash("sha256").update(body).digest("hex").slice(0, 16)}` };
}

describe("with COMPAT_OBJECTS_HOST unset", () => {
  test("the apex, site hosts and the API host answer as before the objects host existed", async () => {
    const out: Record<string, unknown> = {};
    for (const mode of MODES) {
      const f = await world(mode);
      for (const [hostName, host] of Object.entries(HOSTS)) {
        for (const [method, path] of PATHS) {
          for (const [visitor, headers] of Object.entries(VISITORS[mode])) {
            const res = await f.app.request(`https://${host}${path}`, { method, headers: { Host: host, ...headers } });
            out[`${mode} ${hostName} ${method} ${path} ${visitor}`] = await answer(res);
          }
        }
      }
    }
    await expect(JSON.stringify(out, null, 1)).toMatchFileSnapshot("./__snapshots__/objects-host-unset.json");
  });
});
