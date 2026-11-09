import { createLocalJWKSet, type JWTVerifyGetKey, type JSONWebKeySet } from "jose";
import type { KeyValue } from "../kv/port";

const DEFAULT_JWKS_CACHE_TTL = 3600;
// Cap the whole remote lookup (discovery + key fetch share one budget) so
// cold-start auth doesn't block on a slow OIDC provider.
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
function jwksUrl(issuer: string): URL {
  return new URL(".well-known/jwks.json", issuerBase(issuer));
}

function describeFetchError(e: unknown): string {
  return e instanceof Error && e.name === "TimeoutError"
    ? `timed out after ${JWKS_FETCH_TIMEOUT_MS}ms`
    : `request failed: ${String(e)}`;
}

type DiscoveryResult = { uri: URL } | { reason: string };

/** Fetch and validate the discovery document; never throws. */
async function discover(issuer: string, signal: AbortSignal): Promise<DiscoveryResult> {
  let res: Response;
  try {
    res = await fetch(new URL(".well-known/openid-configuration", issuerBase(issuer)).toString(), { signal });
  } catch (e) {
    return { reason: describeFetchError(e) };
  }
  if (!res.ok) {
    // Release the unread body so the connection can return to the pool.
    await res.body?.cancel().catch(() => {});
    return { reason: `HTTP ${res.status}` };
  }

  let config: { issuer?: unknown; jwks_uri?: unknown };
  try {
    const parsed: unknown = await res.json();
    if (typeof parsed !== "object" || parsed === null) return { reason: "document is not a JSON object" };
    config = parsed;
  } catch {
    return { reason: "document is not valid JSON" };
  }

  // OIDC Discovery 1.0 §4.3: the document's issuer must match exactly.
  if (config.issuer !== issuer) {
    return { reason: `issuer mismatch: document says ${JSON.stringify(config.issuer)}` };
  }
  if (typeof config.jwks_uri !== "string" || config.jwks_uri === "") {
    return { reason: "document has no jwks_uri" };
  }
  let uri: URL;
  try {
    uri = new URL(config.jwks_uri);
  } catch {
    return { reason: `jwks_uri is not a valid URL: ${JSON.stringify(config.jwks_uri)}` };
  }
  // Never let discovery downgrade the key fetch to plain http: an
  // on-path attacker could swap in their own signing keys.
  const allowed = new URL(issuer).protocol === "http:" ? ["http:", "https:"] : ["https:"];
  if (!allowed.includes(uri.protocol)) {
    return { reason: `jwks_uri scheme ${uri.protocol} is not allowed for this issuer: ${uri}` };
  }
  return { uri };
}

/**
 * Resolve the JWKS endpoint for an issuer. Prefers `jwks_uri` from OIDC
 * discovery (`{issuer}/.well-known/openid-configuration`), since providers
 * differ (e.g. Dex serves `{issuer}/keys`). Falls back to `jwksUrl(issuer)`,
 * with a warning naming the reason, when discovery fails, times out, or
 * returns no usable `jwks_uri`. Pass `signal` to share a timeout budget
 * with the key fetch that follows.
 */
export async function discoverJwksUri(
  issuer: string,
  signal: AbortSignal = AbortSignal.timeout(JWKS_FETCH_TIMEOUT_MS),
): Promise<URL> {
  const result = await discover(issuer, signal);
  if ("uri" in result) return result.uri;
  const fallback = jwksUrl(issuer);
  console.warn(`OIDC discovery for ${issuer} failed (${result.reason}); falling back to ${fallback}`);
  return fallback;
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

  // 3. Fetch from remote. Discovery and the key fetch share one timeout budget.
  const signal = AbortSignal.timeout(JWKS_FETCH_TIMEOUT_MS);
  const uri = await discoverJwksUri(issuer, signal);
  let res: Response;
  try {
    res = await fetch(uri.toString(), { signal });
  } catch (e) {
    throw new Error(`Failed to fetch JWKS from ${uri}: ${describeFetchError(e)}`);
  }
  if (!res.ok) {
    await res.body?.cancel().catch(() => {});
    throw new Error(`Failed to fetch JWKS from ${uri}: HTTP ${res.status}`);
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
  const { test, expect, beforeAll, beforeEach, afterEach, vi } = import.meta.vitest;
  const { generateKeyPair, SignJWT, exportJWK, jwtVerify } = await import("jose");

  const TEST_ISSUER = "https://test-issuer.example.com/";
  const TEST_AUDIENCE = "test-audience";
  const DISCOVERY_URL = `${TEST_ISSUER}.well-known/openid-configuration`;
  const FALLBACK_JWKS_URL = `${TEST_ISSUER}.well-known/jwks.json`;
  const KEYS_URL = `${TEST_ISSUER}keys`;

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

  // Runs even when an assertion fails, so a stubbed fetch or a silenced
  // console never leaks into the next test.
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
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

  async function expectVerifies(jwks: JWTVerifyGetKey) {
    const token = await buildToken();
    const { payload } = await jwtVerify(token, jwks, { issuer: TEST_ISSUER, audience: TEST_AUDIENCE });
    expect(payload.sub).toBe("user-1");
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

  /** Stub fetch with a URL → response table; unknown URLs return 404. */
  function routedFetch(routes: Record<string, () => Response | Promise<Response>>) {
    const spy = vi.fn((input: string | URL | Request, _init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      const route = routes[url];
      return Promise.resolve(route ? route() : new Response("Not Found", { status: 404 }));
    });
    vi.stubGlobal("fetch", spy);
    return spy;
  }

  /** A provider whose discovery advertises keys at `{issuer}keys` (Dex-style). */
  function discoveryRoutes() {
    return {
      [DISCOVERY_URL]: () => Response.json({ issuer: TEST_ISSUER, jwks_uri: KEYS_URL }),
      [KEYS_URL]: () => Response.json(jwksJson),
    };
  }

  function fetchedUrls(spy: ReturnType<typeof routedFetch>): string[] {
    return spy.mock.calls.map((c) => String(c[0]));
  }

  /** Silence the expected discovery-fallback warning; returns the spy. */
  function silenceWarn() {
    return vi.spyOn(console, "warn").mockImplementation(() => {});
  }

  /** Assert discovery falls back to the conventional URL and warns once with `reason`. */
  async function expectFallback(reason: RegExp, issuer = TEST_ISSUER) {
    const warn = silenceWarn();
    expect((await discoverJwksUri(issuer)).toString()).toBe(jwksUrl(issuer).toString());
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0][0])).toMatch(reason);
    warn.mockRestore();
  }

  // --- resolveJWKS caching tests ---

  test("resolveJWKS fetches from remote and caches it", async () => {
    const cache = mockCache();
    const spy = routedFetch(discoveryRoutes());

    const jwks = await resolveJWKS(TEST_ISSUER, { cache, ttlSeconds: 600 });
    expect(fetchedUrls(spy)).toEqual([DISCOVERY_URL, KEYS_URL]);
    expect(cache.put).toHaveBeenCalledWith(
      `jwks:${TEST_ISSUER}`,
      JSON.stringify(jwksJson),
      { ttlSeconds: 600 },
    );

    // Verify the cached JWKS actually works for token verification
    await expectVerifies(jwks);
  });

  test("resolveJWKS uses the shared cache with no fetch at all (different isolate)", async () => {
    const cache = mockCache();
    // Pre-populate the shared cache
    cache._store.set(`jwks:${TEST_ISSUER}`, JSON.stringify(jwksJson));
    const spy = routedFetch(discoveryRoutes());

    const jwks = await resolveJWKS(TEST_ISSUER, { cache });
    expect(fetchedUrls(spy)).toEqual([]);

    await expectVerifies(jwks);
  });

  test("resolveJWKS uses in-memory cache on repeated calls (same isolate)", async () => {
    const cache = mockCache();
    cache._store.set(`jwks:${TEST_ISSUER}`, JSON.stringify(jwksJson));
    const spy = routedFetch(discoveryRoutes());

    // First call → reads from the shared cache
    await resolveJWKS(TEST_ISSUER, { cache });
    expect(cache.get).toHaveBeenCalledTimes(1);

    // Second call → in-memory, no shared-cache read
    await resolveJWKS(TEST_ISSUER, { cache });
    expect(cache.get).toHaveBeenCalledTimes(1);
    expect(fetchedUrls(spy)).toEqual([]);
  });

  test("resolveJWKS forceFresh bypasses all caches", async () => {
    const cache = mockCache();
    cache._store.set(`jwks:${TEST_ISSUER}`, JSON.stringify(jwksJson));
    const spy = routedFetch(discoveryRoutes());

    // Warm up in-memory cache
    await resolveJWKS(TEST_ISSUER, { cache });
    expect(fetchedUrls(spy)).toEqual([]);

    await resolveJWKS(TEST_ISSUER, { cache, forceFresh: true });
    expect(fetchedUrls(spy)).toEqual([DISCOVERY_URL, KEYS_URL]);
  });

  test("resolveJWKS works without a shared cache (in-memory only)", async () => {
    const spy = routedFetch(discoveryRoutes());

    const jwks = await resolveJWKS(TEST_ISSUER);
    expect(fetchedUrls(spy)).toEqual([DISCOVERY_URL, KEYS_URL]);

    // Second call uses in-memory cache
    await resolveJWKS(TEST_ISSUER);
    expect(fetchedUrls(spy)).toEqual([DISCOVERY_URL, KEYS_URL]);

    await expectVerifies(jwks);
  });

  test("resolveJWKS throws, naming the URL, when the fallback key fetch fails", async () => {
    silenceWarn();
    routedFetch({});

    await expect(resolveJWKS(TEST_ISSUER)).rejects.toThrow(
      `Failed to fetch JWKS from ${FALLBACK_JWKS_URL}: HTTP 404`,
    );
  });

  // --- JWKS endpoint discovery ---

  test("discoverJwksUri handles an issuer without a trailing slash", async () => {
    routedFetch({
      "https://dex.example.com/dex/.well-known/openid-configuration": () =>
        Response.json({ issuer: "https://dex.example.com/dex", jwks_uri: "https://dex.example.com/dex/keys" }),
    });

    const uri = await discoverJwksUri("https://dex.example.com/dex");
    expect(uri.toString()).toBe("https://dex.example.com/dex/keys");
  });

  test("discoverJwksUri falls back on non-2xx and releases the response body", async () => {
    let cancelled = false;
    routedFetch({
      [DISCOVERY_URL]: () => new Response(new ReadableStream({ cancel() { cancelled = true; } }), { status: 503 }),
    });
    await expectFallback(/HTTP 503/);
    expect(cancelled).toBe(true);
  });

  test("discoverJwksUri falls back when jwks_uri is missing or invalid", async () => {
    const cases: [Record<string, unknown>, RegExp][] = [
      [{}, /no jwks_uri/],
      [{ jwks_uri: "" }, /no jwks_uri/],
      [{ jwks_uri: 42 }, /no jwks_uri/],
      [{ jwks_uri: "not a url" }, /not a valid URL/],
      [{ jwks_uri: "file:///etc/keys" }, /scheme file: is not allowed/],
    ];
    for (const [body, reason] of cases) {
      routedFetch({ [DISCOVERY_URL]: () => Response.json({ issuer: TEST_ISSUER, ...body }) });
      await expectFallback(reason);
    }
  });

  test("discoverJwksUri falls back when the document's issuer is missing or differs", async () => {
    for (const body of [
      { jwks_uri: KEYS_URL },
      { issuer: "http://other-tenant/", jwks_uri: KEYS_URL },
      // Exact match: a trailing-slash difference is a misconfiguration too.
      { issuer: TEST_ISSUER.replace(/\/$/, ""), jwks_uri: KEYS_URL },
    ]) {
      routedFetch({ [DISCOVERY_URL]: () => Response.json(body) });
      await expectFallback(/issuer mismatch/);
    }
  });

  test("discoverJwksUri rejects an http jwks_uri for an https issuer", async () => {
    routedFetch({
      [DISCOVERY_URL]: () => Response.json({ issuer: TEST_ISSUER, jwks_uri: "http://attacker.example/keys" }),
    });
    await expectFallback(/scheme http: is not allowed/);
  });

  test("discoverJwksUri accepts an http jwks_uri for an http issuer (local Dex)", async () => {
    routedFetch({
      "http://localhost:5556/dex/.well-known/openid-configuration": () =>
        Response.json({ issuer: "http://localhost:5556/dex", jwks_uri: "http://localhost:5556/dex/keys" }),
    });
    expect((await discoverJwksUri("http://localhost:5556/dex")).toString()).toBe("http://localhost:5556/dex/keys");
  });

  test("discoverJwksUri falls back on malformed JSON, timeout or network error", async () => {
    routedFetch({ [DISCOVERY_URL]: () => new Response("<html>", { status: 200 }) });
    await expectFallback(/not valid JSON/);

    routedFetch({ [DISCOVERY_URL]: () => Response.json(null) });
    await expectFallback(/not a JSON object/);

    vi.stubGlobal("fetch", vi.fn(() => Promise.reject(new DOMException("aborted", "TimeoutError"))));
    await expectFallback(/timed out/);

    vi.stubGlobal("fetch", vi.fn(() => Promise.reject(new TypeError("network down"))));
    await expectFallback(/request failed: TypeError: network down/);
  });

  test("resolveJWKS shares one timeout budget between discovery and the key fetch", async () => {
    const spy = routedFetch(discoveryRoutes());

    await resolveJWKS(TEST_ISSUER);
    const signals = spy.mock.calls.map((c) => c[1]?.signal);
    expect(signals).toHaveLength(2);
    expect(signals[0]).toBeDefined();
    expect(signals[1]).toBe(signals[0]);
  });

  test("resolveJWKS names the URL when the key fetch times out", async () => {
    routedFetch({
      [DISCOVERY_URL]: () => Response.json({ issuer: TEST_ISSUER, jwks_uri: KEYS_URL }),
      [KEYS_URL]: () => Promise.reject(new DOMException("aborted", "TimeoutError")),
    });

    await expect(resolveJWKS(TEST_ISSUER)).rejects.toThrow(
      `Failed to fetch JWKS from ${KEYS_URL}: timed out after 3000ms`,
    );
  });

  test("resolveJWKS still works via the fallback path when discovery is unavailable", async () => {
    silenceWarn();
    const spy = routedFetch({ [FALLBACK_JWKS_URL]: () => Response.json(jwksJson) });

    const jwks = await resolveJWKS(TEST_ISSUER);
    expect(fetchedUrls(spy)).toEqual([DISCOVERY_URL, FALLBACK_JWKS_URL]);

    await expectVerifies(jwks);
  });
}
