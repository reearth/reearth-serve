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

// The mock DNS-over-HTTPS resolver (e2e/mock-doh.ts) the Node runtime is
// pointed at, so custom-domain verification (ADR-013 B5) can be driven without
// owning a domain. Unset on runs that do not start it — the unverified half of
// B5 needs no DNS and is checked regardless.
const MOCK_DOH = process.env.E2E_MOCK_DOH;

/**
 * A request that reaches the server over the real socket but claims a
 * different `Host`. `fetch` derives Host from the URL and DNS would have to
 * resolve the site host for that to work, so this drops to node:http.
 */
function get(
  host: string,
  path: string,
  extraHeaders: Record<string, string> = {},
): Promise<{ status: number; contentType: string; cacheControl: string; robots: string; body: string }> {
  const base = new URL(BASE);
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      {
        hostname: base.hostname, port: base.port, path, method: "GET",
        headers: { Host: host, ...extraHeaders },
      },
      (res) => {
        let body = "";
        res.setEncoding("utf8");
        res.on("data", (chunk) => { body += chunk; });
        res.on("end", () => resolve({
          status: res.statusCode ?? 0,
          contentType: res.headers["content-type"] ?? "",
          cacheControl: res.headers["cache-control"] ?? "",
          robots: (res.headers["x-robots-tag"] as string | undefined) ?? "",
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

  // Preview hosts (ADR-013 B4).
  test("v{n}-- and latest-- serve their versions once previews are on", async () => {
    const token = await signToken();
    const projectId = await createProjectForAuth(token, "e2e-site-previews");
    const { assetId, name } = await claimedSite(token, projectId, "e2e-prev");

    const uploadVersion = async (text: string) => {
      const body = new TextEncoder().encode(text);
      const res = await fetch(`${BASE}/api/v1/assets/${assetId}`, {
        method: "POST",
        headers: {
          "Content-Type": "application/zip",
          "Content-Length": String(body.byteLength),
          "X-Filename": "site.zip",
          "X-Skip-Extraction": "true",
          Authorization: `Bearer ${token}`,
        },
        body: body as BodyInit,
      });
      expect(res.status).toBe(201);
      return (await res.json() as { version: { id: string; version: number } }).version;
    };
    const first = await uploadVersion("PK\x03\x04 version one");
    const second = await uploadVersion("PK\x03\x04 version two");
    expect(second.version).toBe(first.version + 1);

    // Off by default: the name serves, its previews do not.
    expect((await get(`v${first.version}--${name}${suffix}`, "/site.zip")).status).toBe(404);

    const patched = await fetch(`${BASE}/api/v1/assets/${assetId}/hosts/${name}${suffix}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({ previews: true }),
    });
    expect(patched.status).toBe(200);
    expect((await patched.json() as { host: { previews: boolean } }).host.previews).toBe(true);

    const older = await get(`v${first.version}--${name}${suffix}`, "/site.zip");
    expect(older.status).toBe(200);
    expect(older.body).toContain("version one");
    // A fixed version never moves, so it is cacheable forever (ADR-013 A2).
    expect(older.cacheControl).toContain("immutable");
    expect(older.robots).toBe("noindex");

    const newer = await get(`v${second.version}--${name}${suffix}`, "/site.zip");
    expect(newer.status).toBe(200);
    expect(newer.body).toContain("version two");

    // `latest--` is the newest version's bytes with the production name's
    // cache policy: it moves on the next upload.
    const latest = await get(`latest--${name}${suffix}`, "/site.zip");
    expect(latest.status).toBe(200);
    expect(latest.body).toBe(newer.body);
    expect(latest.cacheControl).not.toContain("immutable");
    expect(latest.robots).toBe("noindex");

    // The production name serves the same bytes and stays indexable.
    const production = await get(`${name}${suffix}`, "/site.zip");
    expect(production.body).toBe(newer.body);
    expect(production.cacheControl).toBe(latest.cacheControl);
    expect(production.robots).toBe("");

    // A left side that is not a version, and one the asset does not have.
    expect((await get(`staging--${name}${suffix}`, "/site.zip")).status).toBe(404);
    expect((await get(`v99--${name}${suffix}`, "/site.zip")).status).toBe(404);
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

  // Custom domains (ADR-013 B5). The Node runtime uses the real DoH adapter,
  // so the whole verification path is exercised against the mock resolver
  // e2e/mock-doh.ts, which scripts/e2e-node.sh points SITE_DNS_RESOLVER_URL at.
  // Without it (the Cloudflare dev run) only the unverified half is checked.
  describe("custom domains", () => {
    /** Publish TXT records at `name` on the mock resolver. */
    async function publishTxt(name: string, ...values: string[]) {
      const res = await fetch(`${MOCK_DOH}/test/txt`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name, values }),
      });
      expect(res.status).toBe(200);
    }

    async function registerCustom(token: string, projectId: string, hostname: string) {
      const { assetId } = await claimedSite(token, projectId, "e2e-custom-sub");
      const res = await fetch(`${BASE}/api/v1/assets/${assetId}/hosts`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({ hostname, kind: "custom" }),
      });
      expect(res.status).toBe(201);
      const body = await res.json() as {
        host: { hostname: string; kind: string; verifiedAt: number | null };
        verification: { record: string; type: string; value: string };
        cname: { target: string };
      };
      return { assetId, body };
    }

    test("a registered domain does not resolve until it is verified", async () => {
      const token = await signToken();
      const projectId = await createProjectForAuth(token, "e2e-custom-unverified");
      const hostname = `unverified-${Date.now().toString(36)}.example.jp`;
      const { body } = await registerCustom(token, projectId, hostname);

      expect(body.host.kind).toBe("custom");
      expect(body.host.verifiedAt).toBeNull();
      expect(body.verification.record).toBe(`_reearth-serve-verify.${hostname}`);
      expect(body.verification.type).toBe("TXT");
      expect(body.verification.value).toMatch(/^reearth-serve-verify=[0-9a-f]{32}$/);
      // No SITE_FALLBACK_ORIGIN in the e2e run, so the apex of BASE_URL.
      expect(body.cname.target).toBe(new URL(BASE).host);

      // On the wire the hostname is a plain-text 404 — not a 503, which would
      // admit that somebody registered it here.
      const res = await get(hostname, "/site.zip");
      expect(res.status).toBe(404);
      expect(res.contentType).toContain("text/plain");
      expect(res.body).toBe("Not found");

      // The apex is unaffected by any of this.
      const apex = await get(new URL(BASE).host, "/api/v1/health");
      expect(apex.status).toBe(200);
    });

    test.skipIf(!MOCK_DOH)("the TXT record verifies the domain and it starts serving", async () => {
      const token = await signToken();
      const projectId = await createProjectForAuth(token, "e2e-custom-verify");
      const hostname = `verified-${Date.now().toString(36)}.example.jp`;
      const { assetId, body } = await registerCustom(token, projectId, hostname);

      const verify = () => fetch(
        `${BASE}/api/v1/assets/${assetId}/hosts/${encodeURIComponent(hostname)}/verify`,
        { method: "POST", headers: { Authorization: `Bearer ${token}` } },
      );

      // Nothing published yet: 409, with the record repeated.
      const missing = await verify();
      expect(missing.status).toBe(409);
      const failure = await missing.json() as { error: string; verification: { record: string } };
      expect(failure.error).toBe("verification record not found");
      expect(failure.verification.record).toBe(body.verification.record);

      // Publish it alongside an unrelated record, the way a real domain has.
      await publishTxt(body.verification.record, "v=spf1 -all", body.verification.value);

      const verified = await verify();
      expect(verified.status).toBe(200);
      const row = await verified.json() as {
        host: { verifiedAt: number | null; certificateStatus: string | null };
      };
      expect(row.host.verifiedAt).toEqual(expect.any(Number));
      // The Node runtime has no certificate API: the no-op provisioner.
      expect(row.host.certificateStatus).toBe("active");

      // And the customer's hostname now serves the asset.
      const served = await get(hostname, "/site.zip");
      expect(served.status).toBe(200);
      expect(served.body).toContain("not really a zip");

      // Previews are not available on a custom domain.
      const previews = await fetch(
        `${BASE}/api/v1/assets/${assetId}/hosts/${encodeURIComponent(hostname)}`,
        {
          method: "PATCH",
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
          body: JSON.stringify({ previews: true }),
        },
      );
      expect(previews.status).toBe(400);
      expect((await previews.json() as { error: string }).error)
        .toBe("previews are not available on custom domains");

      // Release turns it into the 410 tombstone, as it does for a name.
      const released = await fetch(
        `${BASE}/api/v1/assets/${assetId}/hosts/${encodeURIComponent(hostname)}`,
        { method: "DELETE", headers: { Authorization: `Bearer ${token}` } },
      );
      expect(released.status).toBe(204);
      expect((await get(hostname, "/site.zip")).status).toBe(410);
    });

    test.skipIf(!MOCK_DOH)("the CLI registers, shows and verifies a domain", async () => {
      const token = await signToken();
      const projectId = await createProjectForAuth(token, "e2e-custom-cli");
      const { assetId } = await claimedSite(token, projectId, "e2e-custom-cli");
      const hostname = `cli-${Date.now().toString(36)}.example.jp`;

      const configDir = mkdtempSync(join(tmpdir(), "serve-e2e-custom-config-"));
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

      const added = cli(`asset host add ${assetId} ${hostname} --custom`);
      expect(added).toContain(`Registered: ${hostname}`);
      expect(added).toContain(`_reearth-serve-verify.${hostname}`);
      expect(added).toContain("CNAME");

      expect(cli(`asset host list ${assetId}`)).toContain("unverified");
      const shown = JSON.parse(cli(`--json asset host show ${assetId} ${hostname}`)) as {
        host: { kind: string; verifiedAt: number | null };
        verification: { record: string; value: string };
      };
      expect(shown.host.kind).toBe("custom");
      expect(shown.host.verifiedAt).toBeNull();

      await publishTxt(shown.verification.record, shown.verification.value);
      expect(cli(`asset host verify ${assetId} ${hostname}`)).toContain(`Verified: ${hostname}`);
      expect((await get(hostname, "/site.zip")).status).toBe(200);
    });
  });
});
