import { createMiddleware } from "hono/factory";
import { jwtVerify, type JWTVerifyGetKey, type JSONWebKeySet } from "jose";
import type { AppEnv } from "../types";
import { BearerCredential, type VerifiedCaller } from "./types";
import type { KeyValue } from "../kv/port";
import { resolveJWKS } from "./jwks";

export { resolveJWKS, resetJWKSCache } from "./jwks";

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

type Verification =
  | { ok: true; caller: VerifiedCaller }
  | { ok: false; reason: "no_subject" | "invalid" };

async function verify(token: string, config: AuthConfig & { issuer: string }): Promise<Verification> {
  try {
    const jwks = config.jwks ?? await resolveJWKS(config.issuer, {
      cache: config.jwksCache, ttlSeconds: config.jwksCacheTtlSeconds,
    });
    const { payload } = await jwtVerify(token, jwks, {
      issuer: config.issuer,
      ...(config.audience && { audience: config.audience }),
    });
    if (typeof payload.sub !== "string" || payload.sub === "") return { ok: false, reason: "no_subject" };
    return {
      ok: true,
      caller: {
        kind: "user",
        sub: payload.sub,
        email: payload.email as string | undefined,
        name: payload.name as string | undefined,
        credential: new BearerCredential(token),
      },
    };
  } catch {
    return { ok: false, reason: "invalid" };
  }
}

/**
 * Verify an OIDC access token the way the middleware does. Null for any
 * failure, a JWKS fetch failure included, and always null when no issuer is
 * configured. `/files` calls it itself, because the middleware skips that
 * path (ADR-014 §5).
 */
export async function verifyAccessToken(token: string, config: AuthConfig): Promise<VerifiedCaller | null> {
  const issuer = config.issuer;
  if (!issuer) return null;
  const result = await verify(token, { ...config, issuer });
  return result.ok ? result.caller : null;
}

/**
 * JWT authentication middleware.
 *
 * - If Authorization header is present, validates the JWT. Invalid tokens → 401.
 */
export function authMiddleware(config: AuthConfig) {
  const issuer = config.issuer;

  return createMiddleware<AppEnv>(async (c, next) => {
    // No OIDC configured — everything is demo mode
    if (!issuer) {
      c.set("caller", null);
      return next();
    }

    const authHeader = c.req.header("Authorization");
    if (!authHeader) {
      c.set("caller", null);
      return next();
    }

    const match = authHeader.match(/^Bearer\s+(.+)$/i);
    if (!match) {
      return c.json({ error: "Invalid Authorization header format. Expected: Bearer <token>" }, 401);
    }

    const result = await verify(match[1], { ...config, issuer });
    if (!result.ok) {
      return c.json({ error: result.reason === "no_subject" ? "Token has no subject" : "Invalid or expired token" }, 401);
    }
    c.set("caller", result.caller);
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
    app.get("/test", (c) => c.json({ caller: c.get("caller") }));
    return app;
  }

  test("no OIDC configured → demo mode (caller=null)", async () => {
    const app = createTestApp({});
    const res = await app.request("/test");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ caller: null });
  });

  test("no Authorization header → demo mode (caller=null)", async () => {
    const app = createTestApp({ issuer: TEST_ISSUER, jwks: localJWKS });
    const res = await app.request("/test");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ caller: null });
  });

  test("valid token → caller set, with the token redacted", async () => {
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
    const text = await res.text();
    expect(text).not.toContain(token);
    expect(JSON.parse(text)).toEqual({
      caller: { kind: "user", sub: "user-1", email: "test@example.com", name: "Test User", credential: "[redacted]" },
    });
  });

  test.each<[string, Record<string, unknown>]>([
    ["no sub", {}],
    ["an empty sub", { sub: "" }],
    ["a numeric sub", { sub: 42 }],
  ])("a verified token with %s → 401", async (_, claims) => {
    const app = createTestApp({ issuer: TEST_ISSUER, audience: TEST_AUDIENCE, jwks: localJWKS });
    const token = await new SignJWT(claims)
      .setProtectedHeader({ alg: "RS256", kid: "test-key" })
      .setIssuer(TEST_ISSUER)
      .setAudience(TEST_AUDIENCE)
      .setExpirationTime("1h")
      .sign(privateKey);
    const res = await app.request("/test", { headers: { Authorization: `Bearer ${token}` } });
    expect(res.status).toBe(401);
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

  test("the middleware keeps its distinct 401 messages", async () => {
    const app = createTestApp({ issuer: TEST_ISSUER, jwks: localJWKS });
    const noSub = await new SignJWT({})
      .setProtectedHeader({ alg: "RS256", kid: "test-key" })
      .setIssuer(TEST_ISSUER).setExpirationTime("1h").sign(privateKey);
    const bodyOf = async (authorization: string) =>
      (await app.request("/test", { headers: { Authorization: authorization } })).json();
    expect(await bodyOf(`Bearer ${noSub}`)).toEqual({ error: "Token has no subject" });
    expect(await bodyOf("Bearer nope")).toEqual({ error: "Invalid or expired token" });
    expect(await bodyOf("Basic abc")).toEqual({ error: "Invalid Authorization header format. Expected: Bearer <token>" });
  });

  test("verifyAccessToken returns the caller for a valid token and null for anything else", async () => {
    const config = { issuer: TEST_ISSUER, audience: TEST_AUDIENCE, jwks: localJWKS };
    const caller = await verifyAccessToken(await buildToken(), config);
    expect(caller).toMatchObject({ kind: "user", sub: "user-1", email: "test@example.com" });
    expect(await verifyAccessToken("not-a-jwt", config)).toBeNull();
    expect(await verifyAccessToken(await buildToken({ expiresIn: "-1s" }), config)).toBeNull();
    expect(await verifyAccessToken(await buildToken(), {})).toBeNull();
    const unreachable = vi.fn(async () => { throw new Error("JWKS fetch failed"); });
    expect(await verifyAccessToken(await buildToken(), { ...config, jwks: unreachable as unknown as JWTVerifyGetKey })).toBeNull();
    expect(unreachable).toHaveBeenCalled();
  });
}
