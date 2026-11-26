import { beforeAll, describe, expect, test } from "vitest";
import { execSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BASE, createProjectForAuth, fetchRetrying, MOCK_OIDC, rewriteUrl, signToken, uploadFileWithAuth } from "./helpers";

/**
 * Delivery tokens against a running server (ADR-014 §4): a member mints one,
 * and a restricted file reads with it through the query and the header. Both
 * launch scripts set `DELIVERY_TOKEN_KEYS`; minting needs a login, so the
 * suite is skipped wherever the mock OIDC server is not running.
 */
let mockOidcAvailable = false;
try {
  mockOidcAvailable = (await fetch(`${MOCK_OIDC}/.well-known/openid-configuration`)).ok;
} catch {
  // not reachable
}

type SignedUrl = { token: string; expiresAt: number; urlTemplate: string };

// Under wrangler dev the Vite dev server answers preflights itself.
const NODE_RUNTIME = process.env.E2E_NODE_RUNTIME === "true";

describe("delivery tokens", { skip: !mockOidcAvailable }, () => {
  const GEOJSON = '{"type":"FeatureCollection","features":[]}';
  let bearer: string;
  let assetId: string;

  function mint(id: string, body: unknown, headers: Record<string, string> = { Authorization: `Bearer ${bearer}` }) {
    return fetchRetrying(`${BASE}/api/v1/assets/${id}/signed-urls`, {
      method: "POST",
      headers: { ...headers, "Content-Type": "application/json", Origin: "https://viewer.example.net" },
      body: JSON.stringify(body),
    });
  }

  async function minted(body: unknown): Promise<SignedUrl> {
    const res = await mint(assetId, body);
    expect(res.status).toBe(200);
    return res.json() as Promise<SignedUrl>;
  }

  beforeAll(async () => {
    bearer = await signToken({ sub: "e2e-token-member" });
    const projectId = await createProjectForAuth(bearer, "e2e-delivery-token");
    const { status, body } = await uploadFileWithAuth(
      new TextEncoder().encode(GEOJSON), "data.geojson", "application/geo+json", bearer, projectId,
    );
    expect(status).toBe(201);
    assetId = body.asset.id;
    const restrict = await fetch(`${BASE}/api/v1/assets/${assetId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${bearer}` },
      body: JSON.stringify({ access: "restricted" }),
    });
    expect(restrict.status).toBe(200);
  });

  test("a member mints, and the token reads through the query form", async () => {
    const signed = await minted({ expiresIn: 600 });
    expect(signed.urlTemplate).toMatch(new RegExp(`/files/${assetId}/\\{path\\}\\?serve_token=`));
    expect(signed.expiresAt).toBeGreaterThan(Date.now());
    const res = await fetchRetrying(rewriteUrl(signed.urlTemplate.replace("{path}", "data.geojson")), {
      headers: { Origin: "https://viewer.example.net" },
    });
    expect(res.status).toBe(200);
    expect(await res.text()).toBe(GEOJSON);
    expect(res.headers.get("Access-Control-Allow-Origin")).toBe("*");
    expect(res.headers.get("Access-Control-Allow-Credentials")).toBeNull();
    expect(res.headers.get("Referrer-Policy")).toBe("no-referrer");
    expect(res.headers.get("Cache-Control")).toMatch(/^private, max-age=0/);
    expect(res.headers.get("Vary")).toContain("X-Serve-Token");
  });

  test("the header form reads too", async () => {
    const { token } = await minted({});
    const res = await fetchRetrying(`${BASE}/files/${assetId}/data.geojson`, { headers: { "X-Serve-Token": token } });
    expect(res.status).toBe(200);
    expect(await res.text()).toBe(GEOJSON);
  });

  test("a token for another prefix is 403, and no proof is still the 401 challenge", async () => {
    const { token } = await minted({ prefix: "tiles/" });
    const outside = await fetchRetrying(`${BASE}/files/${assetId}/data.geojson?serve_token=${token}`);
    expect(outside.status).toBe(403);
    expect(outside.headers.get("Cache-Control")).toBe("no-store");
    await outside.body?.cancel();
    const none = await fetchRetrying(`${BASE}/files/${assetId}/data.geojson`);
    expect(none.status).toBe(401);
    expect(none.headers.get("WWW-Authenticate")).toBe("Bearer, ServeToken");
    await none.body?.cancel();
  });

  test("preflights allow the token header on /files and a bearer POST on the mint route", { skip: !NODE_RUNTIME }, async () => {
    const files = await fetchRetrying(`${BASE}/files/${assetId}/data.geojson`, {
      method: "OPTIONS",
      headers: {
        Origin: "https://viewer.example.net",
        "Access-Control-Request-Method": "GET",
        "Access-Control-Request-Headers": "x-serve-token",
      },
    });
    expect(files.status).toBe(204);
    expect(files.headers.get("Access-Control-Allow-Headers")).toContain("x-serve-token");
    const mintRoute = await fetchRetrying(`${BASE}/api/v1/assets/${assetId}/signed-urls`, {
      method: "OPTIONS",
      headers: { Origin: "https://viewer.example.net", "Access-Control-Request-Method": "POST" },
    });
    expect(mintRoute.status).toBe(204);
    expect(mintRoute.headers.get("Access-Control-Allow-Origin")).toBe("*");
    expect(mintRoute.headers.get("Access-Control-Allow-Headers")).toBe("authorization, content-type");
  });

  test("the mint route's refusals are readable cross-origin", async () => {
    const refused = await mint(assetId, {}, { Authorization: "Bearer not-a-jwt" });
    expect(refused.status).toBe(401);
    expect(refused.headers.get("Access-Control-Allow-Origin")).toBe("*");
    await refused.body?.cancel();
    const stranger = await mint(assetId, {}, { Authorization: `Bearer ${await signToken({ sub: "e2e-token-stranger" })}` });
    expect(stranger.status).toBe(404);
    await stranger.body?.cancel();
  });

  test("`asset sign` prints a URL template that reads the file", async () => {
    const configDir = mkdtempSync(join(tmpdir(), "serve-e2e-token-config-"));
    writeFileSync(join(configDir, "credentials.json"), JSON.stringify({ accessToken: bearer, expiresAt: Date.now() + 3600_000 }));
    const out = execSync(`npx tsx cli/index.ts --endpoint ${BASE} --json asset sign ${assetId} --expires 2h`, {
      encoding: "utf-8", env: { ...process.env, REEARTH_SERVE_CONFIG_DIR: configDir },
    });
    const signed = JSON.parse(out) as SignedUrl;
    expect(Math.round((signed.expiresAt - Date.now()) / 1000)).toBeGreaterThan(7190);
    const res = await fetchRetrying(rewriteUrl(signed.urlTemplate.replace("{path}", "data.geojson")));
    expect(res.status).toBe(200);
    expect(await res.text()).toBe(GEOJSON);
  });
});
