import { createLocalJWKSet, type JWTVerifyGetKey, type JSONWebKeySet } from "jose";
import type { KeyValue } from "../kv/port";

const DEFAULT_JWKS_CACHE_TTL = 3600;
// Cap remote JWKS lookup so cold-start auth doesn't block on a slow OIDC provider.
const JWKS_FETCH_TIMEOUT_MS = 3000;

// In-memory cache (per isolate)
let memoryCache: { issuer: string; jwks: JWTVerifyGetKey; fetchedAt: number } | null = null;

export function jwksUrl(issuer: string): URL {
  return new URL(".well-known/jwks.json", issuer.endsWith("/") ? issuer : `${issuer}/`);
}

function jwksCacheKey(issuer: string): string {
  return `jwks:${issuer}`;
}

/**
 * Resolve JWKS with 3-tier cache: in-memory → shared cache → remote fetch.
 *
 * The cross-isolate tier is the generic `KeyValue` port (ADR-012 §2), so the
 * same code caches into Cloudflare KV in production and into the in-memory
 * store in tests. Exported for testing.
 */
export async function resolveJWKS(
  issuer: string,
  opts?: { cache?: KeyValue; ttlSeconds?: number; forceFresh?: boolean },
): Promise<JWTVerifyGetKey> {
  const ttl = opts?.ttlSeconds ?? DEFAULT_JWKS_CACHE_TTL;

  // 1. In-memory cache (same isolate, no I/O)
  if (!opts?.forceFresh && memoryCache && memoryCache.issuer === issuer &&
      Date.now() - memoryCache.fetchedAt < ttl * 1000) {
    return memoryCache.jwks;
  }

  // 2. Shared cache (cross-isolate)
  if (!opts?.forceFresh && opts?.cache) {
    const cached = await opts.cache.get(jwksCacheKey(issuer));
    if (cached) {
      const jwks = createLocalJWKSet(JSON.parse(cached) as JSONWebKeySet);
      memoryCache = { issuer, jwks, fetchedAt: Date.now() };
      return jwks;
    }
  }

  // 3. Fetch from remote
  const res = await fetch(jwksUrl(issuer).toString(), {
    signal: AbortSignal.timeout(JWKS_FETCH_TIMEOUT_MS),
  });
  if (!res.ok) {
    throw new Error(`Failed to fetch JWKS: ${res.status}`);
  }
  const jwksJson = await res.json() as JSONWebKeySet;

  // Store in the shared cache
  if (opts?.cache) {
    await opts.cache.put(jwksCacheKey(issuer), JSON.stringify(jwksJson), { ttlSeconds: ttl });
  }

  const jwks = createLocalJWKSet(jwksJson);
  memoryCache = { issuer, jwks, fetchedAt: Date.now() };
  return jwks;
}

/** Reset in-memory cache (for testing) */
export function resetJWKSCache(): void {
  memoryCache = null;
}

if (import.meta.vitest) {
  const { test, expect, beforeAll, beforeEach, vi } = import.meta.vitest;
  const { generateKeyPair, SignJWT, exportJWK, jwtVerify } = await import("jose");

  const TEST_ISSUER = "https://test-issuer.example.com/";
  const TEST_AUDIENCE = "test-audience";

  let privateKey: CryptoKey;
  let jwksJson: JSONWebKeySet;

  beforeAll(async () => {
    const kp = await generateKeyPair("RS256");
    privateKey = kp.privateKey as CryptoKey;
    const pub = await exportJWK(kp.publicKey);
    jwksJson = { keys: [{ ...pub, kid: "test-key", alg: "RS256" }] };
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

  function mockCache(): KeyValue & { _store: Map<string, string> } {
    const store = new Map<string, string>();
    return {
      _store: store,
      get: vi.fn(async (key: string) => store.get(key) ?? null),
      put: vi.fn(async (key: string, value: string) => {
        store.set(key, value);
      }),
      delete: vi.fn(async (key: string) => {
        store.delete(key);
      }),
    };
  }

  // --- resolveJWKS caching tests ---

  test("resolveJWKS fetches from remote and caches it", async () => {
    const cache = mockCache();
    const fetchSpy = vi.fn(() =>
      Promise.resolve(new Response(JSON.stringify(jwksJson), { status: 200 })),
    );
    vi.stubGlobal("fetch", fetchSpy);

    const jwks = await resolveJWKS(TEST_ISSUER, { cache, ttlSeconds: 600 });
    expect(jwks).toBeDefined();
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(cache.put).toHaveBeenCalledWith(
      `jwks:${TEST_ISSUER}`,
      JSON.stringify(jwksJson),
      { ttlSeconds: 600 },
    );

    // Verify the cached JWKS actually works for token verification
    const token = await buildToken();
    const { payload } = await jwtVerify(token, jwks, { issuer: TEST_ISSUER, audience: TEST_AUDIENCE });
    expect(payload.sub).toBe("user-1");

    vi.unstubAllGlobals();
  });

  test("resolveJWKS uses the shared cache on second call (different isolate)", async () => {
    const cache = mockCache();
    // Pre-populate the shared cache
    cache._store.set(`jwks:${TEST_ISSUER}`, JSON.stringify(jwksJson));

    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);

    const jwks = await resolveJWKS(TEST_ISSUER, { cache });
    expect(fetchSpy).not.toHaveBeenCalled();

    const token = await buildToken();
    const { payload } = await jwtVerify(token, jwks, { issuer: TEST_ISSUER, audience: TEST_AUDIENCE });
    expect(payload.sub).toBe("user-1");

    vi.unstubAllGlobals();
  });

  test("resolveJWKS uses in-memory cache on repeated calls (same isolate)", async () => {
    const cache = mockCache();
    cache._store.set(`jwks:${TEST_ISSUER}`, JSON.stringify(jwksJson));

    // First call → reads from the shared cache
    await resolveJWKS(TEST_ISSUER, { cache });
    expect(cache.get).toHaveBeenCalledTimes(1);

    // Second call → in-memory, no shared-cache read
    await resolveJWKS(TEST_ISSUER, { cache });
    expect(cache.get).toHaveBeenCalledTimes(1);
  });

  test("resolveJWKS forceFresh bypasses all caches", async () => {
    const cache = mockCache();
    cache._store.set(`jwks:${TEST_ISSUER}`, JSON.stringify(jwksJson));

    // Warm up in-memory cache
    await resolveJWKS(TEST_ISSUER, { cache });

    const fetchSpy = vi.fn(() =>
      Promise.resolve(new Response(JSON.stringify(jwksJson), { status: 200 })),
    );
    vi.stubGlobal("fetch", fetchSpy);

    await resolveJWKS(TEST_ISSUER, { cache, forceFresh: true });
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

  test("resolveJWKS works without a shared cache (in-memory only)", async () => {
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
