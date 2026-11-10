/**
 * The `restricted` branch of `resolveAccess` (ADR-014 §4 Match, §5 step 3).
 *
 * Proofs are tried in the ADR's order: a delivery token that covers the read,
 * then an OIDC bearer, verified here because the auth middleware skips
 * `/files`. Membership is the caller's to decide: this module imports neither
 * Hono nor tenancy, and the file handler injects `authorize`, which binds the
 * caller and asks ADR-016's policy for `read_asset`.
 */

import type { VerifiedCaller } from "../auth/types";
import type { Grant } from "./grant";
import { noStoreHeaders } from "./page";
import type { TokenCarry } from "./request";
import type { AssetPath, DeliveryTokenCodec, UnixSeconds } from "./token";

export type BearerVerifier = (jwt: string) => Promise<VerifiedCaller | null>;

/** What `authorize` answers: allowed, or the refusal to send as-is. */
export type BearerDecision = { ok: true } | { ok: false; response: Response };

export interface RestrictedDeps {
  /** Null where no bearer is accepted: no issuer configured, or a site host. */
  verifyBearer: BearerVerifier | null;
  authorize: (caller: VerifiedCaller) => Promise<BearerDecision>;
  /** Null when `DELIVERY_TOKEN_KEYS` is unset: a token counts as absent. */
  tokens: DeliveryTokenCodec | null;
  siteHost: boolean;
}

export interface RestrictedRead {
  assetId: string;
  /** The version the URL resolved to. */
  versionId: string | null;
  /** The request path, or the source filename for a thumbnail. */
  matchPath: AssetPath;
  carry: TokenCarry;
  authorization: string | null;
  now: UnixSeconds;
}

export type RestrictedResolution =
  | { kind: "allow"; grant: Grant }
  | { kind: "challenge"; response: Response };

/** The JWT of `Authorization: Bearer <jwt>`; any other scheme counts as absent. */
export function bearerToken(header: string | null): string | null {
  const match = header?.match(/^Bearer\s+(\S+)\s*$/i);
  return match ? match[1] : null;
}

/**
 * Does `prefix` cover `path`? Segment-bounded: `tiles` covers `tiles` and
 * `tiles/a`, `tiles/` covers `tiles/a` but not `tiles`, and neither covers
 * `tiles-old/a`.
 */
export function covers(prefix: AssetPath, path: AssetPath): boolean {
  if (prefix === "" || path === prefix) return true;
  return path.startsWith(prefix.endsWith("/") ? prefix : `${prefix}/`);
}

type TokenOutcome = { kind: "absent" } | { kind: "covers"; grant: Grant } | { kind: "out_of_scope" };

async function checkToken(read: RestrictedRead, tokens: DeliveryTokenCodec | null): Promise<TokenOutcome> {
  if (!tokens || read.carry.kind !== "one") return { kind: "absent" };
  const verified = await tokens.verify(read.carry.token, read.now);
  if (!verified.ok || verified.claims.assetId !== read.assetId) return { kind: "absent" };
  const { versionId, prefix, exp } = verified.claims;
  const inScope = (versionId === null || versionId === read.versionId) && covers(prefix, read.matchPath);
  return inScope ? { kind: "covers", grant: { proof: "token", exp } } : { kind: "out_of_scope" };
}

export async function resolveRestricted(read: RestrictedRead, deps: RestrictedDeps): Promise<RestrictedResolution> {
  if (read.carry.kind === "conflict") return { kind: "challenge", response: jsonRefusal(400, "conflicting delivery tokens") };

  const token = await checkToken(read, deps.tokens);
  if (token.kind === "covers") return { kind: "allow", grant: token.grant };

  // A bearer that is present decides, over a token that does not cover the read.
  const jwt = deps.verifyBearer ? bearerToken(read.authorization) : null;
  if (jwt && deps.verifyBearer) {
    const caller = await deps.verifyBearer(jwt);
    if (!caller) return { kind: "challenge", response: restrictedChallengeResponse(deps.siteHost) };
    const decision = await deps.authorize(caller);
    return decision.ok ? { kind: "allow", grant: { proof: "bearer" } } : { kind: "challenge", response: decision.response };
  }

  // The holder of a verified token already knows the asset exists, so this
  // is not a `deniedResponse` 404.
  if (token.kind === "out_of_scope") return { kind: "challenge", response: jsonRefusal(403, "token does not cover this file") };
  return { kind: "challenge", response: restrictedChallengeResponse(deps.siteHost) };
}

function jsonRefusal(status: number, error: string, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify({ error }), {
    status,
    headers: { "Content-Type": "application/json", ...noStoreHeaders(), ...headers },
  });
}

/**
 * The `401` for a restricted asset with no valid proof. It names `ServeToken`
 * whether or not delivery tokens are configured, so a client knows a minted
 * token would help, and browser navigations get the same JSON (ADR-014 §5).
 */
export function restrictedChallengeResponse(siteHost: boolean): Response {
  return jsonRefusal(401, "authentication required", {
    "WWW-Authenticate": siteHost ? "ServeToken" : "Bearer, ServeToken",
  });
}

if (import.meta.vitest) {
  const { test, expect, vi } = import.meta.vitest;
  const { BearerCredential } = await import("../auth/types");

  const caller: VerifiedCaller = { kind: "user", sub: "u1", credential: new BearerCredential("jwt") };
  const now = 1_000 as UnixSeconds;
  const path = (p: string) => p as AssetPath;

  function read(over: Partial<RestrictedRead> = {}): RestrictedRead {
    return {
      assetId: "a1", versionId: "v1", matchPath: path("tiles/0.b3dm"),
      carry: { kind: "none" }, authorization: null, now, ...over,
    };
  }

  /** A codec whose tokens are their own claims, as JSON. */
  const fakeTokens: DeliveryTokenCodec = {
    sign: async () => { throw new Error("not used"); },
    verify: async (token) => {
      if (token === "bad") return { ok: false, reason: "bad_signature" };
      return { ok: true, claims: { v: 1, kid: "k1" as never, exp: 2_000 as UnixSeconds, ...JSON.parse(token) } };
    },
  };
  const tokenFor = (claims: { assetId?: string; versionId?: string | null; prefix?: string }) =>
    ({ kind: "one" as const, token: JSON.stringify({ assetId: "a1", versionId: null, prefix: "", ...claims }) });

  function deps(over: Partial<RestrictedDeps> = {}) {
    return {
      verifyBearer: vi.fn(async (jwt: string) => (jwt === "good" ? caller : null)),
      authorize: vi.fn(async (): Promise<BearerDecision> => ({ ok: true })),
      tokens: fakeTokens,
      siteHost: false,
      ...over,
    };
  }

  test("bearerToken reads only the Bearer scheme", () => {
    expect(bearerToken("Bearer abc")).toBe("abc");
    expect(bearerToken("bearer abc")).toBe("abc");
    expect(bearerToken("Basic abc")).toBeNull();
    expect(bearerToken("Bearer")).toBeNull();
    expect(bearerToken(null)).toBeNull();
  });

  test("covers is segment-bounded", () => {
    const cases: [string, string, boolean][] = [
      ["", "anything/at/all", true],
      ["tiles", "tiles", true],
      ["tiles", "tiles/a", true],
      ["tiles", "tiles-old/a", false],
      ["tiles/", "tiles/a", true],
      ["tiles/", "tiles/", true],
      ["tiles/", "tiles", false],
      ["tiles/", "tiles-old/a", false],
      ["a//b", "a//b/c", true],
      ["a/b", "a//b", false],
    ];
    for (const [prefix, p, expected] of cases) expect(covers(path(prefix), path(p)), `${prefix} ${p}`).toBe(expected);
  });

  test("no bearer, another scheme, or a failed verify is the 401 challenge, and authorize is not called", async () => {
    for (const authorization of [null, "Basic dmlld2VyOng=", "Bearer bad"]) {
      const d = deps();
      const res = await resolveRestricted(read({ authorization }), d);
      expect(res.kind).toBe("challenge");
      if (res.kind !== "challenge") continue;
      expect(res.response.status).toBe(401);
      expect(res.response.headers.get("WWW-Authenticate")).toBe("Bearer, ServeToken");
      expect(res.response.headers.get("Cache-Control")).toBe("no-store");
      expect(await res.response.json()).toEqual({ error: "authentication required" });
      expect(d.authorize).not.toHaveBeenCalled();
    }
  });

  test("a null verifier ignores the bearer and challenges with ServeToken on a site host", async () => {
    const res = await resolveRestricted(read({ authorization: "Bearer good" }), deps({ verifyBearer: null, siteHost: true }));
    expect(res.kind).toBe("challenge");
    if (res.kind === "challenge") expect(res.response.headers.get("WWW-Authenticate")).toBe("ServeToken");
  });

  test("a verified caller is allowed only when authorize says so", async () => {
    const allowed = deps();
    expect(await resolveRestricted(read({ authorization: "Bearer good" }), allowed))
      .toEqual({ kind: "allow", grant: { proof: "bearer" } });
    expect(allowed.authorize).toHaveBeenCalledExactlyOnceWith(caller);

    const refusal = new Response(null, { status: 404 });
    const denied = await resolveRestricted(read({ authorization: "Bearer good" }), deps({
      authorize: async () => ({ ok: false, response: refusal }),
    }));
    expect(denied).toEqual({ kind: "challenge", response: refusal });
  });

  test("a covering token allows with its expiry and never reaches the bearer", async () => {
    const d = deps();
    const res = await resolveRestricted(read({ carry: tokenFor({ prefix: "tiles" }), authorization: "Bearer good" }), d);
    expect(res).toEqual({ kind: "allow", grant: { proof: "token", exp: 2_000 } });
    expect(d.verifyBearer).not.toHaveBeenCalled();
  });

  test("a pinned token matches only its version", async () => {
    expect((await resolveRestricted(read({ carry: tokenFor({ versionId: "v1" }) }), deps())).kind).toBe("allow");
    const other = await resolveRestricted(read({ carry: tokenFor({ versionId: "v0" }) }), deps());
    expect(other.kind === "challenge" && other.response.status).toBe(403);
    const legacy = await resolveRestricted(read({ versionId: null, carry: tokenFor({ versionId: "v1" }) }), deps());
    expect(legacy.kind === "challenge" && legacy.response.status).toBe(403);
  });

  test("an out-of-scope token is 403 without a bearer, and the bearer decides when there is one", async () => {
    const carry = tokenFor({ prefix: "other" });
    const alone = await resolveRestricted(read({ carry }), deps());
    expect(alone.kind).toBe("challenge");
    if (alone.kind === "challenge") {
      expect(alone.response.status).toBe(403);
      expect(alone.response.headers.get("Cache-Control")).toBe("no-store");
    }
    expect(await resolveRestricted(read({ carry, authorization: "Bearer good" }), deps()))
      .toEqual({ kind: "allow", grant: { proof: "bearer" } });
    const badBearer = await resolveRestricted(read({ carry, authorization: "Bearer bad" }), deps());
    expect(badBearer.kind === "challenge" && badBearer.response.status).toBe(401);
    const siteHost = await resolveRestricted(read({ carry, authorization: "Bearer good" }), deps({ verifyBearer: null }));
    expect(siteHost.kind === "challenge" && siteHost.response.status).toBe(403);
  });

  test("a token that fails verify, names another asset, or has no codec counts as no token", async () => {
    for (const [carry, tokens] of [
      [{ kind: "one", token: "bad" }, fakeTokens],
      [tokenFor({ assetId: "a2" }), fakeTokens],
      [tokenFor({}), null],
    ] as const) {
      const res = await resolveRestricted(read({ carry }), deps({ tokens }));
      expect(res.kind === "challenge" && res.response.status).toBe(401);
    }
  });

  test("two distinct tokens are 400 no-store, before any proof is tried", async () => {
    const d = deps();
    const res = await resolveRestricted(read({ carry: { kind: "conflict" }, authorization: "Bearer good" }), d);
    expect(res.kind).toBe("challenge");
    if (res.kind === "challenge") {
      expect(res.response.status).toBe(400);
      expect(res.response.headers.get("Cache-Control")).toBe("no-store");
    }
    expect(d.verifyBearer).not.toHaveBeenCalled();
  });
}
