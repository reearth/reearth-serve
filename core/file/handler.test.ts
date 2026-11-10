import { describe, expect, test } from "vitest";
import {
  APP_JS, ASSET_ID, DOCS_HTML, fixture, INDEX_HTML, protect, seedEntry, seedNotFoundPage,
  SINGLE_FILE_ID, VERSION_ID,
} from "../../adapters/memory/fixture";
import { siteFixture, SUFFIX } from "../../adapters/memory/site-fixture";
import { versionThumbKey } from "../asset/usecase/shared";
import { thumbnailFilename } from "../thumbnail/sizes";
import { DEFAULT_CACHE_CONTROL, ENTRY_CACHE_CONTROL, PINNED_CACHE_CONTROL } from "./caching";

// Delivery semantics that static-site hosting depends on (ADR-013): index
// file resolution, directory redirects, and the cache/ETag policy. Everything
// runs against the in-memory adapters seeded by adapters/memory/fixture.ts.

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
    expect(res.headers.get("Location")).toBe(`/files/${ASSET_ID}/docs/?x=1`);
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

describe("nosniff and the inline allowlist (ADR-013 A4)", () => {
  test("every /files response sends X-Content-Type-Options: nosniff", async () => {
    const { app, storage, metadata } = await fixture();
    await seedNotFoundPage(storage);
    const thumb = new TextEncoder().encode("RIFF");
    await storage.put(
      versionThumbKey(ASSET_ID, VERSION_ID, thumbnailFilename("md")),
      new ReadableStream({ start(c) { c.enqueue(thumb); c.close(); } }),
      "image/webp",
      thumb.byteLength,
    );
    const etag = (await app.request(`/files/${ASSET_ID}/index.html`)).headers.get("ETag")!;

    const open = [
      ["file", await app.request(`/files/${ASSET_ID}/index.html`), 200],
      ["range", await app.request(`/files/${ASSET_ID}/index.html`, { headers: { Range: "bytes=0-4" } }), 206],
      ["304", await app.request(`/files/${ASSET_ID}/index.html`, { headers: { "If-None-Match": etag } }), 304],
      ["thumbnail", await app.request(`/files/${ASSET_ID}?thumb=md`), 200],
      ["missing thumbnail", await app.request(`/files/${SINGLE_FILE_ID}?thumb=md`), 404],
      ["invalid thumbnail", await app.request(`/files/${ASSET_ID}?thumb=huge`), 400],
      ["404 page", await app.request(`/files/${ASSET_ID}/nope.js`), 404],
      ["unknown asset", await app.request(`/files/0000000000000000/x`), 404],
      ["redirect", await app.request(`http://localhost/files/${ASSET_ID}/docs`), 301],
      ["preflight", await app.request(`/files/${ASSET_ID}`, { method: "OPTIONS" }), 204],
    ] as const;
    await protect(metadata, ASSET_ID, "correct-horse-battery");
    const wrong = { Authorization: `Basic ${btoa(":wrong-password")}`, "CF-Connecting-IP": "203.0.113.50" };
    for (let i = 0; i < 10; i++) await app.request(`/files/${ASSET_ID}`, { headers: wrong });
    const closed = [
      ["challenge", await app.request(`/files/${ASSET_ID}`), 401],
      ["password page", await app.request(`/files/${ASSET_ID}`, { headers: { Accept: "text/html" } }), 401],
      ["rate limited", await app.request(`/files/${ASSET_ID}`, { headers: wrong }), 429],
      ["form", await app.request(`/files/${ASSET_ID}/_serve/auth`, { method: "POST", body: "" }), 401],
    ] as const;
    const { app: noSecret, metadata: m2 } = await fixture({ signingSecret: undefined });
    await protect(m2, ASSET_ID, "correct-horse-battery");
    const failClosed = [["503", await noSecret.request(`/files/${ASSET_ID}`), 503]] as const;

    for (const [name, res, status] of [...open, ...closed, ...failClosed]) {
      expect(res.status, name).toBe(status);
      expect(res.headers.get("X-Content-Type-Options"), name).toBe("nosniff");
    }
  });

  test("on the apex, only listed types are inline; everything else downloads, sandboxed", async () => {
    const { app, storage } = await fixture();
    await seedEntry(storage, "notes.txt", "hi", "text/plain; charset=utf-8");
    await seedEntry(storage, "tile.png", "png", "IMAGE/PNG");
    await seedEntry(storage, "logo.svg", "<svg/>", "image/svg+xml");
    await seedEntry(storage, "doc.pdf", "%PDF", "application/pdf");
    await seedEntry(storage, "feed.xml", "<x/>", "application/xml");

    const inline = [`/files/${SINGLE_FILE_ID}/data.geojson`, `/files/${ASSET_ID}/notes.txt`, `/files/${ASSET_ID}/tile.png`];
    for (const path of inline) {
      const res = await app.request(path);
      expect(res.headers.get("Content-Disposition"), path).toMatch(/^inline; filename="/);
      expect(res.headers.get("Content-Security-Policy"), path).toBeNull();
    }
    const attached = ["index.html", "assets/app.js", "logo.svg", "doc.pdf", "feed.xml", "site.zip"];
    for (const name of attached) {
      const res = await app.request(`/files/${ASSET_ID}/${name}`);
      expect(res.headers.get("Content-Disposition"), name).toMatch(/^attachment; filename="/);
      expect(res.headers.get("Content-Security-Policy"), name).toBe("sandbox");
    }
    // The filename parameter is unchanged.
    expect((await app.request(`/files/${ASSET_ID}/index.html`)).headers.get("Content-Disposition"))
      .toBe('attachment; filename="index.html"');
  });

  test("the archive's 404 page downloads, sandboxed, on the apex", async () => {
    const { app, storage } = await fixture();
    await seedNotFoundPage(storage);
    const res = await app.request(`/files/${ASSET_ID}/nope.js`);
    expect(res.status).toBe(404);
    expect(res.headers.get("Content-Disposition")).toMatch(/^attachment/);
    expect(res.headers.get("Content-Security-Policy")).toBe("sandbox");
  });

  test("a site host stays inline, so its HTML renders", async () => {
    const { app } = await siteFixture();
    const host = `${ASSET_ID}${SUFFIX}`;
    const res = await app.request(`http://${host}/`, { headers: { Host: host } });
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Disposition")).toBe('inline; filename="index.html"');
    expect(res.headers.get("Content-Security-Policy")).toBeNull();
    expect(res.headers.get("X-Content-Type-Options")).toBe("nosniff");
  });
});
