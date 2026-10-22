import { describe, expect, test } from "vitest";
import {
  APP_JS, ASSET_ID, DOCS_HTML, fixture, INDEX_HTML, SINGLE_FILE_ID, VERSION_ID,
} from "../testing/fixture";
import { DEFAULT_CACHE_CONTROL, ENTRY_CACHE_CONTROL, PINNED_CACHE_CONTROL } from "./caching";

// Delivery semantics that static-site hosting depends on (ADR-013): index
// file resolution, directory redirects, and the cache/ETag policy. Everything
// runs against the in-memory adapters seeded by core/testing/fixture.ts.

describe("index file resolution", () => {
  test("GET /files/:id serves the archive's index.html", async () => {
    const { app } = await fixture();
    const res = await app.request(`/files/${ASSET_ID}`);
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("text/html; charset=utf-8");
    expect(await res.text()).toBe(INDEX_HTML);
  });

  test("a trailing slash resolves the directory's index.html", async () => {
    const { app } = await fixture();
    expect(await (await app.request(`/files/${ASSET_ID}/`)).text()).toBe(INDEX_HTML);
    expect(await (await app.request(`/files/${ASSET_ID}/docs/`)).text()).toBe(DOCS_HTML);
  });

  test("a directory without a trailing slash redirects to the slash form", async () => {
    const { app } = await fixture();
    const res = await app.request(`http://localhost/files/${ASSET_ID}/docs?x=1`);
    expect(res.status).toBe(301);
    expect(res.headers.get("Location")).toBe(`http://localhost/files/${ASSET_ID}/docs/?x=1`);
  });

  test("the archive itself is still reachable by its filename", async () => {
    const { app } = await fixture();
    const res = await app.request(`/files/${ASSET_ID}/site.zip`);
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("application/zip");
  });

  test("a missing entry is 404, not the index", async () => {
    const { app } = await fixture();
    expect((await app.request(`/files/${ASSET_ID}/nope.js`)).status).toBe(404);
    expect((await app.request(`/files/${ASSET_ID}/nope/`)).status).toBe(404);
  });

  test("GET /files/:id on a single-file asset serves the file", async () => {
    const { app, geojson } = await fixture();
    const bare = await app.request(`/files/${SINGLE_FILE_ID}`);
    expect(bare.status).toBe(200);
    expect(bare.headers.get("Content-Type")).toBe("application/geo+json");
    expect(await bare.text()).toBe(geojson);
    expect(await (await app.request(`/files/${SINGLE_FILE_ID}/data.geojson`)).text()).toBe(geojson);
  });

  test("HEAD returns headers and no body", async () => {
    const { app } = await fixture();
    const res = await app.request(`/files/${ASSET_ID}`, { method: "HEAD" });
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Length")).toBe(String(INDEX_HTML.length));
    expect(await res.text()).toBe("");
  });
});

describe("cache policy", () => {
  test("HTML at an asset URL is revalidated on every load", async () => {
    const { app } = await fixture();
    const res = await app.request(`/files/${ASSET_ID}/index.html`);
    expect(res.headers.get("Cache-Control")).toBe(ENTRY_CACHE_CONTROL);
    expect(res.headers.get("ETag")).toMatch(/^"[0-9a-f]{32}"$/);
  });

  test("other files at an asset URL are cacheable but not immutable", async () => {
    const { app } = await fixture();
    const res = await app.request(`/files/${ASSET_ID}/assets/app.js`, { headers: { "Accept-Encoding": "gzip" } });
    expect(res.headers.get("Cache-Control")).toBe(DEFAULT_CACHE_CONTROL);
    expect(res.headers.get("Content-Encoding")).toBe("gzip");
    expect(res.headers.get("Vary")).toBe("Accept-Encoding");
    // Untouched stored bytes → strong tag.
    expect(res.headers.get("ETag")).toMatch(/^"[0-9a-f]{32}"$/);
  });

  test("a version-pinned URL is immutable", async () => {
    const { app } = await fixture();
    const res = await app.request(`/files/${VERSION_ID}/index.html`);
    expect(res.status).toBe(200);
    expect(res.headers.get("Cache-Control")).toBe(PINNED_CACHE_CONTROL);
  });

  test("the path form of a pinned URL is not marked noindex", async () => {
    // Only a site host serves the same page under two hostnames (ADR-013 B4);
    // /files/{versionId}/… is the API form and stays indexable.
    const { app } = await fixture();
    const res = await app.request(`/files/${VERSION_ID}/index.html`);
    expect(res.headers.get("X-Robots-Tag")).toBeNull();
  });

  test("decoding gzip on the fly yields a weak ETag and the plain body", async () => {
    const { app } = await fixture();
    const res = await app.request(`/files/${ASSET_ID}/assets/app.js`, { headers: { "Accept-Encoding": "identity" } });
    expect(res.headers.get("Content-Encoding")).toBeNull();
    expect(res.headers.get("ETag")).toMatch(/^W\/"[0-9a-f]{32}"$/);
    expect(await res.text()).toBe(APP_JS);
  });

  test("If-None-Match with the current tag answers 304 without a body", async () => {
    const { app } = await fixture();
    const first = await app.request(`/files/${ASSET_ID}/index.html`);
    const etag = first.headers.get("ETag")!;
    const res = await app.request(`/files/${ASSET_ID}/index.html`, { headers: { "If-None-Match": etag } });
    expect(res.status).toBe(304);
    expect(res.headers.get("ETag")).toBe(etag);
    expect(res.headers.get("Cache-Control")).toBe(ENTRY_CACHE_CONTROL);
    expect(await res.text()).toBe("");
  });

  test("If-None-Match compares weakly across encodings", async () => {
    const { app } = await fixture();
    const strong = (await app.request(`/files/${ASSET_ID}/assets/app.js`, { headers: { "Accept-Encoding": "gzip" } })).headers.get("ETag")!;
    const res = await app.request(`/files/${ASSET_ID}/assets/app.js`, {
      headers: { "Accept-Encoding": "identity", "If-None-Match": strong },
    });
    expect(res.status).toBe(304);
  });

  test("a stale If-None-Match gets the full response", async () => {
    const { app } = await fixture();
    const res = await app.request(`/files/${ASSET_ID}/index.html`, { headers: { "If-None-Match": '"0000"' } });
    expect(res.status).toBe(200);
    expect(await res.text()).toBe(INDEX_HTML);
  });

  test("range requests keep Accept-Ranges and the ETag", async () => {
    const { app } = await fixture();
    const res = await app.request(`/files/${ASSET_ID}/index.html`, { headers: { Range: "bytes=0-4" } });
    expect(res.status).toBe(206);
    expect(res.headers.get("Content-Range")).toBe(`bytes 0-4/${INDEX_HTML.length}`);
    expect(res.headers.get("Accept-Ranges")).toBe("bytes");
    expect(res.headers.get("ETag")).toBeTruthy();
    expect(await res.text()).toBe("<!doc");
  });
});
