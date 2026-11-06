import { describe, expect, test } from "vitest";
import type { HttpBindings } from "@hono/node-server";
import { hashPassword } from "../../core/access/password";
import { RATE_LIMIT_PER_IP } from "../../core/access/ratelimit";
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

describe("the Node runtime's client IP (ADR-020 §9 item 6)", () => {
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
