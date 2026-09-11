/**
 * Password-protected sites end to end through the real app (ADR-013 B7):
 * the check in the file handler, the challenge, the form endpoint, the cookie,
 * the rate limiter, the caching and CORS changes, and the PATCH that turns it
 * on.
 *
 * Everything runs against the in-memory adapters from `core/testing/`, so the
 * routing, the zod validation, the authorization and the stores all take part.
 */
import { describe, expect, test } from "vitest";
import {
  ASSET_ID, fixture, INDEX_HTML, protect, SINGLE_FILE_ID, TEST_ITERATIONS, VERSION_ID,
} from "../testing/fixture";
import { siteFixture, SUFFIX } from "../testing/site-fixture";
import { setAssetAccess } from "../asset/usecase";
import { AUTH_COOKIE } from "./cookie";
import { RATE_LIMIT_PER_IP } from "./ratelimit";

const PASSWORD = "correct-horse-battery";
const BROWSER = { Accept: "text/html,application/xhtml+xml" };

function basic(password: string): Record<string, string> {
  return { Authorization: `Basic ${btoa(`viewer:${password}`)}` };
}

/** A protected archive asset, reachable both by path and on its site host. */
async function protectedFixture() {
  const f = await siteFixture();
  await protect(f.metadata, ASSET_ID, PASSWORD);
  return f;
}

/** Any app the fixtures hand back; `request` is all these helpers need. */
type TestApp = { request: (url: string, init?: RequestInit) => Response | Promise<Response> };

/** Submit the password form. */
function submit(
  app: TestApp,
  path: string,
  body: Record<string, string>,
  headers: Record<string, string> = {},
) {
  return app.request(path, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", ...headers },
    body: new URLSearchParams(body).toString(),
  });
}

/** The `rs_site_auth` value out of a `Set-Cookie` header. */
function cookieFrom(res: Response): string {
  const header = res.headers.get("Set-Cookie") ?? "";
  const match = header.match(new RegExp(`${AUTH_COOKIE}=([^;]+)`));
  if (!match) throw new Error(`no ${AUTH_COOKIE} in "${header}"`);
  return `${AUTH_COOKIE}=${match[1]}`;
}

describe("a public asset pays nothing", () => {
  test("no password material is ever read for it", async () => {
    const { app, metadata } = await fixture();
    const res = await app.request(`/files/${ASSET_ID}`);
    expect(res.status).toBe(200);
    // The whole point of `resolveAccess`: the common path takes no extra I/O.
    expect(metadata.protectionCalls).toBe(0);
    expect(res.headers.get("Cache-Control")).not.toContain("private");
    expect(res.headers.get("Access-Control-Allow-Origin")).toBe("*");
    expect(res.headers.get("Vary") ?? "").not.toContain("Cookie");
  });

  test("it still serves without SIGNING_SECRET configured", async () => {
    const { app } = await fixture({ signingSecret: undefined });
    expect((await app.request(`/files/${ASSET_ID}`)).status).toBe(200);
  });
});

describe("the challenge", () => {
  test("a browser navigation gets the form, and no native dialog", async () => {
    const { app } = await protectedFixture();
    const res = await app.request(`/files/${ASSET_ID}`, { headers: BROWSER });
    expect(res.status).toBe(401);
    expect(res.headers.get("Content-Type")).toContain("text/html");
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    expect(res.headers.get("X-Robots-Tag")).toBe("noindex");
    // Omitted on purpose: with it the browser stacks its own credential prompt
    // on top of the page.
    expect(res.headers.get("WWW-Authenticate")).toBeNull();
    const html = await res.text();
    expect(html).toContain(`action="/files/${ASSET_ID}/_serve/auth"`);
    expect(html).toContain('type="password"');
    expect(html).toContain(`value="/files/${ASSET_ID}"`);
    // The bytes are not in it.
    expect(html).not.toContain(INDEX_HTML);
  });

  test("everything else gets JSON and WWW-Authenticate", async () => {
    const { app } = await protectedFixture();
    const res = await app.request(`/files/${ASSET_ID}`);
    expect(res.status).toBe(401);
    expect(res.headers.get("WWW-Authenticate")).toBe('Basic realm="reearth-serve", charset="UTF-8"');
    expect(await res.json()).toEqual({ error: "authentication required" });
  });

  test("401, not 404: protection hides the bytes, not the existence", async () => {
    const { app } = await protectedFixture();
    expect((await app.request(`/files/${ASSET_ID}/nope.js`)).status).toBe(401);
  });

  test("no password material leaks into the challenge", async () => {
    const { app } = await protectedFixture();
    const html = await (await app.request(`/files/${ASSET_ID}`, { headers: BROWSER })).text();
    expect(html).not.toContain("pbkdf2");
  });
});

describe("Authorization: Basic", () => {
  test("the right password serves the file, private and credentialed", async () => {
    const { app } = await protectedFixture();
    const res = await app.request(`/files/${ASSET_ID}`, {
      headers: { ...basic(PASSWORD), Origin: "https://viewer.example" },
    });
    expect(res.status).toBe(200);
    expect(await res.text()).toBe(INDEX_HTML);
    // A2's policy, plus `private` (ADR-013 B7).
    expect(res.headers.get("Cache-Control")).toBe("private, max-age=0, must-revalidate");
    // `*` cannot be combined with credentials, so the origin is echoed.
    expect(res.headers.get("Access-Control-Allow-Origin")).toBe("https://viewer.example");
    expect(res.headers.get("Access-Control-Allow-Credentials")).toBe("true");
    const vary = res.headers.get("Vary") ?? "";
    expect(vary).toContain("Cookie");
    expect(vary).toContain("Authorization");
    expect(vary).toContain("Origin");
  });

  test("a non-HTML file keeps its one-hour lifetime, privately", async () => {
    const { app } = await protectedFixture();
    const res = await app.request(`/files/${ASSET_ID}/assets/app.js`, {
      headers: { ...basic(PASSWORD), "Accept-Encoding": "gzip" },
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("Cache-Control")).toBe("private, max-age=3600");
    // The gzip `Vary` survives the merge rather than being overwritten.
    const vary = res.headers.get("Vary") ?? "";
    expect(vary).toContain("Accept-Encoding");
    expect(vary).toContain("Cookie");
  });

  test("the wrong password is another 401", async () => {
    const { app } = await protectedFixture();
    const res = await app.request(`/files/${ASSET_ID}`, { headers: basic("wrong-password") });
    expect(res.status).toBe(401);
  });

  test(`${RATE_LIMIT_PER_IP} wrong passwords from one IP, then 429`, async () => {
    const { app } = await protectedFixture();
    const headers = { ...basic("wrong-password"), "CF-Connecting-IP": "203.0.113.7" };
    for (let i = 0; i < RATE_LIMIT_PER_IP; i++) {
      expect((await app.request(`/files/${ASSET_ID}`, { headers })).status).toBe(401);
    }
    const res = await app.request(`/files/${ASSET_ID}`, { headers });
    expect(res.status).toBe(429);
    expect(Number(res.headers.get("Retry-After"))).toBeGreaterThan(0);
    // Even the correct password waits out the window: the limiter is what
    // makes a low-entropy shared secret safe.
    const right = await app.request(`/files/${ASSET_ID}`, {
      headers: { ...basic(PASSWORD), "CF-Connecting-IP": "203.0.113.7" },
    });
    expect(right.status).toBe(429);
    // Another visitor is unaffected.
    const other = await app.request(`/files/${ASSET_ID}`, {
      headers: { ...basic(PASSWORD), "CF-Connecting-IP": "198.51.100.4" },
    });
    expect(other.status).toBe(200);
  });
});

describe("the password form", () => {
  test("the right password sets the cookie and 303s to `next`", async () => {
    const { app } = await protectedFixture();
    const res = await submit(app, `/files/${ASSET_ID}/_serve/auth`, {
      password: PASSWORD,
      next: `/files/${ASSET_ID}/docs/`,
    });
    expect(res.status).toBe(303);
    expect(res.headers.get("Location")).toBe(`/files/${ASSET_ID}/docs/`);
    const setCookie = res.headers.get("Set-Cookie") ?? "";
    expect(setCookie).toContain(`${AUTH_COOKIE}=`);
    expect(setCookie).toContain("HttpOnly");
    expect(setCookie).toContain("SameSite=Lax");
    // On the apex the cookie is scoped to the asset's own file prefix.
    expect(setCookie).toContain(`Path=/files/${ASSET_ID}`);
    expect(res.headers.get("Cache-Control")).toBe("no-store");
  });

  test("the cookie then serves the files", async () => {
    const { app } = await protectedFixture();
    const cookie = cookieFrom(
      await submit(app, `/files/${ASSET_ID}/_serve/auth`, { password: PASSWORD, next: "/" }),
    );
    const res = await app.request(`/files/${ASSET_ID}`, { headers: { Cookie: cookie } });
    expect(res.status).toBe(200);
    expect(await res.text()).toBe(INDEX_HTML);
  });

  test("changing the password rejects the old cookie", async () => {
    const { app, metadata } = await protectedFixture();
    const cookie = cookieFrom(
      await submit(app, `/files/${ASSET_ID}/_serve/auth`, { password: PASSWORD, next: "/" }),
    );
    expect((await app.request(`/files/${ASSET_ID}`, { headers: { Cookie: cookie } })).status).toBe(200);

    await protect(metadata, ASSET_ID, "a-brand-new-password");
    expect((await app.request(`/files/${ASSET_ID}`, { headers: { Cookie: cookie } })).status).toBe(401);
  });

  test("the wrong password re-renders the form with an error, 401", async () => {
    const { app } = await protectedFixture();
    const res = await submit(app, `/files/${ASSET_ID}/_serve/auth`, {
      password: "nope",
      next: "/",
    });
    expect(res.status).toBe(401);
    expect(res.headers.get("Set-Cookie")).toBeNull();
    const html = await res.text();
    expect(html).toContain("Wrong password");
    expect(html).toContain('type="password"');
  });

  test("an off-origin `next` is refused", async () => {
    const { app } = await protectedFixture();
    for (const next of ["https://evil.example/", "//evil.example/", "/\\evil.example"]) {
      const res = await submit(app, `/files/${ASSET_ID}/_serve/auth`, { password: PASSWORD, next });
      expect(res.status).toBe(303);
      expect(res.headers.get("Location")).toBe(`/files/${ASSET_ID}/`);
    }
  });

  test("failed submits are rate limited too", async () => {
    const { app } = await protectedFixture();
    const headers = { "CF-Connecting-IP": "203.0.113.9" };
    for (let i = 0; i < RATE_LIMIT_PER_IP; i++) {
      const res = await submit(app, `/files/${ASSET_ID}/_serve/auth`, { password: "nope" }, headers);
      expect(res.status).toBe(401);
    }
    const res = await submit(app, `/files/${ASSET_ID}/_serve/auth`, { password: PASSWORD }, headers);
    expect(res.status).toBe(429);
    expect(res.headers.get("Retry-After")).not.toBeNull();
  });

  test("there is no auth endpoint on a public asset", async () => {
    const { app } = await siteFixture();
    const res = await submit(app, `/files/${ASSET_ID}/_serve/auth`, { password: PASSWORD });
    expect(res.status).toBe(404);
  });

  test("an archive entry named _serve/auth cannot shadow the endpoint", async () => {
    const { app, storage, metadata } = await protectedFixture();
    // A real file at exactly that path inside the archive.
    await storage.put(
      `assets/${ASSET_ID}/v/${VERSION_ID}/files/_serve/auth`,
      new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode("gotcha")); c.close(); } }),
      "text/plain",
      6,
    );
    const res = await submit(app, `/files/${ASSET_ID}/_serve/auth`, { password: PASSWORD, next: "/" });
    // The POST route wins: the file is only ever reachable on GET.
    expect(res.status).toBe(303);
    expect(metadata.protectionCalls).toBeGreaterThan(0);
  });
});

describe("every URL form obeys the check", () => {
  test("thumbnails, in both request forms", async () => {
    const { app } = await protectedFixture();
    expect((await app.request(`/files/${ASSET_ID}/_thumbs/md.webp`)).status).toBe(401);
    expect((await app.request(`/files/${ASSET_ID}?thumb=md`)).status).toBe(401);
    // And with a proof they reach the (absent) thumbnail rather than the 401.
    const ok = await app.request(`/files/${ASSET_ID}?thumb=md`, { headers: basic(PASSWORD) });
    expect(ok.status).toBe(404);
    expect(ok.headers.get("Cache-Control")).toContain("private");
  });

  test("Range requests", async () => {
    const { app } = await protectedFixture();
    const headers = { Range: "bytes=0-4" };
    expect((await app.request(`/files/${ASSET_ID}/site.zip`, { headers })).status).toBe(401);
    const ok = await app.request(`/files/${ASSET_ID}/site.zip`, {
      headers: { ...headers, ...basic(PASSWORD) },
    });
    expect(ok.status).toBe(206);
  });

  test("HEAD", async () => {
    const { app } = await protectedFixture();
    expect((await app.request(`/files/${ASSET_ID}`, { method: "HEAD" })).status).toBe(401);
    const ok = await app.request(`/files/${ASSET_ID}`, { method: "HEAD", headers: basic(PASSWORD) });
    expect(ok.status).toBe(200);
    expect(ok.headers.get("Cache-Control")).toContain("private");
  });

  test("the directory redirect", async () => {
    const { app } = await protectedFixture();
    expect((await app.request(`http://localhost/files/${ASSET_ID}/docs`)).status).toBe(401);
    const ok = await app.request(`http://localhost/files/${ASSET_ID}/docs`, {
      headers: basic(PASSWORD),
    });
    expect(ok.status).toBe(301);
  });

  test("the version-ID URL, which is a different ID for the same asset", async () => {
    const { app } = await protectedFixture();
    expect((await app.request(`/files/${VERSION_ID}`)).status).toBe(401);
    const ok = await app.request(`/files/${VERSION_ID}`, { headers: basic(PASSWORD) });
    expect(ok.status).toBe(200);
    // Pinned and protected: still a year, but never in a shared cache.
    expect(ok.headers.get("Cache-Control")).toBe("private, max-age=31536000, immutable");
  });

  test("the asset-ID site host", async () => {
    const { app } = await protectedFixture();
    const host = `${ASSET_ID}${SUFFIX}`;
    const res = await app.request(`http://${host}/`, { headers: { Host: host, ...BROWSER } });
    expect(res.status).toBe(401);
    const html = await res.text();
    // On a site host the form posts to the host's own root, and `next` is the
    // path the visitor actually typed — not the rewritten /files/{id} one.
    expect(html).toContain('action="/_serve/auth"');
    expect(html).toContain('value="/"');
    expect(html).not.toContain(`/files/${ASSET_ID}`);

    const ok = await app.request(`http://${host}/`, { headers: { Host: host, ...basic(PASSWORD) } });
    expect(ok.status).toBe(200);
  });

  test("a named site host", async () => {
    const { app, auth, metadata } = await protectedFixture();
    const claimed = await app.request(`/api/v1/assets/${ASSET_ID}/hosts`, {
      method: "POST",
      headers: { ...auth, "Content-Type": "application/json" },
      body: JSON.stringify({ hostname: "kawasaki-flood-map" }),
    });
    expect(claimed.status).toBe(201);

    const host = `kawasaki-flood-map${SUFFIX}`;
    expect((await app.request(`http://${host}/`, { headers: { Host: host } })).status).toBe(401);

    // The form, posted on the site host, comes back through the middleware's
    // rewrite and sets a cookie scoped to the whole origin.
    const posted = await submit(app, `http://${host}/_serve/auth`, { password: PASSWORD, next: "/docs/" }, { Host: host });
    expect(posted.status).toBe(303);
    expect(posted.headers.get("Location")).toBe("/docs/");
    expect(posted.headers.get("Set-Cookie")).toContain("Path=/");

    const cookie = cookieFrom(posted);
    const ok = await app.request(`http://${host}/`, { headers: { Host: host, Cookie: cookie } });
    expect(ok.status).toBe(200);
    expect(await ok.text()).toBe(INDEX_HTML);
    expect(metadata.protectionCalls).toBeGreaterThan(0);
  });
});

describe("CORS", () => {
  test("preflight keeps working for public and protected assets alike", async () => {
    const { app, metadata } = await siteFixture();
    const preflight = (id: string) => app.request(`/files/${id}`, {
      method: "OPTIONS",
      headers: { Origin: "https://viewer.example", "Access-Control-Request-Method": "GET" },
    });

    const open = await preflight(ASSET_ID);
    expect(open.status).toBe(204);
    expect(open.headers.get("Access-Control-Allow-Origin")).toBe("*");
    expect(open.headers.get("Access-Control-Allow-Methods")).toContain("GET");
    expect(open.headers.get("Access-Control-Allow-Credentials")).toBeNull();

    await protect(metadata, ASSET_ID, PASSWORD);
    const closed = await preflight(ASSET_ID);
    // A preflight carries no credentials, so it is never challenged — but it
    // must announce the policy the real request will get.
    expect(closed.status).toBe(204);
    expect(closed.headers.get("Access-Control-Allow-Origin")).toBe("https://viewer.example");
    expect(closed.headers.get("Access-Control-Allow-Credentials")).toBe("true");
    expect(closed.headers.get("Vary")).toContain("Origin");
  });

  test("a challenge is still readable cross-origin", async () => {
    const { app } = await protectedFixture();
    const res = await app.request(`/files/${ASSET_ID}`, {
      headers: { Origin: "https://viewer.example" },
    });
    expect(res.status).toBe(401);
    expect(res.headers.get("Access-Control-Allow-Origin")).toBe("https://viewer.example");
  });
});

describe("SIGNING_SECRET is required", () => {
  test("serving a protected asset fails closed with 503", async () => {
    const f = await siteFixture({ deps: { signingSecret: undefined } });
    await protect(f.metadata, ASSET_ID, PASSWORD);
    const res = await f.app.request(`/files/${ASSET_ID}`);
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: "SIGNING_SECRET not configured" });
    // Even with the right password: no secret, no cookie, no promise.
    expect((await f.app.request(`/files/${ASSET_ID}`, { headers: basic(PASSWORD) })).status).toBe(503);
  });

  test("PATCH refuses to protect an asset without it", async () => {
    const { app, auth } = await siteFixture({ deps: { signingSecret: undefined } });
    const res = await patchAccess(app, auth, ASSET_ID, { access: "password", password: PASSWORD });
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: "SIGNING_SECRET not configured" });
  });
});

function patchAccess(
  app: TestApp,
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

describe("PATCH /api/v1/assets/:id { access }", () => {
  test("an editor protects a site asset, and it takes effect", async () => {
    const { app, auth } = await siteFixture();
    const res = await patchAccess(app, auth, ASSET_ID, { access: "password", password: PASSWORD });
    expect(res.status).toBe(200);
    const { asset } = await res.json() as { asset: { access?: string } };
    expect(asset.access).toBe("password");
    expect((await app.request(`/files/${ASSET_ID}`)).status).toBe(401);
    expect((await app.request(`/files/${ASSET_ID}`, { headers: basic(PASSWORD) })).status).toBe(200);
  });

  test("`public` takes it off again", async () => {
    const { app, auth } = await siteFixture();
    await patchAccess(app, auth, ASSET_ID, { access: "password", password: PASSWORD });
    const res = await patchAccess(app, auth, ASSET_ID, { access: "public" });
    expect(res.status).toBe(200);
    expect((await app.request(`/files/${ASSET_ID}`)).status).toBe(200);
  });

  test("protection is for site (archive) assets only", async () => {
    const { app, auth } = await siteFixture();
    const res = await patchAccess(app, auth, SINGLE_FILE_ID, {
      access: "password", password: PASSWORD,
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({
      error: "protection is available for site (archive) assets only",
    });
  });

  test("a demo asset cannot be protected", async () => {
    // The plain fixture's assets carry no projectId: they are demo assets.
    // Asserted against the use case rather than through the route, because a
    // demo asset is reachable only by its own session and the ownership check
    // would answer 404 before the rule under test was reached.
    const { metadata } = await fixture();
    const demo = metadata.assets.get(ASSET_ID)!;
    expect(demo.projectId).toBeUndefined();
    const result = await setAssetAccess(
      metadata,
      demo,
      { access: "password", password: PASSWORD },
      { signingSecret: "secret", iterations: TEST_ITERATIONS },
    );
    expect(result).toEqual({
      ok: false, status: 400, error: "protection requires a project asset",
    });
    expect(metadata.protection.has(ASSET_ID)).toBe(false);
  });

  test("a short password is rejected by the schema", async () => {
    const { app, auth } = await siteFixture();
    const res = await patchAccess(app, auth, ASSET_ID, { access: "password", password: "short" });
    expect(res.status).toBe(400);
  });

  test("a password without `access: password` is rejected", async () => {
    const { app, auth } = await siteFixture();
    expect((await patchAccess(app, auth, ASSET_ID, { password: PASSWORD })).status).toBe(400);
    expect((await patchAccess(app, auth, ASSET_ID, { access: "public", password: PASSWORD })).status).toBe(400);
    expect((await patchAccess(app, auth, ASSET_ID, { access: "password" })).status).toBe(400);
  });

  test("a viewer may not protect an asset", async () => {
    const { app, auth } = await siteFixture({ role: "viewer" });
    const res = await patchAccess(app, auth, ASSET_ID, { access: "password", password: PASSWORD });
    expect(res.status).toBe(404);
  });
});

describe("the hash never leaves the server", () => {
  test("no password field appears in any asset response", async () => {
    const { app, auth } = await siteFixture();
    const patched = await patchAccess(app, auth, ASSET_ID, {
      access: "password", password: PASSWORD,
    });

    const responses = [
      patched,
      await app.request(`/api/v1/assets/${ASSET_ID}`, { headers: auth }),
      await app.request(`/api/v1/projects/p1/assets`, { headers: auth }),
    ];

    for (const res of responses) {
      const body = await res.text();
      expect(body).not.toContain("passwordHash");
      expect(body).not.toContain("passwordSalt");
      expect(body).not.toContain("passwordVersion");
      expect(body).not.toContain("pbkdf2");
      expect(body).not.toContain(PASSWORD);
    }
  });
});
