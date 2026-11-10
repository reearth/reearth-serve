/**
 * `POST /api/v1/assets/{id}/signed-urls` through the real app (ADR-014 §4
 * Mint): the check order, the response, and the route's CORS.
 */
import { describe, expect, test, vi } from "vitest";
import { ASSET_ID, protect, SINGLE_FILE_ID, VERSION_ID } from "../../../adapters/memory/fixture";
import { siteFixture, token, type SiteFixtureOptions } from "../../../adapters/memory/site-fixture";
import { WebCryptoDeliveryTokenCodec } from "../../../adapters/webcrypto/delivery-token";
import { parseDeliveryTokenKeys, toUnixSeconds } from "../../access/token";
import { TenancyUnavailableError } from "../../tenancy/port";

const CODEC = new WebCryptoDeliveryTokenCodec(
  parseDeliveryTokenKeys(JSON.stringify({ active: "k1", keys: { k1: btoa("a".repeat(32)) } })),
);

type SignedUrl = { token: string; expiresAt: number; urlTemplate: string };

async function mintFixture(options: SiteFixtureOptions = {}) {
  const f = await siteFixture({ ...options, deps: { deliveryTokens: CODEC, ...options.deps } });
  await f.metadata.setProtection(ASSET_ID, { access: "restricted" });
  const mint = (id: string, body: unknown, headers: Record<string, string> = f.auth) =>
    f.app.request(`/api/v1/assets/${id}/signed-urls`, {
      method: "POST",
      headers: { ...headers, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  return { ...f, mint };
}

describe("a member", () => {
  test.each(["viewer", "editor"] as const)("a %s mints a token that reads the asset", async (role) => {
    const { app, mint } = await mintFixture({ role });
    const before = Date.now();
    const res = await mint(ASSET_ID, { prefix: "/docs/", expiresIn: 600 });
    expect(res.status).toBe(200);
    const body = await res.json() as SignedUrl;
    expect(body.urlTemplate).toBe(`https://example.test/files/${ASSET_ID}/{path}?serve_token=${body.token}`);
    expect(body.expiresAt % 1000).toBe(0);
    expect(body.expiresAt).toBeGreaterThanOrEqual(toUnixSeconds(before) * 1000 + 600_000);
    expect(body.expiresAt).toBeLessThanOrEqual(Date.now() + 600_000);
    const verified = await CODEC.verify(body.token, toUnixSeconds(Date.now()));
    expect(verified.ok && verified.claims).toMatchObject({ assetId: ASSET_ID, versionId: null, prefix: "docs/" });
    expect((await app.request(body.urlTemplate.replace("{path}", "docs/index.html"))).status).toBe(200);
  });

  test("expiresIn defaults to an hour", async () => {
    const { mint } = await mintFixture();
    const before = toUnixSeconds(Date.now());
    const body = await (await mint(SINGLE_FILE_ID, {})).json() as SignedUrl;
    expect(body.expiresAt / 1000).toBeGreaterThanOrEqual(before + 3600);
    expect(body.expiresAt / 1000).toBeLessThanOrEqual(toUnixSeconds(Date.now()) + 3600);
  });

  test("a body versionId or a version ID in the URL pins the token, and the template names the version", async () => {
    const { mint } = await mintFixture();
    for (const res of [await mint(ASSET_ID, { versionId: VERSION_ID }), await mint(VERSION_ID, {}), await mint(VERSION_ID, { versionId: VERSION_ID })]) {
      expect(res.status).toBe(200);
      const body = await res.json() as SignedUrl;
      expect(body.urlTemplate.startsWith(`https://example.test/files/${VERSION_ID}/{path}?serve_token=`)).toBe(true);
      const verified = await CODEC.verify(body.token, toUnixSeconds(Date.now()));
      expect(verified.ok && verified.claims.versionId).toBe(VERSION_ID);
    }
  });
});

describe("refusals, in the ADR's order", () => {
  test("no codec is 501 before the body or the caller is looked at", async () => {
    const { mint } = await mintFixture({ deps: { deliveryTokens: null } });
    expect((await mint(ASSET_ID, { expiresIn: 1 }, {})).status).toBe(501);
  });

  test("an invalid body is 400 before the caller is looked at", async () => {
    const { mint } = await mintFixture();
    const stranger = { Authorization: `Bearer ${await token("stranger")}` };
    for (const body of [{ expiresIn: 59 }, { expiresIn: 604_801 }, { expiresIn: 60.5 }, { prefix: "tiles/../x" }, { prefix: "a\\b" }]) {
      expect((await mint(ASSET_ID, body, stranger)).status, JSON.stringify(body)).toBe(400);
    }
    expect((await mint(ASSET_ID, { expiresIn: 60 })).status).toBe(200);
    expect((await mint(ASSET_ID, { expiresIn: 604_800 })).status).toBe(200);
  });

  test("a body that is not JSON is 400, not a default token", async () => {
    const { app, auth } = await mintFixture();
    const res = await app.request(`/api/v1/assets/${ASSET_ID}/signed-urls`, {
      method: "POST",
      headers: { ...auth, "Content-Type": "text/plain" },
      body: JSON.stringify({ prefix: "tiles/" }),
    });
    expect(res.status).toBe(400);
  });

  test("no body at all mints with the defaults", async () => {
    const { app, auth } = await mintFixture();
    const res = await app.request(`/api/v1/assets/${ASSET_ID}/signed-urls`, { method: "POST", headers: auth });
    expect(res.status).toBe(200);
  });

  test("a caller without read_asset gets the 404 a missing asset gets", async () => {
    const { mint } = await mintFixture();
    const stranger = { Authorization: `Bearer ${await token("stranger")}` };
    for (const id of [ASSET_ID, "0000000000000000"]) {
      const res = await mint(id, {}, stranger);
      expect(res.status).toBe(404);
      expect(await res.json()).toEqual({ error: "Asset not found" });
    }
  });

  test("a password asset is 400", async () => {
    const { mint, metadata } = await mintFixture();
    await protect(metadata, ASSET_ID, "correct-horse-battery");
    expect((await mint(ASSET_ID, {})).status).toBe(400);
  });

  test("a versionId that is not a version of the asset, or differs from the URL's, is 400", async () => {
    const { mint } = await mintFixture();
    expect((await mint(ASSET_ID, { versionId: "ffffffffffffffff" })).status).toBe(400);
    expect((await mint(SINGLE_FILE_ID, { versionId: VERSION_ID })).status).toBe(400);
    expect((await mint(VERSION_ID, { versionId: "ffffffffffffffff" })).status).toBe(400);
  });
});

describe("CORS", () => {
  test("the preflight is answered before auth", async () => {
    const { app } = await mintFixture();
    const res = await app.request(`/api/v1/assets/${ASSET_ID}/signed-urls`, {
      method: "OPTIONS",
      headers: { Origin: "https://viewer.example.net", "Access-Control-Request-Method": "POST", Authorization: "Bearer junk" },
    });
    expect(res.status).toBe(204);
    expect(res.headers.get("Access-Control-Allow-Origin")).toBe("*");
    expect(res.headers.get("Access-Control-Allow-Methods")).toBe("POST");
    expect(res.headers.get("Access-Control-Allow-Headers")).toBe("authorization, content-type");
    expect(res.headers.get("Access-Control-Allow-Credentials")).toBeNull();
  });

  test("every answer carries it, the auth middleware's 401 included", async () => {
    const { mint } = await mintFixture();
    for (const [headers, status] of [
      [{ Authorization: "Bearer not-a-jwt" }, 401],
      [{ Authorization: `Bearer ${await token("stranger")}` }, 404],
      [undefined, 200],
    ] as const) {
      const res = await mint(ASSET_ID, {}, headers);
      expect(res.status).toBe(status);
      expect(res.headers.get("Access-Control-Allow-Origin")).toBe("*");
      expect(res.headers.get("Access-Control-Allow-Credentials")).toBeNull();
      expect(res.headers.get("Access-Control-Expose-Headers")).toBe("Retry-After");
    }
  });

  test("a directory outage's 503 is readable cross-origin", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const { mint } = await mintFixture({
      deps: { tenancy: { enter: async () => { throw new TenancyUnavailableError("down"); } } },
    });
    const res = await mint(ASSET_ID, {});
    expect(res.status).toBe(503);
    expect(res.headers.get("Retry-After")).toBe("5");
    expect(res.headers.get("Access-Control-Allow-Origin")).toBe("*");
    expect(res.headers.get("Access-Control-Expose-Headers")).toBe("Retry-After");
    vi.restoreAllMocks();
  });
});
