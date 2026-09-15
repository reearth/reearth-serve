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
const BROWSER = { Accept: "text/html,application/xhtml+xml" };

function basic(password: string): Record<string, string> {
  return { Authorization: `Basic ${Buffer.from(`viewer:${password}`).toString("base64")}` };
}

describe("password-protected sites", { skip: !mockOidcAvailable }, () => {
  let token: string;
  let projectId: string;
  let assetId: string;
  let fileUrl: string;
  let configDir: string;

  /** Protect or unprotect through the API. */
  async function setAccess(body: unknown): Promise<Response> {
    return fetch(`${BASE}/api/v1/assets/${assetId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify(body),
    });
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
    const zip = new Uint8Array([0x50, 0x4b, 0x05, 0x06, ...new Array(18).fill(0)]);
    const { status, body } = await uploadFileWithAuth(
      zip, "site.zip", "application/zip", token, projectId,
    );
    expect(status).toBe(201);
    assetId = body.asset.id;
    expect(body.asset.type).toBe("archive");
    // Public until someone says otherwise.
    expect(body.asset.access ?? "public").toBe("public");
    fileUrl = `${BASE}/files/${assetId}/site.zip`;

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
    expect(setCookie).toContain("rs_site_auth=");
    expect(setCookie).toContain("HttpOnly");
    const cookie = setCookie.split(";")[0];

    const res = await fetch(fileUrl, { headers: { Cookie: cookie } });
    expect(res.status).toBe(200);
    await res.body?.cancel();
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
