/**
 * The `restricted` branch of `resolveAccess` (ADR-014 §5 step 3).
 *
 * The only proof today is an OIDC bearer, verified here because the auth
 * middleware skips `/files`. Membership is the caller's to decide: this module
 * imports neither Hono nor tenancy, and the file handler injects `authorize`,
 * which binds the caller and asks ADR-016's policy for `read_asset`.
 */

import type { VerifiedCaller } from "../auth/types";
import { noStoreHeaders } from "./page";

export type BearerVerifier = (jwt: string) => Promise<VerifiedCaller | null>;

/** What `authorize` answers: allowed, or the refusal to send as-is. */
export type BearerDecision = { ok: true } | { ok: false; response: Response };

export interface RestrictedDeps {
  /** Null where no bearer is accepted: no issuer configured, or a site host. */
  verifyBearer: BearerVerifier | null;
  authorize: (caller: VerifiedCaller) => Promise<BearerDecision>;
  siteHost: boolean;
}

export type RestrictedResolution =
  | { kind: "allow"; proof: "bearer" }
  | { kind: "challenge"; response: Response };

/** The JWT of `Authorization: Bearer <jwt>`; any other scheme counts as absent. */
export function bearerToken(header: string | null): string | null {
  const match = header?.match(/^Bearer\s+(\S+)\s*$/i);
  return match ? match[1] : null;
}

export async function resolveRestricted(request: Request, deps: RestrictedDeps): Promise<RestrictedResolution> {
  const jwt = deps.verifyBearer ? bearerToken(request.headers.get("Authorization")) : null;
  const caller = jwt && deps.verifyBearer ? await deps.verifyBearer(jwt) : null;
  if (!caller) return { kind: "challenge", response: restrictedChallengeResponse(deps.siteHost) };
  const decision = await deps.authorize(caller);
  return decision.ok ? { kind: "allow", proof: "bearer" } : { kind: "challenge", response: decision.response };
}

/**
 * The `401` for a restricted asset with no valid proof. It names `ServeToken`
 * whether or not delivery tokens are configured, so a client knows a minted
 * token would help, and browser navigations get the same JSON (ADR-014 §5).
 */
export function restrictedChallengeResponse(siteHost: boolean): Response {
  return new Response(JSON.stringify({ error: "authentication required" }), {
    status: 401,
    headers: {
      "Content-Type": "application/json",
      "WWW-Authenticate": siteHost ? "ServeToken" : "Bearer, ServeToken",
      ...noStoreHeaders(),
    },
  });
}

if (import.meta.vitest) {
  const { test, expect, vi } = import.meta.vitest;
  const { BearerCredential } = await import("../auth/types");

  const caller: VerifiedCaller = { kind: "user", sub: "u1", credential: new BearerCredential("jwt") };
  const req = (authorization?: string) =>
    new Request("https://example.test/files/a", authorization ? { headers: { Authorization: authorization } } : {});

  function deps(over: Partial<RestrictedDeps> = {}) {
    return {
      verifyBearer: vi.fn(async (jwt: string) => (jwt === "good" ? caller : null)),
      authorize: vi.fn(async (): Promise<BearerDecision> => ({ ok: true })),
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

  test("no bearer, another scheme, or a failed verify is the 401 challenge, and authorize is not called", async () => {
    for (const header of [undefined, "Basic dmlld2VyOng=", "Bearer bad"]) {
      const d = deps();
      const res = await resolveRestricted(req(header), d);
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
    const res = await resolveRestricted(req("Bearer good"), deps({ verifyBearer: null, siteHost: true }));
    expect(res.kind).toBe("challenge");
    if (res.kind === "challenge") expect(res.response.headers.get("WWW-Authenticate")).toBe("ServeToken");
  });

  test("a verified caller is allowed only when authorize says so", async () => {
    const allowed = deps();
    expect(await resolveRestricted(req("Bearer good"), allowed)).toEqual({ kind: "allow", proof: "bearer" });
    expect(allowed.authorize).toHaveBeenCalledExactlyOnceWith(caller);

    const refusal = new Response(null, { status: 404 });
    const denied = await resolveRestricted(req("Bearer good"), deps({
      authorize: async () => ({ ok: false, response: refusal }),
    }));
    expect(denied).toEqual({ kind: "challenge", response: refusal });
  });
}
