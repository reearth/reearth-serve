/**
 * What a read was allowed on, and the response policy that follows from it
 * (ADR-013 B7, ADR-014 §4 Response, §5). The proof is the one fact every
 * protected response header depends on, so it keys one table instead of a
 * boolean per header.
 */

import type { UnixSeconds } from "./token";

export type Grant =
  | { proof: "none" }
  | { proof: "cookie" }
  | { proof: "basic" }
  | { proof: "bearer" }
  | { proof: "token"; exp: UnixSeconds };

export type AccessProof = Grant["proof"];

export interface DeliveryPolicy {
  proof: AccessProof;
  /** `private` in place of `public` in `Cache-Control`. */
  private: boolean;
  /** Request headers the answer depends on; `Origin` is CORS's to add. */
  vary: readonly string[];
  /** Misses and redirects are `no-store`. */
  noStoreMisses: boolean;
  noReferrer: boolean;
  /** Seconds the token has left: no cache may outlive the proof. */
  maxAgeCap: number | null;
}

// A cache sits in front of the decision, so a restricted answer varies on
// every header that could have changed it, whichever one decided.
const RESTRICTED_VARY = ["Authorization", "X-Serve-Token"];
const PASSWORD_VARY = ["Cookie", "Authorization"];

const BY_PROOF = {
  none: { private: false, vary: [], noStoreMisses: false, noReferrer: false },
  cookie: { private: true, vary: PASSWORD_VARY, noStoreMisses: false, noReferrer: false },
  basic: { private: true, vary: PASSWORD_VARY, noStoreMisses: false, noReferrer: false },
  bearer: { private: true, vary: RESTRICTED_VARY, noStoreMisses: true, noReferrer: false },
  token: { private: true, vary: RESTRICTED_VARY, noStoreMisses: true, noReferrer: true },
} as const satisfies Record<AccessProof, Omit<DeliveryPolicy, "proof" | "maxAgeCap">>;

export function deliveryPolicy(grant: Grant, now: UnixSeconds): DeliveryPolicy {
  return {
    proof: grant.proof,
    ...BY_PROOF[grant.proof],
    maxAgeCap: grant.proof === "token" ? Math.max(0, grant.exp - now) : null,
  };
}

if (import.meta.vitest) {
  const { test, expect } = import.meta.vitest;
  const now = 1_000 as UnixSeconds;

  test("a token caps the cache at its remaining life, floored at zero", () => {
    expect(deliveryPolicy({ proof: "token", exp: 1_600 as UnixSeconds }, now).maxAgeCap).toBe(600);
    expect(deliveryPolicy({ proof: "token", exp: 990 as UnixSeconds }, now).maxAgeCap).toBe(0);
    expect(deliveryPolicy({ proof: "bearer" }, now).maxAgeCap).toBeNull();
  });

  test("only a token read sends no-referrer, and only restricted proofs vary on X-Serve-Token", () => {
    const token = deliveryPolicy({ proof: "token", exp: now }, now);
    expect(token.noReferrer).toBe(true);
    expect(token.vary).toContain("X-Serve-Token");
    expect(deliveryPolicy({ proof: "bearer" }, now).vary).toContain("X-Serve-Token");
    expect(deliveryPolicy({ proof: "cookie" }, now).vary).not.toContain("X-Serve-Token");
    expect(deliveryPolicy({ proof: "none" }, now)).toMatchObject({ private: false, vary: [], noStoreMisses: false });
  });
}
