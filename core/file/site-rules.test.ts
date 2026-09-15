/**
 * `_headers` and `_redirects` in the delivery path (ADR-013 C3).
 *
 * The Node e2e runtime has no extraction container, so no archive there ever
 * contains a control file — the same reason C1 is covered here. These tests run
 * against the real app and the real file handler, with the parsed rules seeded
 * onto the version exactly as the extraction-completion hook would leave them.
 */
import { describe, expect, test } from "vitest";
import {
  APP_JS, ASSET_ID, INDEX_HTML, protect, seedEntry, seedHosting, seedNotFoundPage,
  VERSION_ID,
} from "../testing/fixture";
import { siteFixture, SUFFIX } from "../testing/site-fixture";
import { parseHeaders, parseRedirects, type SiteHosting } from "../site/rules";
import { ENTRY_CACHE_CONTROL } from "./caching";

const ABOUT_HTML = "<!doctype html><title>about</title>";

function hosting(opts: { headers?: string; redirects?: string }): SiteHosting {
  const h = parseHeaders(opts.headers ?? "");
  const r = parseRedirects(opts.redirects ?? "");
  return { headers: h.rules, redirects: r.rules, warnings: [...h.warnings, ...r.warnings] };
}

/** The seeded archive plus an `about.html`, with the given rules in force. */
async function rulesFixture(opts: { headers?: string; redirects?: string }) {
  const f = await siteFixture();
  await seedEntry(f.storage, "about.html", ABOUT_HTML);
  seedHosting(f.versions, hosting(opts));
  return f;
}

describe("_redirects", () => {
  test("a forced rule runs before the lookup and shadows a real file", async () => {
    const { app } = await rulesFixture({ redirects: "/about.html /about 301!" });
    const res = await app.request(`http://localhost/files/${ASSET_ID}/about.html`);
    expect(res.status).toBe(301);
    expect(res.headers.get("Location")).toBe(`/files/${ASSET_ID}/about`);
    expect(await res.text()).toBe("");
  });

  test("a plain rule is shadowed by the file that exists", async () => {
    const { app } = await rulesFixture({ redirects: "/about.html /elsewhere 301" });
    const res = await app.request(`http://localhost/files/${ASSET_ID}/about.html`);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe(ABOUT_HTML);
  });

  test("a plain rule fires once the lookup misses", async () => {
    const { app } = await rulesFixture({ redirects: "/old/* /about.html 302" });
    const res = await app.request(`http://localhost/files/${ASSET_ID}/old/page`);
    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toBe(`/files/${ASSET_ID}/about.html`);
  });

  test("the query string survives and the cache policy follows the status", async () => {
    const { app } = await rulesFixture({
      redirects: ["/moved /about.html 301", "/temp /about.html 302"].join("\n"),
    });
    const permanent = await app.request(`http://localhost/files/${ASSET_ID}/moved?a=1&b=2`);
    expect(permanent.headers.get("Location")).toBe(`/files/${ASSET_ID}/about.html?a=1&b=2`);
    expect(permanent.headers.get("Cache-Control")).toBe(ENTRY_CACHE_CONTROL);

    const temporary = await app.request(`http://localhost/files/${ASSET_ID}/temp`);
    expect(temporary.headers.get("Cache-Control")).toBe("no-store");
  });

  test("a 200 rule rewrites: the other file's bytes at the request URL", async () => {
    const { app } = await rulesFixture({ redirects: "/* /index.html 200" });
    const res = await app.request(`http://localhost/files/${ASSET_ID}/deep/route`);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe(INDEX_HTML);
    expect(res.headers.get("Location")).toBeNull();
    // Served by the normal path, so it keeps the ETag and the HTML policy.
    expect(res.headers.get("Cache-Control")).toBe(ENTRY_CACHE_CONTROL);
    expect(res.headers.get("ETag")).toMatch(/^"[0-9a-f]{32}"$/);
  });

  test("a rewrite that finds nothing still 404s rather than looping", async () => {
    const { app } = await rulesFixture({ redirects: "/* /nowhere.html 200" });
    const res = await app.request(`http://localhost/files/${ASSET_ID}/deep/route`);
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "File not found" });
  });

  test(":splat is substituted into the target", async () => {
    const { app } = await rulesFixture({ redirects: "/old/* /:splat 301" });
    const res = await app.request(`http://localhost/files/${ASSET_ID}/old/about.html`);
    expect(res.headers.get("Location")).toBe(`/files/${ASSET_ID}/about.html`);
  });

  test("rules are consulted before the directory probe, and only a miss reaches it", async () => {
    // A `/*` rewrite is more specific than "this might be a directory", so it
    // wins — the author asked for every miss to render the shell.
    const shadowed = await rulesFixture({ redirects: "/* /index.html 200" });
    const rewritten = await shadowed.app.request(`http://localhost/files/${ASSET_ID}/docs`);
    expect(rewritten.status).toBe(200);
    expect(await rewritten.text()).toBe(INDEX_HTML);

    // With no rule for that path, A1's directory redirect is unchanged.
    const plain = await rulesFixture({ redirects: "/nothing /elsewhere 301" });
    const res = await plain.app.request(`http://localhost/files/${ASSET_ID}/docs`);
    expect(res.status).toBe(301);
    expect(res.headers.get("Location")).toBe(`http://localhost/files/${ASSET_ID}/docs/`);
  });

  test("the site host gets a Location without the /files/{id} prefix", async () => {
    const { app } = await rulesFixture({ redirects: "/moved /about.html 301" });
    const host = `${ASSET_ID}${SUFFIX}`;
    const res = await app.request(`http://${host}/moved?q=1`, { headers: { Host: host } });
    expect(res.status).toBe(301);
    expect(res.headers.get("Location")).toBe("/about.html?q=1");
  });
});

describe("_headers", () => {
  const headers = [
    "/*",
    "  X-Frame-Options: DENY",
    "  Referrer-Policy: no-referrer",
    "/about.html",
    "  Content-Security-Policy: default-src 'self'",
  ].join("\n");

  test("rules land on a 200", async () => {
    const { app } = await rulesFixture({ headers });
    const res = await app.request(`http://localhost/files/${ASSET_ID}/about.html`);
    expect(res.status).toBe(200);
    expect(res.headers.get("X-Frame-Options")).toBe("DENY");
    expect(res.headers.get("Referrer-Policy")).toBe("no-referrer");
    expect(res.headers.get("Content-Security-Policy")).toBe("default-src 'self'");
  });

  test("and on a 304", async () => {
    const { app } = await rulesFixture({ headers });
    const first = await app.request(`http://localhost/files/${ASSET_ID}/about.html`);
    const etag = first.headers.get("ETag")!;
    const res = await app.request(`http://localhost/files/${ASSET_ID}/about.html`, {
      headers: { "If-None-Match": etag },
    });
    expect(res.status).toBe(304);
    expect(res.headers.get("X-Frame-Options")).toBe("DENY");
  });

  test("and on a 206", async () => {
    const { app } = await rulesFixture({ headers });
    const res = await app.request(`http://localhost/files/${ASSET_ID}/assets/app.js`, {
      headers: { Range: "bytes=0-9" },
    });
    expect(res.status).toBe(206);
    expect(res.headers.get("X-Frame-Options")).toBe("DENY");
  });

  test("and on the SPA fallback, matched against the requested route", async () => {
    const f = await siteFixture();
    await f.metadata.update(ASSET_ID, { spa: true });
    seedHosting(f.versions, hosting({ headers: "/app/*\n  X-Frame-Options: DENY" }));
    const res = await f.app.request(`http://localhost/files/${ASSET_ID}/app/deep`);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe(INDEX_HTML);
    expect(res.headers.get("X-Frame-Options")).toBe("DENY");
  });

  test("and on the archive's own 404.html", async () => {
    const f = await siteFixture();
    await seedNotFoundPage(f.storage);
    seedHosting(f.versions, hosting({ headers }));
    const res = await f.app.request(`http://localhost/files/${ASSET_ID}/missing`);
    expect(res.status).toBe(404);
    expect(res.headers.get("X-Frame-Options")).toBe("DENY");
    // The error page's own policy is untouched by the rule.
    expect(res.headers.get("Cache-Control")).toBe("no-store");
  });

  test("but not on the JSON 404", async () => {
    const { app } = await rulesFixture({ headers });
    const res = await app.request(`http://localhost/files/${ASSET_ID}/missing`);
    expect(res.status).toBe(404);
    expect(res.headers.get("X-Frame-Options")).toBeNull();
  });

  test("a denylisted header never reaches the response", async () => {
    // Seeded through the parser, which is where the denylist lives: the stored
    // rules simply cannot name Cache-Control.
    const parsed = hosting({ headers: "/*\n  Cache-Control: public, max-age=99999999\n  ETag: \"mine\"" });
    expect(parsed.warnings).toHaveLength(2);
    const f = await siteFixture();
    seedHosting(f.versions, parsed);
    const res = await f.app.request(`http://localhost/files/${ASSET_ID}/`);
    expect(res.headers.get("Cache-Control")).toBe(ENTRY_CACHE_CONTROL);
    expect(res.headers.get("ETag")).toMatch(/^"[0-9a-f]{32}"$/);
  });

  test("the handler wins: Vary, CORS and the preview noindex", async () => {
    const f = await siteFixture();
    seedHosting(f.versions, hosting({
      headers: [
        "/*",
        "  X-Robots-Tag: all",
        "  Vary: Nothing",
        "  Access-Control-Allow-Origin: https://evil.test",
      ].join("\n"),
    }));
    // A version-ID host is a pinned preview, so the handler sets noindex after
    // the rules have been applied.
    const host = `${VERSION_ID}${SUFFIX}`;
    const res = await f.app.request(`http://${host}/assets/app.js`, {
      headers: { Host: host, "Accept-Encoding": "gzip" },
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("X-Robots-Tag")).toBe("noindex");
    expect(res.headers.get("Vary")).toBe("Accept-Encoding");
    expect(res.headers.get("Access-Control-Allow-Origin")).toBe("*");
  });
});

describe("the control files themselves", () => {
  test("are never served", async () => {
    const { app, storage } = await rulesFixture({});
    await seedEntry(storage, "_headers", "/*\n  X-A: 1", "text/plain");
    await seedEntry(storage, "_redirects", "/a /b 301", "text/plain");
    for (const name of ["_headers", "_redirects"]) {
      const res = await app.request(`http://localhost/files/${ASSET_ID}/${name}`);
      expect(res.status).toBe(404);
      expect(await res.json()).toEqual({ error: "File not found" });
    }
  });

  test("are not served on a site host either", async () => {
    const { app, storage } = await rulesFixture({});
    await seedEntry(storage, "_headers", "/*\n  X-A: 1", "text/plain");
    const host = `${ASSET_ID}${SUFFIX}`;
    const res = await app.request(`http://${host}/_headers`, { headers: { Host: host } });
    expect(res.status).toBe(404);
  });
});

describe("interaction with the rest of delivery", () => {
  test("a protected site answers 401 before any rule is consulted", async () => {
    const f = await rulesFixture({ redirects: "/secret /about.html 301!" });
    await protect(f.metadata, ASSET_ID, "hunter22");
    const res = await f.app.request(`http://localhost/files/${ASSET_ID}/secret`);
    expect(res.status).toBe(401);
    expect(res.headers.get("Location")).toBeNull();
  });

  test("a version with no rules behaves exactly as before", async () => {
    const f = await siteFixture();
    await seedEntry(f.storage, "about.html", ABOUT_HTML);
    const res = await f.app.request(`http://localhost/files/${ASSET_ID}/about.html`);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe(ABOUT_HTML);
    expect(res.headers.get("X-Frame-Options")).toBeNull();
    const missing = await f.app.request(`http://localhost/files/${ASSET_ID}/_headers`);
    expect(missing.status).toBe(404);
  });

  test("a preview host uses the rules of the version it resolves to", async () => {
    const f = await rulesFixture({ headers: "/*\n  X-Frame-Options: DENY" });
    const host = `${VERSION_ID}${SUFFIX}`;
    const res = await f.app.request(`http://${host}/about.html`, { headers: { Host: host } });
    expect(res.status).toBe(200);
    expect(res.headers.get("X-Frame-Options")).toBe("DENY");
  });

  test("a single-file asset is untouched by rules on its asset row", async () => {
    const f = await siteFixture();
    // Forced onto the asset past the hook's archive-only rule, to prove the
    // handler does not depend on that rule.
    const single = f.metadata.assets.get("fedcba9876543210")!;
    f.metadata.assets.set(single.id, { ...single, hosting: hosting({ redirects: "/* /x 301!" }) });
    const res = await f.app.request(`http://localhost/files/${single.id}/anything`);
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("FeatureCollection");
  });
});

describe("gzip-stored entries keep working under rules", () => {
  test("passthrough is unaffected", async () => {
    const { app } = await rulesFixture({ headers: "/*\n  X-Frame-Options: DENY" });
    const res = await app.request(`http://localhost/files/${ASSET_ID}/assets/app.js`);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe(APP_JS);
    expect(res.headers.get("X-Frame-Options")).toBe("DENY");
  });
});
