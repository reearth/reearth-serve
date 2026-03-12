import { createMiddleware } from "hono/factory";
import { createLocalJWKSet, jwtVerify, type JWTVerifyGetKey, type JSONWebKeySet } from "jose";
import type { AppEnv } from "../types";
import type { AuthUser } from "./types";

const DEFAULT_JWKS_CACHE_TTL = 3600;

// In-memory cache (per isolate)
let memoryCache: { issuer: string; jwks: JWTVerifyGetKey; fetchedAt: number } | null = null;

export function jwksUrl(issuer: string): URL {
  return new URL(".well-known/jwks.json", issuer.endsWith("/") ? issuer : `${issuer}/`);
}

function kvKey(issuer: string): string {
  return `jwks:${issuer}`;
}

/**
 * Resolve JWKS with 3-tier cache: in-memory → KV → remote fetch.
 * Exported for testing.
 */
export async function resolveJWKS(
  issuer: string,
  opts?: { kv?: KVNamespace; ttlSeconds?: number; forceFresh?: boolean },
): Promise<JWTVerifyGetKey> {
  const ttl = opts?.ttlSeconds ?? DEFAULT_JWKS_CACHE_TTL;

  // 1. In-memory cache (same isolate, no I/O)
  if (!opts?.forceFresh && memoryCache && memoryCache.issuer === issuer &&
      Date.now() - memoryCache.fetchedAt < ttl * 1000) {
    return memoryCache.jwks;
  }

  // 2. KV cache (cross-isolate)
  if (!opts?.forceFresh && opts?.kv) {
    const cached = await opts.kv.get<JSONWebKeySet>(kvKey(issuer), "json");
    if (cached) {
      const jwks = createLocalJWKSet(cached);
      memoryCache = { issuer, jwks, fetchedAt: Date.now() };
      return jwks;
    }
  }

  // 3. Fetch from remote
  const res = await fetch(jwksUrl(issuer).toString());
  if (!res.ok) {
    throw new Error(`Failed to fetch JWKS: ${res.status}`);
  }
  const jwksJson = await res.json() as JSONWebKeySet;

  // Store in KV
  if (opts?.kv) {
    await opts.kv.put(kvKey(issuer), JSON.stringify(jwksJson), { expirationTtl: ttl });
  }

  const jwks = createLocalJWKSet(jwksJson);
  memoryCache = { issuer, jwks, fetchedAt: Date.now() };
  return jwks;
}

/** Reset in-memory cache (for testing) */
export function resetJWKSCache(): void {
  memoryCache = null;
}

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

  const TEST_ISSUER = "https://test-issuer.example.com/";
  const TEST_AUDIENCE = "test-audience";

  let privateKey: CryptoKey;
  let localJWKS: JWTVerifyGetKey;
  let jwksJson: JSONWebKeySet;

  beforeAll(async () => {
    const kp = await generateKeyPair("RS256");
    privateKey = kp.privateKey as CryptoKey;
    const pub = await exportJWK(kp.publicKey);
    jwksJson = { keys: [{ ...pub, kid: "test-key", alg: "RS256" }] };
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

  function mockKV(): KVNamespace & { _store: Map<string, string> } {
    const store = new Map<string, string>();
    return {
      _store: store,
      get: vi.fn(async (key: string, type?: string) => {
        const v = store.get(key);
        if (!v) return null;
        return type === "json" ? JSON.parse(v) : v;
      }),
      put: vi.fn(async (key: string, value: string) => {
        store.set(key, value);
      }),
      delete: vi.fn(async (key: string) => { store.delete(key); }),
      list: vi.fn(async () => ({ keys: [], list_complete: true, cacheStatus: null })),
      getWithMetadata: vi.fn(async () => ({ value: null, metadata: null, cacheStatus: null })),
    } as unknown as KVNamespace & { _store: Map<string, string> };
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

  // --- resolveJWKS caching tests ---

  test("resolveJWKS fetches from remote and caches in KV", async () => {
    const kv = mockKV();
    const fetchSpy = vi.fn(() =>
      Promise.resolve(new Response(JSON.stringify(jwksJson), { status: 200 })),
    );
    vi.stubGlobal("fetch", fetchSpy);

    const jwks = await resolveJWKS(TEST_ISSUER, { kv, ttlSeconds: 600 });
    expect(jwks).toBeDefined();
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(kv.put).toHaveBeenCalledWith(
      `jwks:${TEST_ISSUER}`,
      JSON.stringify(jwksJson),
      { expirationTtl: 600 },
    );

    // Verify the cached JWKS actually works for token verification
    const token = await buildToken();
    const { payload } = await jwtVerify(token, jwks, { issuer: TEST_ISSUER, audience: TEST_AUDIENCE });
    expect(payload.sub).toBe("user-1");

    vi.unstubAllGlobals();
  });

  test("resolveJWKS uses KV cache on second call (different isolate)", async () => {
    const kv = mockKV();
    // Pre-populate KV
    kv._store.set(`jwks:${TEST_ISSUER}`, JSON.stringify(jwksJson));

    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);

    const jwks = await resolveJWKS(TEST_ISSUER, { kv });
    expect(fetchSpy).not.toHaveBeenCalled();

    const token = await buildToken();
    const { payload } = await jwtVerify(token, jwks, { issuer: TEST_ISSUER, audience: TEST_AUDIENCE });
    expect(payload.sub).toBe("user-1");

    vi.unstubAllGlobals();
  });

  test("resolveJWKS uses in-memory cache on repeated calls (same isolate)", async () => {
    const kv = mockKV();
    kv._store.set(`jwks:${TEST_ISSUER}`, JSON.stringify(jwksJson));

    // First call → reads from KV
    await resolveJWKS(TEST_ISSUER, { kv });
    expect(kv.get).toHaveBeenCalledTimes(1);

    // Second call → in-memory, no KV read
    await resolveJWKS(TEST_ISSUER, { kv });
    expect(kv.get).toHaveBeenCalledTimes(1);
  });

  test("resolveJWKS forceFresh bypasses all caches", async () => {
    const kv = mockKV();
    kv._store.set(`jwks:${TEST_ISSUER}`, JSON.stringify(jwksJson));

    // Warm up in-memory cache
    await resolveJWKS(TEST_ISSUER, { kv });

    const fetchSpy = vi.fn(() =>
      Promise.resolve(new Response(JSON.stringify(jwksJson), { status: 200 })),
    );
    vi.stubGlobal("fetch", fetchSpy);

    await resolveJWKS(TEST_ISSUER, { kv, forceFresh: true });
    expect(fetchSpy).toHaveBeenCalledTimes(1);

    vi.unstubAllGlobals();
  });

  test("resolveJWKS throws on fetch failure", async () => {
    const fetchSpy = vi.fn(() =>
      Promise.resolve(new Response("Not Found", { status: 404 })),
    );
    vi.stubGlobal("fetch", fetchSpy);

    await expect(resolveJWKS(TEST_ISSUER)).rejects.toThrow("Failed to fetch JWKS: 404");

    vi.unstubAllGlobals();
  });

  test("resolveJWKS works without KV (in-memory only)", async () => {
    const fetchSpy = vi.fn(() =>
      Promise.resolve(new Response(JSON.stringify(jwksJson), { status: 200 })),
    );
    vi.stubGlobal("fetch", fetchSpy);

    const jwks = await resolveJWKS(TEST_ISSUER);
    expect(fetchSpy).toHaveBeenCalledTimes(1);

    // Second call uses in-memory cache
    await resolveJWKS(TEST_ISSUER);
    expect(fetchSpy).toHaveBeenCalledTimes(1);

    const token = await buildToken();
    const { payload } = await jwtVerify(token, jwks, { issuer: TEST_ISSUER, audience: TEST_AUDIENCE });
    expect(payload.sub).toBe("user-1");

    vi.unstubAllGlobals();
  });
}
