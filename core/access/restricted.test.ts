/**
 * `restricted` assets end to end through the real app (ADR-014 §1, §5): the
 * bearer check in the file handler, membership through ADR-016's policy, the
 * refusals, caching and CORS, and the PATCH that turns it on.
 */
import { describe, expect, test, vi } from "vitest";
import {
  ASSET_ID, DOCS_HTML, fixture, INDEX_HTML, memberTenancy, protect, SINGLE_FILE_ID, VERSION_ID,
} from "../../adapters/memory/fixture";
import { siteFixture, SUFFIX, token, type SiteFixtureOptions } from "../../adapters/memory/site-fixture";
import type { MemberStore } from "../member/repository";
import type { Tenancy } from "../tenancy/port";
import { TenancyUnavailableError, UnknownAccountError } from "../tenancy/port";
import type { VerifiedCaller } from "../auth/types";
import { setAssetAccess } from "../asset/usecase";
import { versionThumbKey } from "../asset/usecase/shared";
import { thumbnailFilename } from "../thumbnail/sizes";

const OWN_ORIGIN = "https://example.test";
const EXPOSE = "WWW-Authenticate, Retry-After";

interface SpyOptions {
  /** Thrown by `enter` for a verified caller. */
  fail?: Error;
  /** The authorizer refuses every check the role floor allows. */
  deny?: boolean;
}

/** A tenancy that records every `enter`, over the fixture's members. */
function spyTenancy({ fail, deny }: SpyOptions = {}) {
  let inner: Tenancy | null = null;
  const enter = vi.fn(async (caller: VerifiedCaller | null) => {
    if (caller && fail) throw fail;
    if (!inner) throw new Error("spyTenancy: bind() was not called");
    const entered = await inner.enter(caller);
    return deny ? { ...entered, scope: { ...entered.scope, authorizer: { check: async () => false } } } : entered;
  });
  return {
    tenancy: { enter } satisfies Tenancy,
    bind(members: MemberStore) { inner = memberTenancy(members); },
    bound: () => enter.mock.calls.filter(([who]) => who !== null).length,
  };
}

async function restrictedFixture(options: SiteFixtureOptions & SpyOptions = {}) {
  const spy = spyTenancy(options);
  const f = await siteFixture({ ...options, deps: { tenancy: spy.tenancy, ...options.deps } });
  spy.bind(f.members);
  for (const id of [ASSET_ID, SINGLE_FILE_ID]) await f.metadata.setProtection(id, { access: "restricted" });
  return { ...f, spy };
}

function expectRefusal(res: Response, status: number) {
  expect(res.status).toBe(status);
  expect(res.headers.get("Cache-Control")).toBe("no-store");
  expect(res.headers.get("Access-Control-Allow-Origin")).toBe("*");
  expect(res.headers.get("Access-Control-Allow-Credentials")).toBeNull();
  expect(res.headers.get("Access-Control-Expose-Headers")).toBe(EXPOSE);
}

describe("without a valid bearer", () => {
  test("no bearer is a JSON 401 that names Bearer and ServeToken", async () => {
    const { app } = await restrictedFixture();
    const res = await app.request(`/files/${ASSET_ID}`);
    expectRefusal(res, 401);
    expect(res.headers.get("WWW-Authenticate")).toBe("Bearer, ServeToken");
    expect(await res.json()).toEqual({ error: "authentication required" });
  });

  test("a browser navigation gets the same JSON, not a page", async () => {
    const { app } = await restrictedFixture();
    const res = await app.request(`/files/${ASSET_ID}`, { headers: { Accept: "text/html" } });
    expectRefusal(res, 401);
    expect(res.headers.get("Content-Type")).toContain("application/json");
  });

  test("an invalid bearer or another scheme is the same 401", async () => {
    const { app, spy } = await restrictedFixture();
    for (const authorization of ["Bearer not-a-jwt", `Basic ${btoa("viewer:pw")}`]) {
      const res = await app.request(`/files/${SINGLE_FILE_ID}`, { headers: { Authorization: authorization } });
      expectRefusal(res, 401);
      expect(res.headers.get("WWW-Authenticate")).toBe("Bearer, ServeToken");
    }
    expect(spy.bound()).toBe(0);
  });

  test("with no issuer configured a bearer counts as absent", async () => {
    const { app, auth } = await restrictedFixture({ deps: { auth: {} } });
    const res = await app.request(`/files/${ASSET_ID}`, { headers: auth });
    expectRefusal(res, 401);
  });

  test("a refusal never reads storage, thumbnails included", async () => {
    const { app, storage } = await restrictedFixture();
    const get = vi.spyOn(storage, "get");
    const head = vi.spyOn(storage, "head");
    for (const path of ["", "/docs", "/docs/", "/nope.js", "/_thumbs/md.webp"]) {
      expect((await app.request(`/files/${ASSET_ID}${path}`)).status).toBe(401);
      expect((await app.request(`/files/${ASSET_ID}${path}`, {
        headers: { Authorization: `Bearer ${await token("stranger")}` },
      })).status).toBe(404);
    }
    expect(get).not.toHaveBeenCalled();
    expect(head).not.toHaveBeenCalled();
  });
});

describe("a verified caller", () => {
  test("a non-member gets the 404 a missing asset gets", async () => {
    const { app } = await restrictedFixture();
    const res = await app.request(`/files/${ASSET_ID}`, {
      headers: { Authorization: `Bearer ${await token("stranger")}` },
    });
    expectRefusal(res, 404);
    expect(await res.json()).toEqual({ error: "File not found" });
  });

  test("a member the authorizer refuses gets the same 404", async () => {
    const { app, auth } = await restrictedFixture({ deny: true });
    const res = await app.request(`/files/${ASSET_ID}`, { headers: auth });
    expectRefusal(res, 404);
  });

  test("an identity the directory does not know gets the same 404", async () => {
    const { app, auth } = await restrictedFixture({ fail: new UnknownAccountError() });
    const res = await app.request(`/files/${ASSET_ID}`, { headers: auth });
    expectRefusal(res, 404);
    expect(await res.json()).toEqual({ error: "File not found" });
  });

  test("a directory outage is 503 with Retry-After, readable cross-origin", async () => {
    vi.spyOn(console, "error").mockImplementationOnce(() => {});
    const { app, auth } = await restrictedFixture({ fail: new TenancyUnavailableError("down") });
    const res = await app.request(`/files/${ASSET_ID}`, { headers: { ...auth, Origin: "https://viewer.example.net" } });
    expectRefusal(res, 503);
    expect(res.headers.get("Retry-After")).toBe("5");
    expect(await res.json()).toEqual({ error: "Authorization service unavailable" });
  });

  test.each(["viewer", "editor"] as const)("a %s reads the file, privately and with uncredentialed CORS", async (role) => {
    const { app, auth, spy } = await restrictedFixture({ role });
    const res = await app.request(`/files/${ASSET_ID}`, { headers: { ...auth, Origin: OWN_ORIGIN } });
    expect(res.status).toBe(200);
    expect(await res.text()).toBe(INDEX_HTML);
    expect(res.headers.get("Cache-Control")).toBe("private, max-age=0, must-revalidate");
    expect(res.headers.get("Access-Control-Allow-Origin")).toBe("*");
    expect(res.headers.get("Access-Control-Allow-Credentials")).toBeNull();
    expect(res.headers.get("Access-Control-Expose-Headers")).toBe(EXPOSE);
    const vary = res.headers.get("Vary") ?? "";
    expect(vary).toContain("Authorization");
    expect(vary).toContain("Origin");
    expect(spy.bound()).toBe(1);
  });

  test("a single-file asset at a pinned URL keeps the year-long private cache", async () => {
    const { app, auth, geojson } = await restrictedFixture();
    const res = await app.request(`/files/${SINGLE_FILE_ID}/data.geojson`, { headers: auth });
    expect(res.status).toBe(200);
    expect(await res.text()).toBe(geojson);
    expect(res.headers.get("Cache-Control")).toContain("private");
    const pinned = await app.request(`/files/${VERSION_ID}/index.html`, { headers: auth });
    expect(pinned.status).toBe(200);
    expect(pinned.headers.get("Cache-Control")).toBe("private, max-age=31536000, immutable");
  });

  test("an archive entry, and its misses and redirects are no-store", async () => {
    const { app, auth } = await restrictedFixture();
    const entry = await app.request(`/files/${ASSET_ID}/docs/`, { headers: auth });
    expect(entry.status).toBe(200);
    expect(await entry.text()).toBe(DOCS_HTML);
    expect(entry.headers.get("Cache-Control")).toContain("private");

    const redirect = await app.request(`http://localhost/files/${ASSET_ID}/docs`, { headers: auth });
    expect(redirect.status).toBe(301);
    expect(redirect.headers.get("Cache-Control")).toBe("no-store");

    const miss = await app.request(`/files/${ASSET_ID}/nope.js`, { headers: auth });
    expect(miss.status).toBe(404);
    expect(miss.headers.get("Cache-Control")).toBe("no-store");
  });

  test("the thumbnail follows its asset", async () => {
    const { app, auth, storage } = await restrictedFixture();
    const webp = new TextEncoder().encode("RIFF");
    await storage.put(
      versionThumbKey(ASSET_ID, VERSION_ID, thumbnailFilename("md")),
      new ReadableStream({ start(c) { c.enqueue(webp); c.close(); } }),
      "image/webp",
      webp.byteLength,
    );
    expect((await app.request(`/files/${ASSET_ID}/_thumbs/md.webp`)).status).toBe(401);
    const thumb = await app.request(`/files/${ASSET_ID}/_thumbs/md.webp`, { headers: auth });
    expect(thumb.status).toBe(200);
    expect(thumb.headers.get("Cache-Control")).toBe("private, max-age=31536000, immutable");
    const missing = await app.request(`/files/${ASSET_ID}/_thumbs/sm.webp`, { headers: auth });
    expect(missing.status).toBe(404);
    expect(missing.headers.get("Cache-Control")).toBe("no-store");
  });
});

describe("a site host accepts no bearer", () => {
  test("a member's bearer is ignored and the challenge names ServeToken only", async () => {
    const { app, auth, spy } = await restrictedFixture();
    const host = `${ASSET_ID}${SUFFIX}`;
    const res = await app.request(`http://${host}/`, { headers: { Host: host, ...auth } });
    expectRefusal(res, 401);
    expect(res.headers.get("WWW-Authenticate")).toBe("ServeToken");
    expect(spy.bound()).toBe(0);
  });
});

describe("only a restricted read binds a caller", () => {
  test("a public read never enters the directory with the caller", async () => {
    const spy = spyTenancy();
    const f = await siteFixture({ deps: { tenancy: spy.tenancy } });
    spy.bind(f.members);
    const res = await f.app.request(`/files/${ASSET_ID}`, { headers: f.auth });
    expect(res.status).toBe(200);
    expect(spy.bound()).toBe(0);
  });

  test("a password read never enters the directory with the caller", async () => {
    const spy = spyTenancy();
    const f = await siteFixture({ deps: { tenancy: spy.tenancy } });
    spy.bind(f.members);
    await protect(f.metadata, ASSET_ID, "correct-horse-battery");
    expect((await f.app.request(`/files/${ASSET_ID}`, { headers: f.auth })).status).toBe(401);
    expect(spy.bound()).toBe(0);
  });
});

function patchAccess(app: { request: (url: string, init?: RequestInit) => Response | Promise<Response> }, auth: Record<string, string>, id: string, body: unknown) {
  return app.request(`/api/v1/assets/${id}`, {
    method: "PATCH",
    headers: { ...auth, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("PATCH /api/v1/assets/:id { access: restricted }", () => {
  test("an editor restricts a single-file asset without SIGNING_SECRET, and it takes effect", async () => {
    const { app, auth } = await siteFixture({ deps: { signingSecret: undefined } });
    const res = await patchAccess(app, auth, SINGLE_FILE_ID, { access: "restricted" });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { asset: { access?: string } }).asset.access).toBe("restricted");
    expect((await app.request(`/files/${SINGLE_FILE_ID}`)).status).toBe(401);
    expect((await app.request(`/files/${SINGLE_FILE_ID}`, { headers: auth })).status).toBe(200);

    expect((await patchAccess(app, auth, SINGLE_FILE_ID, { access: "public" })).status).toBe(200);
    expect((await app.request(`/files/${SINGLE_FILE_ID}`)).status).toBe(200);
  });

  test("a password beside restricted is refused by the schema", async () => {
    const { app, auth } = await siteFixture();
    const res = await patchAccess(app, auth, ASSET_ID, { access: "restricted", password: "correct-horse-battery" });
    expect(res.status).toBe(400);
  });

  test("a demo asset cannot be restricted", async () => {
    const { metadata } = await fixture();
    const demo = metadata.assets.get(SINGLE_FILE_ID)!;
    const result = await setAssetAccess(metadata, demo, { access: "restricted" }, { signingSecret: undefined });
    expect(result).toEqual({ ok: false, status: 400, error: "protection requires a project asset" });
    expect(metadata.assets.get(SINGLE_FILE_ID)?.access).toBeUndefined();
  });
});
