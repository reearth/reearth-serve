import { describe, test, expect } from "vitest";
import { request as httpRequest } from "node:http";
import { BASE, uploadFile } from "./helpers";

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
});
