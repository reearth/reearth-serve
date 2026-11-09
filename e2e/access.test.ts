import { describe, test, expect, beforeAll } from "vitest";
import { execSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BASE, createProjectForAuth, MOCK_OIDC, signToken, uploadFileWithAuth } from "./helpers";

/**
 * Password-protected sites against a running server (ADR-013 B7).
 *
 * Needs a project asset, which needs a real login, so the suite is skipped
 * wherever the mock OIDC server is not running. It also needs the server to
 * have been started with `SIGNING_SECRET` — without it a protected asset is
 * fail-closed 503 and the PATCH is refused, which is asserted rather than
 * worked around: both launch scripts set the secret.
 */
let mockOidcAvailable = false;
try {
  const res = await fetch(`${MOCK_OIDC}/.well-known/openid-configuration`);
  mockOidcAvailable = res.ok;
} catch {
  // not reachable
}

const PASSWORD = "e2e-site-password";
const NODE_RUNTIME = process.env.E2E_NODE_RUNTIME === "true";
const BROWSER = { Accept: "text/html,application/xhtml+xml" };
const EMPTY_ZIP = new Uint8Array([0x50, 0x4b, 0x05, 0x06, ...new Array(18).fill(0)]);

function basic(password: string): Record<string, string> {
  return { Authorization: `Basic ${Buffer.from(`viewer:${password}`).toString("base64")}` };
}

describe("password-protected sites", { skip: !mockOidcAvailable }, () => {
  let token: string;
  let projectId: string;
  let assetId: string;
  let fileUrl: string;
  let configDir: string;
  let ownOrigin: string;

  async function formCookie(): Promise<string> {
    expect((await setAccess({ access: "password", password: PASSWORD })).status).toBe(200);
    const posted = await fetch(`${BASE}/files/${assetId}/_serve/auth`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ password: PASSWORD, next: "/" }),
      redirect: "manual",
    });
    expect(posted.status).toBe(303);
    return (posted.headers.get("Set-Cookie") ?? "").split(";")[0];
  }

  /** Protect or unprotect through the API. */
  async function setAccess(body: unknown): Promise<Response> {
    return fetch(`${BASE}/api/v1/assets/${assetId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify(body),
    });
  }

  /** A fresh archive behind `password`, so a test can spend its limiter budget alone. */
  async function protectedFile(password: string): Promise<{ id: string; url: string }> {
    const { status, body } = await uploadFileWithAuth(
      EMPTY_ZIP, "site.zip", "application/zip", token, projectId,
    );
    expect(status).toBe(201);
    const id = body.asset.id as string;
    const res = await fetch(`${BASE}/api/v1/assets/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({ access: "password", password }),
    });
    expect(res.status).toBe(200);
    return { id, url: `${BASE}/files/${id}/site.zip` };
  }

  beforeAll(async () => {
    const health = await fetch(`${BASE}/api/v1/health`);
    if (!health.ok) throw new Error(`Server not reachable at ${BASE}`);

    token = await signToken({ sub: "e2e-access-user" });
    projectId = await createProjectForAuth(token, "e2e-access");

    // A site asset: protection is for archives (ADR-013 B7). Extraction never
    // runs here — no container launcher on this runtime — but the archive
    // itself is served at its own filename, which is enough to prove the
    // access check without depending on the extractor.
    const { status, body } = await uploadFileWithAuth(
      EMPTY_ZIP, "site.zip", "application/zip", token, projectId,
    );
    expect(status).toBe(201);
    assetId = body.asset.id;
    expect(body.asset.type).toBe("archive");
    // Public until someone says otherwise.
    expect(body.asset.access ?? "public").toBe("public");
    fileUrl = `${BASE}/files/${assetId}/site.zip`;
    // BASE_URL, not BASE: wrangler dev keeps the production BASE_URL.
    ownOrigin = new URL(body.url).origin;

    // The CLI writes credentials under REEARTH_SERVE_CONFIG_DIR; a throwaway
    // directory keeps this suite out of the developer's real config.
    configDir = mkdtempSync(join(tmpdir(), "serve-e2e-access-config-"));
    writeFileSync(
      join(configDir, "credentials.json"),
      JSON.stringify({ accessToken: token, expiresAt: Date.now() + 3600_000 }),
    );
    writeFileSync(join(configDir, "config.json"), JSON.stringify({ defaultProject: projectId }));
  });

  test("the file is public before anyone protects it", async () => {
    const res = await fetch(fileUrl);
    expect(res.status).toBe(200);
    expect(res.headers.get("Access-Control-Allow-Origin")).toBe("*");
  });

  test("PATCH turns protection on", async () => {
    const res = await setAccess({ access: "password", password: PASSWORD });
    expect(res.status).toBe(200);
    const { asset } = await res.json() as { asset: Record<string, unknown> };
    expect(asset.access).toBe("password");
    // The hash never leaves the server.
    expect(JSON.stringify(asset)).not.toContain("passwordHash");
    expect(JSON.stringify(asset)).not.toContain("pbkdf2");
  });

  test("an unauthenticated GET is 401", async () => {
    const res = await fetch(fileUrl);
    expect(res.status).toBe(401);
    expect(res.headers.get("WWW-Authenticate")).toContain("Basic");
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    await res.body?.cancel();
  });

  test("a browser navigation gets the password page instead", async () => {
    const res = await fetch(fileUrl, { headers: BROWSER });
    expect(res.status).toBe(401);
    expect(res.headers.get("Content-Type")).toContain("text/html");
    expect(res.headers.get("WWW-Authenticate")).toBeNull();
    expect(await res.text()).toContain(`action="/files/${assetId}/_serve/auth"`);
  });

  test("Authorization: Basic gets the bytes, privately", async () => {
    const res = await fetch(fileUrl, { headers: basic(PASSWORD) });
    expect(res.status).toBe(200);
    expect(res.headers.get("Cache-Control")).toContain("private");
    expect(res.headers.get("Vary")).toContain("Cookie");
    await res.body?.cancel();
  });

  test("the form sets a cookie, and the cookie serves the file", async () => {
    const posted = await fetch(`${BASE}/files/${assetId}/_serve/auth`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ password: PASSWORD, next: `/files/${assetId}/site.zip` }),
      redirect: "manual",
    });
    expect(posted.status).toBe(303);
    expect(posted.headers.get("Location")).toBe(`/files/${assetId}/site.zip`);

    const setCookie = posted.headers.get("Set-Cookie") ?? "";
    expect(setCookie.startsWith("serve_access=")).toBe(true);
    expect(setCookie).toContain("HttpOnly");
    const cookie = setCookie.split(";")[0];

    const res = await fetch(fileUrl, { headers: { Cookie: cookie } });
    expect(res.status).toBe(200);
    await res.body?.cancel();
  });

  test("a cookie read is credentialed for Serve's own origin only", async () => {
    const cookie = await formCookie();
    expect(cookie.startsWith("serve_access=")).toBe(true);

    const foreign = await fetch(fileUrl, { headers: { Cookie: cookie, Origin: "https://other.example.com" } });
    expect(foreign.status).toBe(200);
    expect(foreign.headers.get("Access-Control-Allow-Origin")).toBe("*");
    expect(foreign.headers.get("Access-Control-Allow-Credentials")).toBeNull();
    expect(foreign.headers.get("Cross-Origin-Resource-Policy")).toBe("same-origin");
    await foreign.body?.cancel();

    const own = await fetch(fileUrl, { headers: { Cookie: cookie, Origin: ownOrigin } });
    expect(own.status).toBe(200);
    expect(own.headers.get("Access-Control-Allow-Origin")).toBe(ownOrigin);
    expect(own.headers.get("Access-Control-Allow-Credentials")).toBe("true");
    expect(own.headers.get("Vary")).toContain("Origin");
    await own.body?.cancel();
  });

  test("a preflight allows the fixed headers, not the requested ones", { skip: !NODE_RUNTIME }, async () => {
    const res = await fetch(fileUrl, {
      method: "OPTIONS",
      headers: {
        Origin: "https://other.example.com",
        "Access-Control-Request-Method": "GET",
        "Access-Control-Request-Headers": "x-evil, range",
      },
    });
    expect(res.status).toBe(204);
    expect(res.headers.get("Access-Control-Allow-Headers"))
      .toBe("range, if-none-match, if-modified-since, authorization, x-serve-token");
    expect(res.headers.get("Access-Control-Allow-Origin")).toBe("*");
  });

  test("a wrong password re-renders the form", async () => {
    const res = await fetch(`${BASE}/files/${assetId}/_serve/auth`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ password: "not-the-password", next: "/" }),
      redirect: "manual",
    });
    expect(res.status).toBe(401);
    expect(res.headers.get("Set-Cookie")).toBeNull();
    expect(await res.text()).toContain("Wrong password");
  });

  test("after a password change the old password is refused", async () => {
    const { id, url } = await protectedFile(PASSWORD);
    const before = await fetch(url, { headers: basic(PASSWORD) });
    expect(before.status).toBe(200);
    await before.body?.cancel();

    const changed = await fetch(`${BASE}/api/v1/assets/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({ access: "password", password: "e2e-site-password-2" }),
    });
    expect(changed.status).toBe(200);

    const old = await fetch(url, { headers: basic(PASSWORD) });
    expect(old.status).toBe(401);
    await old.body?.cancel();
    const current = await fetch(url, { headers: basic("e2e-site-password-2") });
    expect(current.status).toBe(200);
    await current.body?.cancel();
  });

  test("a client cannot pick its own limiter bucket", { skip: !NODE_RUNTIME }, async () => {
    const { url } = await protectedFile(PASSWORD);
    const statuses: number[] = [];
    for (let i = 1; i <= 11; i++) {
      const res = await fetch(url, {
        headers: {
          ...basic(`wrong-password-${i}`),
          "X-Forwarded-For": `198.51.100.${i}`,
          "CF-Connecting-IP": `198.51.100.${i}`,
        },
      });
      statuses.push(res.status);
      await res.body?.cancel();
    }
    expect(statuses.slice(0, 10)).toEqual(new Array(10).fill(401));
    expect(statuses[10]).toBe(429);
  });

  test("`asset protect --off` makes it public again", () => {
    const out = execSync(
      `npx tsx cli/index.ts --endpoint ${BASE} --json asset protect ${assetId} --off`,
      { encoding: "utf-8", env: { ...process.env, REEARTH_SERVE_CONFIG_DIR: configDir } },
    );
    const { asset } = JSON.parse(out) as { asset: { access?: string } };
    expect(asset.access).toBe("public");
  });

  test("and the file is served with no proof at all", async () => {
    const res = await fetch(fileUrl);
    expect(res.status).toBe(200);
    expect(res.headers.get("Access-Control-Allow-Origin")).toBe("*");
    await res.body?.cancel();
  });
});
