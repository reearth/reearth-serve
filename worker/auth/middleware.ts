import { createMiddleware } from "hono/factory";
import { jwtVerify, type JWTVerifyGetKey, type JSONWebKeySet } from "jose";
import type { AppEnv } from "../types";
import type { AuthUser } from "./types";
import type { KeyValue } from "../kv/port";
import { resolveJWKS } from "./jwks";

export { resolveJWKS, resetJWKSCache, jwksUrl } from "./jwks";

/**
 * Provider-independent authentication configuration. The composition root
 * translates environment variables and bindings into this shape (ADR-012 §1);
 * the middleware itself never reads `Env`.
 */
export interface AuthConfig {
  issuer?: string;
  audience?: string;
  /** Cross-isolate JWKS cache. Optional — the in-isolate cache always applies. */
  jwksCache?: KeyValue;
  /** JWKS cache TTL in seconds (default: 3600) */
  jwksCacheTtlSeconds?: number;
  /** Override JWKS resolution (for testing) */
  jwks?: JWTVerifyGetKey;
}

/**
 * JWT authentication middleware.
 *
 * - If no issuer is configured, all requests proceed as demo mode (user = null).
 * - If Authorization header is present, validates the JWT. Invalid tokens → 401.
 * - If no Authorization header, proceeds as demo mode (user = null).
 */
export function authMiddleware(config: AuthConfig) {
  const issuer = config.issuer;
  const audience = config.audience;
  const jwksOverride = config.jwks;
  const cache = config.jwksCache;
  const ttlSeconds = config.jwksCacheTtlSeconds;

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
      const jwks = jwksOverride ?? await resolveJWKS(issuer, { cache, ttlSeconds });
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

  function createTestApp(opts: AuthConfig) {
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
    const app = createTestApp({ issuer: TEST_ISSUER, jwks: localJWKS });
    const res = await app.request("/test");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ user: null });
  });

  test("valid token → user set", async () => {
    const app = createTestApp({
      issuer: TEST_ISSUER,
      audience: TEST_AUDIENCE,
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
      issuer: TEST_ISSUER,
      audience: TEST_AUDIENCE,
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
      issuer: TEST_ISSUER,
      audience: TEST_AUDIENCE,
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
      issuer: TEST_ISSUER,
      audience: TEST_AUDIENCE,
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
      issuer: TEST_ISSUER,
      jwks: localJWKS,
    });
    const res = await app.request("/test", {
      headers: { Authorization: "Basic abc123" },
    });
    expect(res.status).toBe(401);
  });

  test("garbage token → 401", async () => {
    const app = createTestApp({
      issuer: TEST_ISSUER,
      jwks: localJWKS,
    });
    const res = await app.request("/test", {
      headers: { Authorization: "Bearer not-a-real-jwt" },
    });
    expect(res.status).toBe(401);
  });

  test("no audience configured → accepts any audience", async () => {
    const app = createTestApp({
      issuer: TEST_ISSUER,
      jwks: localJWKS,
    });
    const token = await buildToken({ audience: "anything" });
    const res = await app.request("/test", {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(res.status).toBe(200);
  });
}
