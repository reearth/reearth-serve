import { describe, test, expect } from "vitest";
import { execSync } from "node:child_process";
import { request as httpRequest } from "node:http";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BASE, createProjectForAuth, signToken, uploadFile } from "./helpers";

// Per-asset site hosts (ADR-013 B1). Only the launch script that starts the
// server with SITE_HOST_SUFFIX exports this, so the suite is skipped wherever
// the feature is off (e.g. the Cloudflare dev run).
const SUFFIX = process.env.E2E_SITE_HOST_SUFFIX;

/**
 * A request that reaches the server over the real socket but claims a
 * different `Host`. `fetch` derives Host from the URL and DNS would have to
 * resolve the site host for that to work, so this drops to node:http.
 */
function get(host: string, path: string): Promise<{ status: number; contentType: string; body: string }> {
  const base = new URL(BASE);
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      { hostname: base.hostname, port: base.port, path, method: "GET", headers: { Host: host } },
      (res) => {
        let body = "";
        res.setEncoding("utf8");
        res.on("data", (chunk) => { body += chunk; });
        res.on("end", () => resolve({
          status: res.statusCode ?? 0,
          contentType: res.headers["content-type"] ?? "",
          body,
        }));
      },
    );
    req.on("error", reject);
    req.end();
  });
}

/**
 * An archive asset in `projectId` with a freshly claimed name.
 *
 * The extraction container is not available in this runtime, so the archive
 * itself (`/site.zip`) is what the host serves — enough to tell "the site is
 * being served" from "it is not".
 */
async function claimedSite(token: string, projectId: string, prefix = "e2e-site") {
  const suffix = SUFFIX ?? "";
  const zip = new TextEncoder().encode("PK\x03\x04 not really a zip");
  const upload = await fetch(`${BASE}/api/v1/assets`, {
    method: "POST",
    headers: {
      "Content-Type": "application/zip",
      "Content-Length": String(zip.byteLength),
      "X-Filename": "site.zip",
      "X-Skip-Extraction": "true",
      "X-Project-Id": projectId,
      Authorization: `Bearer ${token}`,
    },
    body: zip as BodyInit,
  });
  if (upload.status !== 201) throw new Error(`upload failed: ${upload.status}`);
  const assetId = (await upload.json() as { asset: { id: string } }).asset.id;

  const name = `${prefix}-${Date.now().toString(36)}-${Math.floor(Math.random() * 1e4)}`;
  const claimed = await fetch(`${BASE}/api/v1/assets/${assetId}/hosts`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify({ hostname: name }),
  });
  if (claimed.status !== 201) throw new Error(`claim failed: ${claimed.status} ${await claimed.text()}`);
  return { assetId, name, hostname: `${name}${suffix}` };
}

describe.skipIf(!SUFFIX)("site hosts", () => {
  const suffix = SUFFIX ?? "";

  test("an asset-ID host serves the asset at / and nothing else", async () => {
    const content = new TextEncoder().encode("hello from a site host");
    const { status, body } = await uploadFile(content, "hello.txt", "text/plain");
    expect(status).toBe(201);
    const assetId = body.asset.id as string;

    const root = await get(`${assetId}${suffix}`, "/");
    expect(root.status).toBe(200);
    expect(root.body).toBe("hello from a site host");

    // The API is not reachable here: this is a file lookup inside the asset.
    const health = await get(`${assetId}${suffix}`, "/api/v1/health");
    expect(health.body).not.toContain("anonymousUploadEnabled");

    // The apex keeps serving the API.
    const apex = await get(new URL(BASE).host, "/api/v1/health");
    expect(apex.status).toBe(200);
    expect(JSON.parse(apex.body).ok).toBe(true);
  });

  test("a label that is not an ID is a plain-text 404", async () => {
    const res = await get(`kawasaki-flood-map${suffix}`, "/");
    expect(res.status).toBe(404);
    expect(res.contentType).toContain("text/plain");
    expect(res.body).toBe("Not found");
  });

  // Named sites (ADR-013 B2/B3/B6). Claiming needs an authenticated project
  // asset, so this one goes through the mock OIDC the way the auth suite does.
  test("a claimed name serves the asset, and releasing it turns the host into a 410", async () => {
    const token = await signToken();
    const projectId = await createProjectForAuth(token, "e2e-site-hosts");

    // A zip so the asset is an archive — only archives may be named. The
    // extraction container is not available in this runtime, so the site's
    // entries are absent and the archive itself is what the host serves.
    const zip = new TextEncoder().encode("PK\x03\x04 not really a zip");
    const upload = await fetch(`${BASE}/api/v1/assets`, {
      method: "POST",
      headers: {
        "Content-Type": "application/zip",
        "Content-Length": String(zip.byteLength),
        "X-Filename": "site.zip",
        "X-Skip-Extraction": "true",
        "X-Project-Id": projectId,
        Authorization: `Bearer ${token}`,
      },
      body: zip as BodyInit,
    });
    expect(upload.status).toBe(201);
    const assetId = (await upload.json() as { asset: { id: string } }).asset.id;

    const name = `e2e-site-${Date.now().toString(36)}`;
    const claimed = await fetch(`${BASE}/api/v1/assets/${assetId}/hosts`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({ hostname: name }),
    });
    expect(claimed.status).toBe(201);
    const { host, siteUrl } = await claimed.json() as { host: { hostname: string }; siteUrl: string };
    expect(host.hostname).toBe(`${name}${suffix}`);
    expect(siteUrl).toBe(`http://${name}${suffix}/`);

    // The name resolves through site_hosts to the asset: the archive is served
    // at its own filename, exactly as it is under /files/{id}/site.zip.
    const archive = await get(`${name}${suffix}`, "/site.zip");
    expect(archive.status).toBe(200);
    expect(archive.body).toContain("not really a zip");

    // The name is taken now.
    const again = await fetch(`${BASE}/api/v1/assets/${assetId}/hosts`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({ hostname: name }),
    });
    expect(again.status).toBe(400);
    expect((await again.json() as { error: string }).error).toBe("name is taken");

    const listed = await fetch(`${BASE}/api/v1/assets/${assetId}/hosts`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect((await listed.json() as { hosts: unknown[] }).hosts).toHaveLength(1);

    // Release: 410 for the cooldown, and the name cannot be re-claimed.
    const released = await fetch(`${BASE}/api/v1/assets/${assetId}/hosts/${name}${suffix}`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(released.status).toBe(204);

    const gone = await get(`${name}${suffix}`, "/site.zip");
    expect(gone.status).toBe(410);
    expect(gone.contentType).toContain("text/html");
    expect(gone.body).toContain("This site has moved or been removed");

    const reclaim = await fetch(`${BASE}/api/v1/assets/${assetId}/hosts`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({ hostname: name }),
    });
    expect(reclaim.status).toBe(400);
    expect((await reclaim.json() as { error: string }).error).toMatch(/on cooldown until/);
  });

  // Publish state (ADR-013 B3): the name is held either way, so the only thing
  // that changes is what the host answers.
  test("disabling a name answers 503 and enabling brings the site back", async () => {
    const token = await signToken();
    const projectId = await createProjectForAuth(token, "e2e-site-disable");
    const { assetId, name } = await claimedSite(token, projectId);

    expect((await get(`${name}${suffix}`, "/site.zip")).status).toBe(200);

    const patch = (body: unknown) => fetch(`${BASE}/api/v1/assets/${assetId}/hosts/${name}${suffix}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify(body),
    });

    const disabled = await patch({ disabled: true });
    expect(disabled.status).toBe(200);
    expect((await disabled.json() as { host: { disabledAt: number | null } }).host.disabledAt)
      .toEqual(expect.any(Number));

    const down = await get(`${name}${suffix}`, "/site.zip");
    expect(down.status).toBe(503);
    expect(down.contentType).toContain("text/html");
    expect(down.body).toContain("This site is temporarily unavailable");

    // The ID host is a capability URL and is unaffected by publish state.
    expect((await get(`${assetId}${suffix}`, "/site.zip")).status).toBe(200);

    expect((await patch({ disabled: false })).status).toBe(200);
    expect((await get(`${name}${suffix}`, "/site.zip")).status).toBe(200);
  });

  test("a name cannot be claimed for a demo asset", async () => {
    const { status, body, sessionId } = await uploadFile(
      new TextEncoder().encode("x"), "a.zip", "application/zip",
    );
    expect(status).toBe(201);
    // The demo session that owns the asset, or the claim would 404 at the
    // ownership check before it could reject the demo asset itself.
    const res = await fetch(`${BASE}/api/v1/assets/${body.asset.id}/hosts`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Session-Id": sessionId ?? "" },
      body: JSON.stringify({ hostname: "demo-site-name" }),
    });
    expect(res.status).toBe(400);
    expect((await res.json() as { error: string }).error).toBe("names require a project asset");
  });

  // `asset host disable --all` is a loop over the asset's rows rather than an
  // asset-level flag (ADR-013 B3), so the loop is what needs covering.
  test("the CLI disables and enables every name of an asset with --all", async () => {
    const token = await signToken();
    const projectId = await createProjectForAuth(token, "e2e-site-cli");
    const { assetId, name: first } = await claimedSite(token, projectId, "e2e-cli-a");

    const second = `e2e-cli-b-${Date.now().toString(36)}`;
    const claimed = await fetch(`${BASE}/api/v1/assets/${assetId}/hosts`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({ hostname: second }),
    });
    expect(claimed.status).toBe(201);

    // A throwaway config directory, or the token leaks into every other suite
    // that shells out to the CLI (see e2e/cli-project.test.ts).
    const configDir = mkdtempSync(join(tmpdir(), "serve-e2e-host-config-"));
    writeFileSync(
      join(configDir, "credentials.json"),
      JSON.stringify({ accessToken: token, expiresAt: Date.now() + 3600_000 }),
      { mode: 0o600 },
    );
    writeFileSync(join(configDir, "config.json"), JSON.stringify({}));
    const cli = (args: string) => execSync(
      `npx tsx cli/index.ts --endpoint ${BASE} ${args}`,
      { encoding: "utf-8", env: { ...process.env, REEARTH_SERVE_CONFIG_DIR: configDir } },
    ).trim();

    expect(cli(`asset host list ${assetId}`)).toContain("enabled");

    cli(`asset host disable ${assetId} --all`);
    expect((await get(`${first}${suffix}`, "/site.zip")).status).toBe(503);
    expect((await get(`${second}${suffix}`, "/site.zip")).status).toBe(503);
    const listed = cli(`asset host list ${assetId}`);
    expect(listed).toContain("disabled");
    expect(listed).not.toContain("enabled");

    cli(`asset host enable ${assetId} --all`);
    expect((await get(`${first}${suffix}`, "/site.zip")).status).toBe(200);
    expect((await get(`${second}${suffix}`, "/site.zip")).status).toBe(200);

    // A single name still works on its own.
    cli(`asset host disable ${assetId} ${first}`);
    expect((await get(`${first}${suffix}`, "/site.zip")).status).toBe(503);
    expect((await get(`${second}${suffix}`, "/site.zip")).status).toBe(200);
  });
});
