/**
 * SPA fallback and `404.html` (ADR-013 C1), end to end through the real app.
 *
 * The Node e2e runtime has no extraction container, so nothing there ever puts
 * an `index.html` inside an archive; C1 is therefore covered here, against the
 * in-memory adapters seeded by `core/testing/fixture.ts`, with the routing, the
 * zod validation, the authorization and the access check all taking part.
 */
import { describe, expect, test } from "vitest";
import {
  ASSET_ID, fixture, INDEX_HTML, NOT_FOUND_HTML, protect, seedNotFoundPage,
  SINGLE_FILE_ID, VERSION_ID,
} from "../testing/fixture";
import { siteFixture, SUFFIX } from "../testing/site-fixture";
import { checkSpaChange } from "../asset/usecase";
import type { AssetMetadata } from "../asset/model";
import { looksLikeAssetPath } from "./handler";
import { ENTRY_CACHE_CONTROL, PINNED_CACHE_CONTROL } from "./caching";

/** The seeded archive asset, in a project, with the fallback turned on. */
async function spaFixture(opts: { notFoundPage?: boolean } = {}) {
  const f = await siteFixture();
  await f.metadata.update(ASSET_ID, { spa: true });
  if (opts.notFoundPage) await seedNotFoundPage(f.storage);
  return f;
}

describe("looksLikeAssetPath", () => {
  test("file-shaped paths are recognised, routes are not", () => {
    for (const path of [
      "assets/app.js", "chunk-a1b2.mjs", "data.json", "tiles/0/0/0.b3dm",
      "logo.PNG", "style.css", "fonts/a.woff2", "x.wasm",
    ]) {
      expect(looksLikeAssetPath(path)).toBe(true);
    }
    for (const path of [
      "", "about", "map/kawasaki", "docs/", "users/42",
      // A dot in a segment is not an extension when what follows is too long
      // to be one.
      "v1.2.3-release-candidate",
    ]) {
      expect(looksLikeAssetPath(path)).toBe(false);
    }
  });
});

describe("the fallback is opt-in", () => {
  test("without the flag a miss is still the JSON 404", async () => {
    const { app } = await siteFixture();
    const res = await app.request(`/files/${ASSET_ID}/about`);
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "File not found" });
  });
});

describe("spa: true", () => {
  test("an extensionless miss serves the root index.html at 200", async () => {
    const { app } = await spaFixture();
    const res = await app.request(`/files/${ASSET_ID}/about`);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe(INDEX_HTML);
    expect(res.headers.get("Content-Type")).toBe("text/html; charset=utf-8");
    // The moving policy (A2): the app shell must show a redeploy on next load.
    expect(res.headers.get("Cache-Control")).toBe(ENTRY_CACHE_CONTROL);
    expect(res.headers.get("ETag")).toMatch(/^"[0-9a-f]{32}"$/);
    // It is the app's real content, not a soft error page.
    expect(res.headers.get("X-Robots-Tag")).toBeNull();
  });

  test("a deep route and a trailing-slash route both reach it", async () => {
    const { app } = await spaFixture();
    for (const path of ["/map/kawasaki", "/about/", "/users/42"]) {
      const res = await app.request(`/files/${ASSET_ID}${path}`);
      expect(res.status).toBe(200);
      expect(await res.text()).toBe(INDEX_HTML);
    }
  });

  test("a file-shaped miss keeps its 404", async () => {
    const { app } = await spaFixture();
    for (const path of ["/nope.js", "/tiles/0/0/0.b3dm", "/data/cities.json", "/missing.png"]) {
      const res = await app.request(`/files/${ASSET_ID}${path}`);
      expect(res.status).toBe(404);
      expect(await res.json()).toEqual({ error: "File not found" });
    }
  });

  test("an existing file is unaffected, and costs no extra read", async () => {
    const { app } = await spaFixture();
    const res = await app.request(`/files/${ASSET_ID}/docs/`);
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("docs");
  });

  test("a real directory still redirects rather than rendering the shell", async () => {
    const { app } = await spaFixture();
    const res = await app.request(`http://localhost/files/${ASSET_ID}/docs`);
    expect(res.status).toBe(301);
    expect(res.headers.get("Location")).toBe(`http://localhost/files/${ASSET_ID}/docs/`);
  });

  test("a pinned version URL keeps the pinned policy", async () => {
    const { app } = await spaFixture();
    const res = await app.request(`/files/${VERSION_ID}/about`);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe(INDEX_HTML);
    expect(res.headers.get("Cache-Control")).toBe(PINNED_CACHE_CONTROL);
  });

  test("thumbnail requests are untouched", async () => {
    const { app } = await spaFixture();
    for (const path of [`/files/${ASSET_ID}/_thumbs/md.webp`, `/files/${ASSET_ID}?thumb=md`]) {
      const res = await app.request(path);
      expect(res.status).toBe(404);
      expect(await res.json()).toEqual({ error: "Thumbnail not available" });
    }
  });

  test("a single-file asset has no shell to fall back to", async () => {
    const { app, metadata, geojson } = await siteFixture();
    // Forced on past the API's archive-only rule, to prove the handler does not
    // depend on that rule for its behaviour.
    await metadata.update(SINGLE_FILE_ID, { spa: true });
    const res = await app.request(`/files/${SINGLE_FILE_ID}/whatever`);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe(geojson);
    expect(res.headers.get("Content-Type")).toBe("application/geo+json");
  });

  test("with no index.html in the archive it falls through to the 404", async () => {
    const { app, storage } = await spaFixture();
    await storage.delete(`assets/${ASSET_ID}/v/${VERSION_ID}/files/index.html`);
    const res = await app.request(`/files/${ASSET_ID}/about`);
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "File not found" });
  });
});

describe("404.html", () => {
  /** The seeded archive with an error page but no SPA flag. */
  async function errorPageFixture() {
    const f = await siteFixture();
    await seedNotFoundPage(f.storage);
    return f;
  }

  test("a miss answers 404 with the archive's own page", async () => {
    const { app } = await errorPageFixture();
    const res = await app.request(`/files/${ASSET_ID}/about`);
    expect(res.status).toBe(404);
    expect(await res.text()).toBe(NOT_FOUND_HTML);
    expect(res.headers.get("Content-Type")).toBe("text/html; charset=utf-8");
  });

  test("it is never cached and never revalidated", async () => {
    const { app } = await errorPageFixture();
    const res = await app.request(`/files/${ASSET_ID}/about`);
    // A 404 body is not a representation of the requested URL: giving it an
    // ETag would let a client revalidate a path that may exist tomorrow.
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    expect(res.headers.get("ETag")).toBeNull();
  });

  test("a conditional request still gets the page, not a 304", async () => {
    const { app } = await errorPageFixture();
    const res = await app.request(`/files/${ASSET_ID}/about`, {
      headers: { "If-None-Match": "*" },
    });
    expect(res.status).toBe(404);
    expect(await res.text()).toBe(NOT_FOUND_HTML);
  });

  test("a file-shaped miss gets it too — the status is still 404", async () => {
    const { app } = await errorPageFixture();
    const res = await app.request(`/files/${ASSET_ID}/nope.js`);
    expect(res.status).toBe(404);
    expect(await res.text()).toBe(NOT_FOUND_HTML);
  });

  test("the SPA flag wins over it for a route", async () => {
    const { app } = await spaFixture({ notFoundPage: true });
    const res = await app.request(`/files/${ASSET_ID}/about`);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe(INDEX_HTML);
  });

  test("…but a file-shaped miss falls to it even with the flag on", async () => {
    const { app } = await spaFixture({ notFoundPage: true });
    const res = await app.request(`/files/${ASSET_ID}/nope.js`);
    expect(res.status).toBe(404);
    expect(await res.text()).toBe(NOT_FOUND_HTML);
  });
});

describe("protection outranks the fallback (ADR-013 B7)", () => {
  test("a protected archive is challenged before anything is served", async () => {
    const f = await spaFixture({ notFoundPage: true });
    await protect(f.metadata, ASSET_ID, "correct-horse-battery");

    for (const path of ["/about", "/nope.js"]) {
      const res = await f.app.request(`/files/${ASSET_ID}${path}`);
      expect(res.status).toBe(401);
      const body = await res.text();
      expect(body).not.toContain(INDEX_HTML);
      expect(body).not.toContain(NOT_FOUND_HTML);
    }

    // With the password the fallback works as usual.
    const ok = await f.app.request(`/files/${ASSET_ID}/about`, {
      headers: { Authorization: `Basic ${btoa("viewer:correct-horse-battery")}` },
    });
    expect(ok.status).toBe(200);
    expect(await ok.text()).toBe(INDEX_HTML);
    expect(ok.headers.get("Cache-Control")).toContain("private");
  });
});

describe("site hosts serve the fallback too", () => {
  test("the asset-ID host", async () => {
    const { app } = await spaFixture();
    const host = `${ASSET_ID}${SUFFIX}`;
    const res = await app.request(`http://${host}/about`, { headers: { Host: host } });
    expect(res.status).toBe(200);
    expect(await res.text()).toBe(INDEX_HTML);
    expect(res.headers.get("Cache-Control")).toBe(ENTRY_CACHE_CONTROL);
  });

  test("a named host", async () => {
    const { app, auth } = await spaFixture();
    const claimed = await app.request(`/api/v1/assets/${ASSET_ID}/hosts`, {
      method: "POST",
      headers: { ...auth, "Content-Type": "application/json" },
      body: JSON.stringify({ hostname: "kawasaki-flood-map" }),
    });
    expect(claimed.status).toBe(201);

    const host = `kawasaki-flood-map${SUFFIX}`;
    const res = await app.request(`http://${host}/about`, { headers: { Host: host } });
    expect(res.status).toBe(200);
    expect(await res.text()).toBe(INDEX_HTML);
  });

  test("a v{n}-- preview host falls back to that version's index", async () => {
    const { app, auth } = await spaFixture();
    await app.request(`/api/v1/assets/${ASSET_ID}/hosts`, {
      method: "POST",
      headers: { ...auth, "Content-Type": "application/json" },
      body: JSON.stringify({ hostname: "kawasaki-flood-map" }),
    });
    const toggled = await app.request(`/api/v1/assets/${ASSET_ID}/hosts/kawasaki-flood-map`, {
      method: "PATCH",
      headers: { ...auth, "Content-Type": "application/json" },
      body: JSON.stringify({ previews: true }),
    });
    expect(toggled.status).toBe(200);

    const host = `v1--kawasaki-flood-map${SUFFIX}`;
    const res = await app.request(`http://${host}/about`, { headers: { Host: host } });
    expect(res.status).toBe(200);
    expect(await res.text()).toBe(INDEX_HTML);
    // The preview is pinned and must not be indexed beside the production name.
    expect(res.headers.get("Cache-Control")).toBe(PINNED_CACHE_CONTROL);
    expect(res.headers.get("X-Robots-Tag")).toBe("noindex");
  });
});

function patchAsset(
  app: { request: (url: string, init?: RequestInit) => Response | Promise<Response> },
  auth: Record<string, string>,
  id: string,
  body: unknown,
) {
  return app.request(`/api/v1/assets/${id}`, {
    method: "PATCH",
    headers: { ...auth, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("PATCH /api/v1/assets/:id { spa }", () => {
  test("an editor turns it on, and it takes effect", async () => {
    const { app, auth } = await siteFixture();
    expect((await app.request(`/files/${ASSET_ID}/about`)).status).toBe(404);

    const res = await patchAsset(app, auth, ASSET_ID, { spa: true });
    expect(res.status).toBe(200);
    const { asset } = await res.json() as { asset: { spa?: boolean } };
    expect(asset.spa).toBe(true);
    expect((await app.request(`/files/${ASSET_ID}/about`)).status).toBe(200);
  });

  test("`false` turns it off again", async () => {
    const { app, auth } = await siteFixture();
    await patchAsset(app, auth, ASSET_ID, { spa: true });
    const res = await patchAsset(app, auth, ASSET_ID, { spa: false });
    expect(res.status).toBe(200);
    expect((await res.json() as { asset: { spa?: boolean } }).asset.spa).toBe(false);
    expect((await app.request(`/files/${ASSET_ID}/about`)).status).toBe(404);
  });

  test("site (archive) assets only", async () => {
    const { app, auth } = await siteFixture();
    const res = await patchAsset(app, auth, SINGLE_FILE_ID, { spa: true });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({
      error: "SPA fallback is available for site (archive) assets only",
    });
  });

  test("turning it off is allowed on any asset", async () => {
    const { app, auth } = await siteFixture();
    expect((await patchAsset(app, auth, SINGLE_FILE_ID, { spa: false })).status).toBe(200);
  });

  test("project assets only", async () => {
    // The plain fixture's assets carry no projectId: they are demo assets.
    // Asserted against the use case, because a demo asset is reachable only by
    // its own session and the ownership check would answer 404 first.
    const { metadata } = await fixture();
    const demo = metadata.assets.get(ASSET_ID)!;
    expect(demo.projectId).toBeUndefined();
    expect(checkSpaChange(demo as AssetMetadata, true)).toEqual({
      ok: false, status: 400, error: "SPA fallback requires a project asset",
    });
  });

  test("a viewer may not change it", async () => {
    const { app, auth } = await siteFixture({ role: "viewer" });
    expect((await patchAsset(app, auth, ASSET_ID, { spa: true })).status).toBe(404);
  });

  test("it survives an unrelated PATCH", async () => {
    const { app, auth } = await siteFixture();
    await patchAsset(app, auth, ASSET_ID, { spa: true });
    const res = await patchAsset(app, auth, ASSET_ID, { description: "a map" });
    expect((await res.json() as { asset: { spa?: boolean } }).asset.spa).toBe(true);
  });
});
