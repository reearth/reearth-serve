import { createMiddleware } from "hono/factory";
import { jwtVerify, type JWTVerifyGetKey, type JSONWebKeySet } from "jose";
import type { AppEnv } from "../types";
import type { AuthUser } from "./types";
import { resolveJWKS } from "./jwks";

export { resolveJWKS, resetJWKSCache, jwksUrl } from "./jwks";

export interface AuthMiddlewareOptions {
  OIDC_ISSUER_URL?: string;
  OIDC_AUDIENCE?: string;
  /** KV namespace for cross-isolate JWKS caching */
  KV?: KVNamespace;
  /** JWKS cache TTL in seconds (default: 3600) */
  JWKS_CACHE_TTL_SECONDS?: string;
  /** Override JWKS resolution (for testing) */
  jwks?: JWTVerifyGetKey;
}

/**
 * JWT authentication middleware.
 *
 * - If OIDC_ISSUER_URL is not configured, all requests proceed as demo mode (user = null).
 * - If Authorization header is present, validates the JWT. Invalid tokens → 401.
 * - If no Authorization header, proceeds as demo mode (user = null).
 */
export function authMiddleware(env: AuthMiddlewareOptions) {
  const issuer = env.OIDC_ISSUER_URL;
  const audience = env.OIDC_AUDIENCE;
  const jwksOverride = env.jwks;
  const kv = env.KV;
  const ttlSeconds = env.JWKS_CACHE_TTL_SECONDS
    ? parseInt(env.JWKS_CACHE_TTL_SECONDS, 10)
    : undefined;

  return createMiddleware<AppEnv>(async (c, next) => {
    // No OIDC configured — everything is demo mode
    if (!issuer) {
      c.set("user", null);
      return next();
    }

    const authHeader = c.req.header("Authorization");
    if (!authHeader) {
      c.set("user", null);
      return next();
    }

    const match = authHeader.match(/^Bearer\s+(.+)$/i);
    if (!match) {
      return c.json({ error: "Invalid Authorization header format. Expected: Bearer <token>" }, 401);
    }

    const token = match[1];

    try {
      const jwks = jwksOverride ?? await resolveJWKS(issuer, { kv, ttlSeconds });
      const { payload } = await jwtVerify(token, jwks, {
        issuer,
        ...(audience && { audience }),
      });

      const user: AuthUser = {
        sub: payload.sub!,
        email: payload.email as string | undefined,
        name: payload.name as string | undefined,
      };

      c.set("user", user);
    } catch {
      return c.json({ error: "Invalid or expired token" }, 401);
    }

    return next();
  });
}

if (import.meta.vitest) {
  const { test, expect, beforeAll, beforeEach, vi } = import.meta.vitest;
  const { Hono } = await import("hono");
  const { generateKeyPair, SignJWT, exportJWK, createLocalJWKSet } = await import("jose");
  const { resetJWKSCache } = await import("./jwks");

  const TEST_ISSUER = "https://test-issuer.example.com/";
  const TEST_AUDIENCE = "test-audience";

  let privateKey: CryptoKey;
  let localJWKS: JWTVerifyGetKey;

  beforeAll(async () => {
    const kp = await generateKeyPair("RS256");
    privateKey = kp.privateKey as CryptoKey;
    const pub = await exportJWK(kp.publicKey);
    const jwksJson: JSONWebKeySet = { keys: [{ ...pub, kid: "test-key", alg: "RS256" }] };
    localJWKS = createLocalJWKSet(jwksJson);
  });

  beforeEach(() => {
    resetJWKSCache();
  });

  function buildToken(overrides: {
    sub?: string;
    email?: string;
    name?: string;
    issuer?: string;
    audience?: string;
    expiresIn?: string;
  } = {}) {
    return new SignJWT({
      sub: overrides.sub ?? "user-1",
      email: overrides.email ?? "test@example.com",
      name: overrides.name ?? "Test User",
    })
      .setProtectedHeader({ alg: "RS256", kid: "test-key" })
      .setIssuer(overrides.issuer ?? TEST_ISSUER)
      .setAudience(overrides.audience ?? TEST_AUDIENCE)
      .setExpirationTime(overrides.expiresIn ?? "1h")
      .setIssuedAt()
      .sign(privateKey);
  }

  function createTestApp(opts: AuthMiddlewareOptions) {
    const app = new Hono<AppEnv>();
    app.use("*", authMiddleware(opts));
    app.get("/test", (c) => {
      const user = c.get("user");
      return c.json({ user });
    });
    return app;
  }

  // --- Auth middleware tests ---

  test("no OIDC configured → demo mode (user=null)", async () => {
    const app = createTestApp({});
    const res = await app.request("/test");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ user: null });
  });

  test("no Authorization header → demo mode (user=null)", async () => {
    const app = createTestApp({ OIDC_ISSUER_URL: TEST_ISSUER, jwks: localJWKS });
    const res = await app.request("/test");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ user: null });
  });

  test("valid token → user set", async () => {
    const app = createTestApp({
      OIDC_ISSUER_URL: TEST_ISSUER,
      OIDC_AUDIENCE: TEST_AUDIENCE,
      jwks: localJWKS,
    });
    const token = await buildToken();
    const res = await app.request("/test", {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(res.status).toBe(200);
    const body = await res.json() as { user: { sub: string; email: string; name: string } };
    expect(body.user.sub).toBe("user-1");
    expect(body.user.email).toBe("test@example.com");
    expect(body.user.name).toBe("Test User");
  });

  test("expired token → 401", async () => {
    const app = createTestApp({
      OIDC_ISSUER_URL: TEST_ISSUER,
      OIDC_AUDIENCE: TEST_AUDIENCE,
      jwks: localJWKS,
    });
    const token = await buildToken({ expiresIn: "-1s" });
    const res = await app.request("/test", {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(res.status).toBe(401);
  });

  test("wrong audience → 401", async () => {
    const app = createTestApp({
      OIDC_ISSUER_URL: TEST_ISSUER,
      OIDC_AUDIENCE: TEST_AUDIENCE,
      jwks: localJWKS,
    });
    const token = await buildToken({ audience: "wrong-audience" });
    const res = await app.request("/test", {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(res.status).toBe(401);
  });

  test("wrong issuer → 401", async () => {
    const app = createTestApp({
      OIDC_ISSUER_URL: TEST_ISSUER,
      OIDC_AUDIENCE: TEST_AUDIENCE,
      jwks: localJWKS,
    });
    const token = await buildToken({ issuer: "https://wrong-issuer.example.com/" });
    const res = await app.request("/test", {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(res.status).toBe(401);
  });

  test("invalid header format → 401", async () => {
    const app = createTestApp({
      OIDC_ISSUER_URL: TEST_ISSUER,
      jwks: localJWKS,
    });
    const res = await app.request("/test", {
      headers: { Authorization: "Basic abc123" },
    });
    expect(res.status).toBe(401);
  });

  test("garbage token → 401", async () => {
    const app = createTestApp({
      OIDC_ISSUER_URL: TEST_ISSUER,
      jwks: localJWKS,
    });
    const res = await app.request("/test", {
      headers: { Authorization: "Bearer not-a-real-jwt" },
    });
    expect(res.status).toBe(401);
  });

  test("no audience configured → accepts any audience", async () => {
    const app = createTestApp({
      OIDC_ISSUER_URL: TEST_ISSUER,
      jwks: localJWKS,
    });
    const token = await buildToken({ audience: "anything" });
    const res = await app.request("/test", {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(res.status).toBe(200);
  });
}
