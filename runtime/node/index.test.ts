import { describe, expect, test } from "vitest";
import type { HttpBindings } from "@hono/node-server";
import { hashPassword } from "../../core/access/password";
import { RATE_LIMIT_PER_IP } from "../../core/access/ratelimit";
import { SignJWT, importPKCS8 } from "jose";
import { issueCredential } from "../../core/compat/credential";
import type { BucketName } from "../../core/compat/model";
import { buildNodeRuntime } from "./deps";
import { createNodeHandler } from "./index";

const ASSET_ID = "3f9a1c2b4d5e6f70";
const SOCKET = "192.0.2.10";

async function protectedHandler(env: Record<string, string> = {}) {
  const runtime = buildNodeRuntime({ SIGNING_SECRET: "node-test-signing-secret", ...env });
  await runtime.deps.metadata.save({
    id: ASSET_ID, filename: "site.zip", contentType: "application/zip", size: 3,
    createdAt: 0, expiresAt: 0, type: "archive", status: "ready",
  }, 3600);
  const { hash, salt } = await hashPassword("right-password", { iterations: 1000 });
  await runtime.deps.metadata.setProtection(ASSET_ID, { access: "password", hash, salt });
  return createNodeHandler(runtime);
}

/** One wrong Basic attempt from the socket, claiming a different client each time. */
function wrongAttempt(handler: Awaited<ReturnType<typeof protectedHandler>>, i: number) {
  const request = new Request(`http://localhost:8788/files/${ASSET_ID}`, {
    headers: {
      Authorization: `Basic ${btoa(":wrong-password")}`,
      "CF-Connecting-IP": `198.51.100.${i}`,
      "X-Forwarded-For": `203.0.113.${i}`,
    },
  });
  const env = { incoming: { socket: { remoteAddress: SOCKET } } } as unknown as HttpBindings;
  return handler(request, env);
}

describe("the Node runtime's client IP (ADR-013 B7)", () => {
  test("a forged CF-Connecting-IP or X-Forwarded-For does not buy a fresh rate-limit bucket", async () => {
    const handler = await protectedHandler();
    for (let i = 0; i < RATE_LIMIT_PER_IP; i++) {
      expect((await wrongAttempt(handler, i)).status).toBe(401);
    }
    expect((await wrongAttempt(handler, RATE_LIMIT_PER_IP)).status).toBe(429);
  });

  test("TRUST_PROXY=true keeps the forwarded headers", async () => {
    const handler = await protectedHandler({ TRUST_PROXY: "true" });
    for (let i = 0; i <= RATE_LIMIT_PER_IP; i++) {
      expect((await wrongAttempt(handler, i)).status).toBe(401);
    }
  });
});

describe("the Node runtime's compat host gate (ADR-019 §5)", () => {
  const request = (path: string, method = "GET") =>
    new Request(`http://localhost:8788${path}`, { method, headers: { Host: "storage.localhost:8788" } });
  const layerOn = () => createNodeHandler(buildNodeRuntime({ COMPAT_GCS_HOST: "storage.localhost:8788" }));

  test("every path on the API host reaches the app, the XML read path included", async () => {
    const res = await layerOn()(request("/media/assets/a.txt"));
    expect(res.status).toBe(401);
    expect(await res.text()).toContain("<Code>AuthenticationRequired</Code>");
  });

  test("a trailing-dot API host passes the gate as the API host", async () => {
    for (const host of ["storage.localhost.:8788", "storage.localhost."]) {
      const res = await layerOn()(new Request("http://localhost:8788/api/v1/health", { headers: { Host: host } }));
      expect(res.status).toBe(401);
      expect(await res.text()).toContain("<Code>AuthenticationRequired</Code>");
    }
  });

  test("the cron endpoint is not reachable on the API host", async () => {
    const res = await layerOn()(request("/internal/cron", "POST"));
    expect(res.headers.get("Content-Type")).toBe("application/xml; charset=UTF-8");
  });

  test("in accounts mode a service credential is decided without the accounts directory", async () => {
    const runtime = buildNodeRuntime({
      COMPAT_GCS_HOST: "storage.localhost:8788",
      SIGNING_SECRET: "node-test-signing-secret",
      ACCOUNTS_URL: "http://127.0.0.1:1",
      OIDC_ISSUER_URL: "https://issuer.example.test/",
    });
    await runtime.deps.projects.save({ id: "p1", name: "P", createdAt: 0, updatedAt: 0, ownerId: "u1", workspaceId: "ws1" });
    await runtime.deps.compat.insertBucket({ name: "media" as BucketName, projectId: "p1", mount: null, createdAt: 0 });
    const { credential, keyFile } = await issueCredential({
      projectId: "p1", bucket: "media" as BucketName, role: "viewer", label: null, createdBy: "u1",
      apiOrigin: "http://storage.localhost:8788", now: Date.now(),
    });
    await runtime.deps.compat.insertCredential(credential);
    const assertion = await new SignJWT({})
      .setProtectedHeader({ alg: "RS256", kid: keyFile.private_key_id })
      .setIssuer(keyFile.client_email).setAudience(keyFile.token_uri).setIssuedAt().setExpirationTime("1h")
      .sign(await importPKCS8(keyFile.private_key, "RS256"));
    const handler = createNodeHandler(runtime);
    const token = await handler(new Request("http://localhost:8788/token", {
      method: "POST",
      headers: { Host: "storage.localhost:8788", "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion }),
    }));
    expect(token.status).toBe(200);
    const { access_token } = await token.json() as { access_token: string };
    const res = await handler(new Request("http://localhost:8788/storage/v1/b/media/o/missing", {
      headers: { Host: "storage.localhost:8788", Authorization: `Bearer ${access_token}` },
    }));
    expect(res.status).toBe(404);
  });

  test("with the layer off, the same host keeps the API-only 404", async () => {
    const res = await createNodeHandler(buildNodeRuntime({}))(request("/media/a.txt"));
    expect(res.status).toBe(404);
    expect(await res.json()).toMatchObject({ error: "Not found" });
  });
});
