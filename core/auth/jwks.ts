import { createLocalJWKSet, type JWTVerifyGetKey, type JSONWebKeySet } from "jose";
import type { KeyValue } from "../kv/port";

const DEFAULT_JWKS_CACHE_TTL = 3600;
// Cap remote JWKS lookup so cold-start auth doesn't block on a slow OIDC provider.
const JWKS_FETCH_TIMEOUT_MS = 3000;

// In-memory cache (per isolate)
let memoryCache: { issuer: string; jwks: JWTVerifyGetKey; fetchedAt: number } | null = null;

function issuerBase(issuer: string): string {
  return issuer.endsWith("/") ? issuer : `${issuer}/`;
}

/**
 * Conventional JWKS location (`{issuer}/.well-known/jwks.json`). Used only as
 * a fallback when OIDC discovery is unavailable or omits `jwks_uri`.
 */
export function jwksUrl(issuer: string): URL {
  return new URL(".well-known/jwks.json", issuerBase(issuer));
}

/**
 * Resolve the JWKS endpoint for an issuer. Prefers `jwks_uri` from OIDC
 * discovery (`{issuer}/.well-known/openid-configuration`), since providers
 * differ (e.g. Dex serves `{issuer}/keys`). Falls back to `jwksUrl(issuer)`
 * when discovery fails, times out, or returns no usable `jwks_uri`.
 */
export async function discoverJwksUri(issuer: string): Promise<URL> {
  try {
    const res = await fetch(new URL(".well-known/openid-configuration", issuerBase(issuer)).toString(), {
      signal: AbortSignal.timeout(JWKS_FETCH_TIMEOUT_MS),
    });
    if (res.ok) {
      const config = await res.json() as { jwks_uri?: unknown };
      if (typeof config.jwks_uri === "string" && config.jwks_uri !== "") {
        const uri = new URL(config.jwks_uri);
        if (uri.protocol === "https:" || uri.protocol === "http:") return uri;
      }
    }
  } catch {
    // Discovery is best-effort; fall through to the conventional path.
  }
  return jwksUrl(issuer);
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
  const uri = await discoverJwksUri(issuer);
  const res = await fetch(uri.toString(), {
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
    // Discovery (no jwks_uri in this mock → fallback) + JWKS fetch
    expect(fetchSpy).toHaveBeenCalledTimes(2);
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
    expect(fetchSpy).toHaveBeenCalledTimes(2);

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
    expect(fetchSpy).toHaveBeenCalledTimes(2);

    // Second call uses in-memory cache
    await resolveJWKS(TEST_ISSUER);
    expect(fetchSpy).toHaveBeenCalledTimes(2);

    const token = await buildToken();
    const { payload } = await jwtVerify(token, jwks, { issuer: TEST_ISSUER, audience: TEST_AUDIENCE });
    expect(payload.sub).toBe("user-1");

    vi.unstubAllGlobals();
  });

  // --- JWKS endpoint discovery ---

  /** Stub fetch with a path → response table; unknown paths return 404. */
  function routedFetch(routes: Record<string, () => Response | Promise<Response>>) {
    const spy = vi.fn((input: string | URL | Request) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      const route = routes[url];
      return Promise.resolve(route ? route() : new Response("Not Found", { status: 404 }));
    });
    vi.stubGlobal("fetch", spy);
    return spy;
  }

  const DISCOVERY_URL = `${TEST_ISSUER}.well-known/openid-configuration`;
  const FALLBACK_JWKS_URL = `${TEST_ISSUER}.well-known/jwks.json`;

  test("resolveJWKS uses jwks_uri from OIDC discovery (Dex-style /keys)", async () => {
    const dexKeys = `${TEST_ISSUER}keys`;
    const spy = routedFetch({
      [DISCOVERY_URL]: () => Response.json({ issuer: TEST_ISSUER, jwks_uri: dexKeys }),
      [dexKeys]: () => Response.json(jwksJson),
    });

    const jwks = await resolveJWKS(TEST_ISSUER);
    expect(spy.mock.calls.map((c) => String(c[0]))).toEqual([DISCOVERY_URL, dexKeys]);

    const token = await buildToken();
    const { payload } = await jwtVerify(token, jwks, { issuer: TEST_ISSUER, audience: TEST_AUDIENCE });
    expect(payload.sub).toBe("user-1");

    vi.unstubAllGlobals();
  });

  test("discoverJwksUri handles an issuer without a trailing slash", async () => {
    routedFetch({
      "https://dex.example.com/dex/.well-known/openid-configuration": () =>
        Response.json({ jwks_uri: "https://dex.example.com/dex/keys" }),
    });

    const uri = await discoverJwksUri("https://dex.example.com/dex");
    expect(uri.toString()).toBe("https://dex.example.com/dex/keys");

    vi.unstubAllGlobals();
  });

  test("discoverJwksUri falls back when discovery returns non-2xx", async () => {
    routedFetch({});
    expect((await discoverJwksUri(TEST_ISSUER)).toString()).toBe(FALLBACK_JWKS_URL);
    vi.unstubAllGlobals();
  });

  test("discoverJwksUri falls back when jwks_uri is missing or invalid", async () => {
    for (const body of [{}, { jwks_uri: "" }, { jwks_uri: 42 }, { jwks_uri: "not a url" }, { jwks_uri: "file:///etc/keys" }]) {
      routedFetch({ [DISCOVERY_URL]: () => Response.json(body) });
      expect((await discoverJwksUri(TEST_ISSUER)).toString()).toBe(FALLBACK_JWKS_URL);
    }
    vi.unstubAllGlobals();
  });

  test("discoverJwksUri falls back on malformed JSON or network error", async () => {
    routedFetch({ [DISCOVERY_URL]: () => new Response("<html>", { status: 200 }) });
    expect((await discoverJwksUri(TEST_ISSUER)).toString()).toBe(FALLBACK_JWKS_URL);

    vi.stubGlobal("fetch", vi.fn(() => Promise.reject(new TypeError("network down"))));
    expect((await discoverJwksUri(TEST_ISSUER)).toString()).toBe(FALLBACK_JWKS_URL);

    vi.unstubAllGlobals();
  });

  test("resolveJWKS still works via the fallback path when discovery is unavailable", async () => {
    const spy = routedFetch({ [FALLBACK_JWKS_URL]: () => Response.json(jwksJson) });

    const jwks = await resolveJWKS(TEST_ISSUER);
    expect(spy.mock.calls.map((c) => String(c[0]))).toEqual([DISCOVERY_URL, FALLBACK_JWKS_URL]);

    const token = await buildToken();
    const { payload } = await jwtVerify(token, jwks, { issuer: TEST_ISSUER, audience: TEST_AUDIENCE });
    expect(payload.sub).toBe("user-1");

    vi.unstubAllGlobals();
  });
}
