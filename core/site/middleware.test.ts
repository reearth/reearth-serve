import { describe, expect, test } from "vitest";
import {
  APP_JS, ASSET_ID, DOCS_HTML, fixture, INDEX_HTML, SINGLE_FILE_ID, VERSION_ID,
} from "../testing/fixture";
import { ENTRY_CACHE_CONTROL, PINNED_CACHE_CONTROL } from "../file/caching";

// Per-asset origins (ADR-013 B1): `{id}{SITE_HOST_SUFFIX}` serves exactly what
// `/files/{id}` serves, and a site host reaches nothing else in the app.

const SUFFIX = ".serve.example.test";

/** A request to a site host: only the Host header distinguishes it. */
function site(label: string, path = "/", init?: RequestInit): [string, RequestInit] {
  return [
    `http://${label}${SUFFIX}${path}`,
    { ...init, headers: { ...init?.headers, Host: `${label}${SUFFIX}` } },
  ];
}

describe("site hosts off", () => {
  test("an unset suffix leaves every request untouched", async () => {
    const { app } = await fixture();
    const res = await app.request(...site(ASSET_ID));
    // No site-host rewrite: "/" is not a route of this app.
    expect(res.status).toBe(404);
    expect(await (await app.request("/api/v1/health")).json()).toMatchObject({ ok: true });
  });
});

describe("site hosts on", () => {
  const on = () => fixture({ siteHostSuffix: SUFFIX });

  test("the apex host is unaffected", async () => {
    const { app } = await on();
    const health = await app.request("http://serve.example.test/api/v1/health", {
      headers: { Host: "serve.example.test" },
    });
    expect(health.status).toBe(200);
    expect(await health.json()).toMatchObject({ ok: true });

    const file = await app.request(`http://serve.example.test/files/${ASSET_ID}/`, {
      headers: { Host: "serve.example.test" },
    });
    expect(await file.text()).toBe(INDEX_HTML);
  });

  test("an asset-ID host serves the archive's index.html at /", async () => {
    const { app } = await on();
    const res = await app.request(...site(ASSET_ID));
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("text/html; charset=utf-8");
    expect(res.headers.get("Cache-Control")).toBe(ENTRY_CACHE_CONTROL);
    // Following the asset, not a pinned version: nothing to de-index.
    expect(res.headers.get("X-Robots-Tag")).toBeNull();
    expect(await res.text()).toBe(INDEX_HTML);
  });

  test("root-relative and nested paths resolve inside the asset", async () => {
    const { app } = await on();
    expect(await (await app.request(...site(ASSET_ID, "/docs/"))).text()).toBe(DOCS_HTML);

    const js = await app.request(...site(ASSET_ID, "/assets/app.js", {
      headers: { "Accept-Encoding": "identity" },
    }));
    expect(js.status).toBe(200);
    expect(await js.text()).toBe(APP_JS);
  });

  test("the query string survives the rewrite", async () => {
    const { app } = await on();
    const res = await app.request(...site(ASSET_ID, "/docs?x=1"));
    expect(res.status).toBe(301);
    expect(res.headers.get("Location")).toBe(`http://${ASSET_ID}${SUFFIX}/docs/?x=1`);
  });

  test("HEAD works on a site host", async () => {
    const { app } = await on();
    const res = await app.request(...site(ASSET_ID, "/", { method: "HEAD" }));
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Length")).toBe(String(INDEX_HTML.length));
    expect(await res.text()).toBe("");
  });

  test("a version-ID host is pinned and noindex", async () => {
    const { app } = await on();
    const res = await app.request(...site(VERSION_ID));
    expect(res.status).toBe(200);
    expect(await res.text()).toBe(INDEX_HTML);
    expect(res.headers.get("Cache-Control")).toBe(PINNED_CACHE_CONTROL);
    // The same page is served by the asset-ID host; only one should be
    // indexed (ADR-013 B4).
    expect(res.headers.get("X-Robots-Tag")).toBe("noindex");
  });

  test("a label that is not ID-shaped is a plain-text 404", async () => {
    const { app } = await on();
    // B2 will resolve names like this one from the site_hosts table.
    const res = await app.request(...site("kawasaki-flood-map"));
    expect(res.status).toBe(404);
    expect(res.headers.get("Content-Type")).toContain("text/plain");
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    expect(await res.text()).toBe("Not found");
  });

  test("an unknown but ID-shaped label 404s from the file handler", async () => {
    const { app } = await on();
    const res = await app.request(...site("00000000deadbeef"));
    expect(res.status).toBe(404);
  });

  test("a multi-label host is not a site host", async () => {
    // The wildcard certificate covers one level, so `a.b.serve…` cannot be
    // served and must not be mistaken for a site host either.
    const { app } = await on();
    const res = await app.request(`http://a.${ASSET_ID}${SUFFIX}/`, {
      headers: { Host: `a.${ASSET_ID}${SUFFIX}` },
    });
    expect(res.status).toBe(404);
    // The app's own 404, not the site middleware's.
    expect(await res.text()).not.toBe("Not found");
  });

  test("the API is not reachable on a site host", async () => {
    const { app } = await on();
    // /api/v1/health is a file lookup for "api/v1/health" inside the archive.
    const health = await app.request(...site(ASSET_ID, "/api/v1/health"));
    expect(health.status).toBe(404);
    expect(await health.json()).toEqual({ error: "File not found" });

    const docs = await app.request(...site(ASSET_ID, "/api/v1/doc"));
    expect(docs.status).toBe(404);
  });

  test("a site host cannot reach another asset through /files", async () => {
    const { app } = await on();
    // Rewritten to /files/{ASSET_ID}/files/{SINGLE_FILE_ID}/data.geojson —
    // an entry that does not exist in this archive.
    const res = await app.request(...site(ASSET_ID, `/files/${SINGLE_FILE_ID}/data.geojson`));
    expect(res.status).toBe(404);
  });

  test("no anonymous session is minted for a hosted page", async () => {
    const { app, deps } = await on();
    const sessions = deps.sessions as unknown as { sessions: Map<string, unknown> };
    const res = await app.request(...site(ASSET_ID));
    expect(res.headers.get("X-Session-Id")).toBeNull();
    expect(sessions.sessions.size).toBe(0);
  });

  test("a suffix with a port matches the Host header including the port", async () => {
    const { app } = await fixture({ siteHostSuffix: ".localhost:8788" });
    const res = await app.request(`http://${ASSET_ID}.localhost:8788/`, {
      headers: { Host: `${ASSET_ID}.localhost:8788` },
    });
    expect(res.status).toBe(200);
    expect(await res.text()).toBe(INDEX_HTML);

    // The apex, same suffix minus the label, still serves the API.
    const health = await app.request("http://localhost:8788/api/v1/health", {
      headers: { Host: "localhost:8788" },
    });
    expect(health.status).toBe(200);
  });

  test("the Host header is matched case-insensitively", async () => {
    const { app } = await on();
    const host = `${ASSET_ID}${SUFFIX}`.toUpperCase();
    const res = await app.request(`http://${host}/`, { headers: { Host: host } });
    expect(res.status).toBe(200);
    expect(await res.text()).toBe(INDEX_HTML);
  });

  test("a single-file asset is served at / on its own host", async () => {
    const { app, geojson } = await on();
    const res = await app.request(...site(SINGLE_FILE_ID));
    expect(res.status).toBe(200);
    expect(await res.text()).toBe(geojson);
  });

  test("a malformed suffix fails at startup rather than silently disabling", async () => {
    await expect(fixture({ siteHostSuffix: "serve.example.test" })).rejects.toThrow(
      /must start with/,
    );
  });
});
