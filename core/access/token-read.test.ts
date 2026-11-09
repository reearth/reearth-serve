/**
 * Delivery tokens on `/files` reads through the real app (ADR-014 §4 Carry,
 * Match, Response): the match, the refusals, the response headers, the
 * redirects that keep the token, and the assets that ignore it.
 */
import { describe, expect, test, vi } from "vitest";
import {
  ASSET_ID, DOCS_HTML, INDEX_HTML, protect, SINGLE_FILE_ID, seedEntry, seedHosting, VERSION_ID,
} from "../../adapters/memory/fixture";
import { siteFixture, SUFFIX } from "../../adapters/memory/site-fixture";
import { WebCryptoDeliveryTokenCodec } from "../../adapters/webcrypto/delivery-token";
import { versionThumbKey } from "../asset/usecase/shared";
import { thumbnailFilename } from "../thumbnail/sizes";
import { parseRedirects } from "../site/rules";
import { parseDeliveryTokenKeys, toUnixSeconds, type AssetPath, type UnixSeconds } from "./token";

const secret = (fill: string) => btoa(fill.repeat(32));
const ringOf = (active: string, keys: Record<string, string>) =>
  new WebCryptoDeliveryTokenCodec(parseDeliveryTokenKeys(JSON.stringify({ active, keys })));
const CODEC = ringOf("k1", { k1: secret("a") });

interface Mint {
  assetId?: string;
  versionId?: string | null;
  prefix?: string;
  lifetime?: number;
}

async function mint({ assetId = ASSET_ID, versionId = null, prefix = "", lifetime = 3600 }: Mint = {}, codec = CODEC) {
  const now = toUnixSeconds(Date.now());
  return codec.sign({ assetId, versionId, prefix: prefix as AssetPath, exp: (now + lifetime) as UnixSeconds }, now);
}

async function tokenFixture(codec = CODEC) {
  const f = await siteFixture({ deps: { deliveryTokens: codec } });
  for (const id of [ASSET_ID, SINGLE_FILE_ID]) await f.metadata.setProtection(id, { access: "restricted" });
  return f;
}

const q = (token: string) => `serve_token=${encodeURIComponent(token)}`;

function expectRefusal(res: Response, status: number) {
  expect(res.status).toBe(status);
  expect(res.headers.get("Cache-Control")).toBe("no-store");
  expect(res.headers.get("Access-Control-Allow-Origin")).toBe("*");
}

describe("a token that covers the read", () => {
  test("serves through the query and the header, with the token response headers", async () => {
    const { app } = await tokenFixture();
    const token = await mint({ prefix: "docs/" });
    for (const init of [
      { url: `/files/${ASSET_ID}/docs/index.html?${q(token)}`, headers: {} as Record<string, string> },
      { url: `/files/${ASSET_ID}/docs/index.html`, headers: { "X-Serve-Token": token } },
    ]) {
      const res = await app.request(init.url, { headers: { ...init.headers, Origin: "https://example.test" } });
      expect(res.status).toBe(200);
      expect(await res.text()).toBe(DOCS_HTML);
      expect(res.headers.get("Access-Control-Allow-Origin")).toBe("*");
      expect(res.headers.get("Access-Control-Allow-Credentials")).toBeNull();
      expect(res.headers.get("Referrer-Policy")).toBe("no-referrer");
      expect(res.headers.get("Cache-Control")).toBe("private, max-age=0, must-revalidate");
      const vary = res.headers.get("Vary") ?? "";
      for (const name of ["Authorization", "X-Serve-Token", "Origin"]) expect(vary).toContain(name);
    }
  });

  test("a pinned URL caps the year-long cache at the token's remaining life", async () => {
    const { app } = await tokenFixture();
    const res = await app.request(`/files/${VERSION_ID}/index.html?${q(await mint({ lifetime: 600 }))}`);
    expect(res.status).toBe(200);
    const maxAge = Number(/max-age=(\d+)/.exec(res.headers.get("Cache-Control") ?? "")?.[1]);
    expect(maxAge).toBeGreaterThan(590);
    expect(maxAge).toBeLessThanOrEqual(600);
    expect(res.headers.get("Cache-Control")).toMatch(/^private, max-age=\d+, immutable$/);
  });

  test("Range, HEAD and a child path with its own query", async () => {
    const { app, geojson } = await tokenFixture();
    const token = await mint({ assetId: SINGLE_FILE_ID });
    const ranged = await app.request(`/files/${SINGLE_FILE_ID}/data.geojson?${q(token)}`, { headers: { Range: "bytes=0-4" } });
    expect(ranged.status).toBe(206);
    expect(await ranged.text()).toBe(geojson.slice(0, 5));
    expect(ranged.headers.get("Cache-Control")).toContain("private");
    const head = await app.request(`/files/${SINGLE_FILE_ID}/data.geojson?${q(token)}`, { method: "HEAD" });
    expect(head.status).toBe(200);
    expect(head.headers.get("Cache-Control")).toContain("private");
    const child = await app.request(`/files/${ASSET_ID}/docs/?v=2&${q(await mint({ prefix: "docs" }))}`);
    expect(child.status).toBe(200);
    expect(await child.text()).toBe(DOCS_HTML);
  });

  test("an archive entry under an escaped slash or a literal percent sign", async () => {
    const { app, storage } = await tokenFixture();
    await seedEntry(storage, "100%.png", "png");
    const docs = await app.request(`/files/${ASSET_ID}/docs%2Findex.html?${q(await mint({ prefix: "docs/" }))}`);
    expect(docs.status).toBe(200);
    expect(await docs.text()).toBe(DOCS_HTML);
    const percent = await mint({ prefix: "100%.png" });
    for (const path of ["100%25.png", "100%.png"]) {
      const res = await app.request(`/files/${ASSET_ID}/${path}?${q(percent)}`);
      expect(res.status, path).toBe(200);
      expect(await res.text()).toBe("png");
    }
  });

  test("the thumbnail is matched on the source filename", async () => {
    const { app, storage } = await tokenFixture();
    const webp = new TextEncoder().encode("RIFF");
    await storage.put(
      versionThumbKey(ASSET_ID, VERSION_ID, thumbnailFilename("md")),
      new ReadableStream({ start(c) { c.enqueue(webp); c.close(); } }),
      "image/webp",
      webp.byteLength,
    );
    const file = await mint({ prefix: "site.zip" });
    for (const path of ["_thumbs/md.webp", "anything?thumb=md"]) {
      const res = await app.request(`/files/${ASSET_ID}/${path}${path.includes("?") ? "&" : "?"}${q(file)}`);
      expect(res.status, path).toBe(200);
      expect(res.headers.get("Cache-Control")).toMatch(/^private, max-age=\d+$/);
    }
    expectRefusal(await app.request(`/files/${ASSET_ID}/_thumbs/md.webp?${q(await mint({ prefix: "docs/" }))}`), 403);
  });

  test("a token signed with the old key still verifies after rotation, and one signed with the new key does not before it", async () => {
    const before = ringOf("k1", { k1: secret("a") });
    const rotated = ringOf("k2", { k1: secret("a"), k2: secret("b") });
    const old = await mint({}, before);
    const { app } = await tokenFixture(rotated);
    expect((await app.request(`/files/${ASSET_ID}/?${q(old)}`)).status).toBe(200);
    expect((await app.request(`/files/${ASSET_ID}/?${q(await mint({}, rotated))}`)).status).toBe(200);
    const { app: unrotated } = await tokenFixture(before);
    expectRefusal(await unrotated.request(`/files/${ASSET_ID}/?${q(await mint({}, rotated))}`), 401);
  });
});

describe("a token that does not cover the read", () => {
  test("an expired, foreign, forged or unconfigured token counts as no token", async () => {
    const { app } = await tokenFixture();
    const now = toUnixSeconds(Date.now());
    const expired = await CODEC.sign({ assetId: ASSET_ID, versionId: null, prefix: "" as AssetPath, exp: (now - 60) as UnixSeconds }, now);
    const foreign = await mint({ assetId: SINGLE_FILE_ID });
    for (const token of [expired, foreign, `${(await mint()).slice(0, -2)}AA`]) {
      const res = await app.request(`/files/${ASSET_ID}/?${q(token)}`);
      expectRefusal(res, 401);
      expect(res.headers.get("WWW-Authenticate")).toBe("Bearer, ServeToken");
    }
    const off = await siteFixture();
    await off.metadata.setProtection(ASSET_ID, { access: "restricted" });
    expectRefusal(await off.app.request(`/files/${ASSET_ID}/?${q(await mint())}`), 401);
  });

  test("a wrong prefix, a partial segment or a version mismatch is 403", async () => {
    const { app } = await tokenFixture();
    const cases: [string, string][] = [
      [await mint({ prefix: "assets/" }), "docs/index.html"],
      [await mint({ prefix: "doc" }), "docs/index.html"],
      [await mint({ prefix: "docs/" }), "docs"],
      [await mint({ versionId: "another-version" }), "docs/"],
      [await mint({ prefix: "docs/" }), "docs/%2e%2e/index.html"],
    ];
    for (const [token, path] of cases) {
      const res = await app.request(`/files/${ASSET_ID}/${path}?${q(token)}`);
      expectRefusal(res, 403);
      expect(await res.json()).toEqual({ error: "token does not cover this file" });
    }
  });

  test("an escape the path parser refuses is 400 before any access check", async () => {
    const { app, storage } = await tokenFixture();
    const get = vi.spyOn(storage, "get");
    const token = await mint({ prefix: "docs/" });
    for (const path of ["docs/..%2Findex.html", "docs/a%252Fb", "docs/%2E%2E%5Cindex.html", "/docs/"]) {
      const res = await app.request(`/files/${ASSET_ID}/${path}?${q(token)}`);
      expect(res.status, path).toBe(400);
      expect(await res.json()).toEqual({ error: "Invalid path" });
    }
    expect(get).not.toHaveBeenCalled();
  });

  test("a member's bearer decides over an out-of-scope token", async () => {
    const { app, auth } = await tokenFixture();
    const res = await app.request(`/files/${ASSET_ID}/?${q(await mint({ prefix: "docs/" }))}`, { headers: auth });
    expect(res.status).toBe(200);
    expect(await res.text()).toBe(INDEX_HTML);
    expect(res.headers.get("Referrer-Policy")).toBeNull();
  });

  test("two different tokens are 400 no-store, even beside a valid bearer", async () => {
    const { app, auth } = await tokenFixture();
    const res = await app.request(`/files/${ASSET_ID}/?${q(await mint())}`, {
      headers: { ...auth, "X-Serve-Token": await mint({ prefix: "docs/" }) },
    });
    expectRefusal(res, 400);
  });
});

describe("redirects inside the asset keep a query token", () => {
  test("the directory redirect is path-only and keeps the whole query", async () => {
    const { app } = await tokenFixture();
    const token = await mint({ prefix: "docs" });
    const res = await app.request(`https://example.test/files/${ASSET_ID}/docs?v=2&${q(token)}`);
    expect(res.status).toBe(301);
    expect(res.headers.get("Location")).toBe(`/files/${ASSET_ID}/docs/?v=2&${q(token)}`);
    expect(res.headers.get("Cache-Control")).toBe("no-store");
  });

  test("a _redirects rule keeps it", async () => {
    const { app, versions } = await tokenFixture();
    seedHosting(versions, { headers: [], redirects: parseRedirects("/old /docs/ 301").rules, warnings: [] });
    const token = await mint();
    const res = await app.request(`/files/${ASSET_ID}/old?${q(token)}`);
    expect(res.status).toBe(301);
    expect(res.headers.get("Location")).toBe(`/files/${ASSET_ID}/docs/?${q(token)}`);
  });

  test("a rule target with its own query joins the token with &", async () => {
    const { app, versions } = await tokenFixture();
    seedHosting(versions, { headers: [], redirects: parseRedirects("/old /docs/?x=1 302").rules, warnings: [] });
    const token = await mint();
    const res = await app.request(`/files/${ASSET_ID}/old?${q(token)}`);
    expect(res.headers.get("Location")).toBe(`/files/${ASSET_ID}/docs/?x=1&${q(token)}`);
  });

  test("a bearer read's redirect drops a token it did not use", async () => {
    const { app, auth } = await tokenFixture();
    const res = await app.request(`/files/${ASSET_ID}/docs?${q(await mint({ prefix: "assets/" }))}`, { headers: auth });
    expect(res.status).toBe(301);
    expect(res.headers.get("Location")).toBe(`/files/${ASSET_ID}/docs/`);
  });
});

describe("a site host", () => {
  test("reads with a token and nothing else", async () => {
    const { app, auth } = await tokenFixture();
    const host = `${ASSET_ID}${SUFFIX}`;
    const token = await mint({ prefix: "docs" });
    const res = await app.request(`http://${host}/docs/?${q(token)}`, { headers: { Host: host } });
    expect(res.status).toBe(200);
    expect(await res.text()).toBe(DOCS_HTML);
    const redirect = await app.request(`http://${host}/docs?${q(token)}`, { headers: { Host: host } });
    expect(redirect.headers.get("Location")).toBe(`/docs/?${q(token)}`);
    expectRefusal(await app.request(`http://${host}/?${q(token)}`, { headers: { Host: host, ...auth } }), 403);
  });
});

describe("public and password assets ignore the token", () => {
  test("a public read is unchanged and strips the token from its redirect", async () => {
    const f = await siteFixture({ deps: { deliveryTokens: CODEC } });
    const token = await mint();
    const res = await f.app.request(`/files/${ASSET_ID}/?${q(token)}`, { headers: { "X-Serve-Token": "other" } });
    expect(res.status).toBe(200);
    expect(res.headers.get("Cache-Control")).toBe("public, max-age=0, must-revalidate");
    expect(res.headers.get("Referrer-Policy")).toBeNull();
    const redirect = await f.app.request(`/files/${ASSET_ID}/docs?x=1&${q(token)}`);
    expect(redirect.headers.get("Location")).toBe(`/files/${ASSET_ID}/docs/?x=1`);
  });

  test("a password asset challenges as before and keeps the token out of the form's next", async () => {
    const f = await siteFixture({ deps: { deliveryTokens: CODEC } });
    await protect(f.metadata, ASSET_ID, "correct-horse-battery");
    const token = await mint();
    const res = await f.app.request(`/files/${ASSET_ID}/docs/?x=1&${q(token)}`, {
      headers: { Accept: "text/html" },
    });
    expect(res.status).toBe(401);
    const html = await res.text();
    expect(html).toContain(`value="/files/${ASSET_ID}/docs/?x=1"`);
    expect(html).not.toContain("serve_token");
  });
});
