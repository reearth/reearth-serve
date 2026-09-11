import { describe, test, expect, beforeAll } from "vitest";
import { execSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BASE, createProjectForAuth, MOCK_OIDC, signToken, uploadFileWithAuth } from "./helpers";

/**
 * The SPA fallback flag against a running server (ADR-013 C1).
 *
 * The *delivery* half of C1 — an extensionless miss answering with the
 * archive's `index.html` — cannot be exercised here: nothing extracts an
 * archive on a runtime with no container launcher, so there is no `index.html`
 * inside one to fall back to. That half is covered in full by the unit suite
 * (`core/file/spa.test.ts`), against the same handler this server runs.
 *
 * What is proved here is the part the unit suite cannot: the column survives a
 * round trip through real SQL (migration 0007), the archive-only and
 * project-only rules hold at the route, and the CLI reaches them.
 *
 * Needs a project asset, hence a real login, hence the mock OIDC server.
 */
let mockOidcAvailable = false;
try {
  const res = await fetch(`${MOCK_OIDC}/.well-known/openid-configuration`);
  mockOidcAvailable = res.ok;
} catch {
  // not reachable
}

describe("SPA fallback flag", { skip: !mockOidcAvailable }, () => {
  let token: string;
  let projectId: string;
  let assetId: string;
  let plainAssetId: string;
  let configDir: string;

  async function patch(id: string, body: unknown): Promise<Response> {
    return fetch(`${BASE}/api/v1/assets/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify(body),
    });
  }

  beforeAll(async () => {
    const health = await fetch(`${BASE}/api/v1/health`);
    if (!health.ok) throw new Error(`Server not reachable at ${BASE}`);

    token = await signToken({ sub: "e2e-spa-user" });
    projectId = await createProjectForAuth(token, "e2e-spa");
    configDir = mkdtempSync(join(tmpdir(), "serve-e2e-spa-config-"));

    // An empty but valid zip: an archive asset without extraction.
    const zip = new Uint8Array([0x50, 0x4b, 0x05, 0x06, ...new Array(18).fill(0)]);
    const archive = await uploadFileWithAuth(zip, "site.zip", "application/zip", token, projectId);
    expect(archive.status).toBe(201);
    assetId = archive.body.asset.id;

    const plain = await uploadFileWithAuth(
      new TextEncoder().encode("not an archive"), "notes.txt", "text/plain", token, projectId,
    );
    expect(plain.status).toBe(201);
    plainAssetId = plain.body.asset.id;
  });

  test("it starts off", async () => {
    const res = await fetch(`${BASE}/api/v1/assets/${assetId}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(res.status).toBe(200);
    const { asset } = await res.json() as { asset: { spa?: boolean } };
    expect(asset.spa).toBe(false);
  });

  test("PATCH turns it on and off, and it persists", async () => {
    const on = await patch(assetId, { spa: true });
    expect(on.status).toBe(200);
    expect((await on.json() as { asset: { spa?: boolean } }).asset.spa).toBe(true);

    const read = await fetch(`${BASE}/api/v1/assets/${assetId}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect((await read.json() as { asset: { spa?: boolean } }).asset.spa).toBe(true);

    const off = await patch(assetId, { spa: false });
    expect((await off.json() as { asset: { spa?: boolean } }).asset.spa).toBe(false);
  });

  test("it survives an unrelated PATCH", async () => {
    await patch(assetId, { spa: true });
    const res = await patch(assetId, { description: "a map" });
    const { asset } = await res.json() as { asset: { spa?: boolean; description?: string } };
    expect(asset.spa).toBe(true);
    expect(asset.description).toBe("a map");
    await patch(assetId, { spa: false });
  });

  test("site (archive) assets only", async () => {
    const res = await patch(plainAssetId, { spa: true });
    expect(res.status).toBe(400);
    expect((await res.json() as { error: string }).error)
      .toBe("SPA fallback is available for site (archive) assets only");
  });

  test("turning it off is allowed on any asset", async () => {
    expect((await patch(plainAssetId, { spa: false })).status).toBe(200);
  });

  test("the CLI offers --spa and refuses anything but on|off", () => {
    const cli = (args: string) => execSync(
      `npx tsx cli/index.ts ${args}`,
      { encoding: "utf-8", stdio: "pipe", env: { ...process.env, REEARTH_SERVE_CONFIG_DIR: configDir } },
    ).trim();

    expect(cli("asset update --help")).toContain("--spa");
    expect(() => cli(`--endpoint ${BASE} asset update ${assetId} --spa maybe`)).toThrow();
  });
});
