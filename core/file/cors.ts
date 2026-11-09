/**
 * CORS for file delivery, as a function of the proof a response was served on.
 *
 * Cross-origin *reads* of public files are the product (a tileset loaded by
 * somebody else's viewer, a GeoJSON fetched by a notebook), so anything served
 * without a credential answers `Access-Control-Allow-Origin: *`.
 *
 * Credentialed CORS is the dangerous half: echoing any `Origin` with
 * `Access-Control-Allow-Credentials: true` lets every page on the web read a
 * protected asset with the visitor's cookie. So only a cookie proof is ever
 * answered with credentials, and only for an origin Serve trusts: its own, or
 * one listed in `CREDENTIALED_ORIGINS`. Basic and bearer are sent by the caller
 * on purpose and need no credentialed CORS, so they get `*` like a public read.
 *
 * Preflights and refusals carry no proof at all. They tell a trusted origin
 * that credentials are welcome and everyone else `*`, whatever the asset's
 * mode, so they disclose nothing about it.
 *
 * This is why the blanket `cors()` middleware is gone from the file routes: the
 * policy cannot be decided until the asset row has been read, and a middleware
 * runs before that.
 */

import type { AccessProof } from "../access/resolve";

export interface CorsPolicy {
  /** What the response was authorized by; null for a preflight or a refusal. */
  proof: AccessProof | null;
  /** The request's `Origin`, if it sent one. */
  origin: string | null;
  /** Origins that may read with credentials: Serve's own plus `CREDENTIALED_ORIGINS`. */
  trustedOrigins: readonly string[];
}

const PREFLIGHT_METHODS = "GET, HEAD, OPTIONS";
const PREFLIGHT_HEADERS = "range, if-none-match, if-modified-since, authorization";
const PREFLIGHT_MAX_AGE = "86400";
/** A cross-origin client must read the challenge and the retry delay (ADR-014 §5). */
const EXPOSE_HEADERS = "WWW-Authenticate, Retry-After";

function credentialed(policy: CorsPolicy): boolean {
  if (policy.proof !== null && policy.proof !== "cookie") return false;
  return policy.origin !== null && policy.origin !== "null" && policy.trustedOrigins.includes(policy.origin);
}

/** Add the access headers for `policy` to `headers`, in place. */
export function applyCors(headers: Headers, policy: CorsPolicy): void {
  headers.set("Access-Control-Expose-Headers", EXPOSE_HEADERS);
  if (policy.proof !== "none") addVary(headers, "Origin");
  if (policy.proof === "cookie") headers.set("Cross-Origin-Resource-Policy", "same-origin");
  if (credentialed(policy)) {
    headers.set("Access-Control-Allow-Origin", policy.origin!);
    headers.set("Access-Control-Allow-Credentials", "true");
    return;
  }
  headers.set("Access-Control-Allow-Origin", "*");
  headers.delete("Access-Control-Allow-Credentials");
}

/** The `204` answer to a preflight. Carries no body and needs no proof. */
export function preflightResponse(policy: Omit<CorsPolicy, "proof">): Response {
  const headers = new Headers({
    "Access-Control-Allow-Methods": PREFLIGHT_METHODS,
    "Access-Control-Allow-Headers": PREFLIGHT_HEADERS,
    "Access-Control-Max-Age": PREFLIGHT_MAX_AGE,
  });
  applyCors(headers, { ...policy, proof: null });
  return new Response(null, { status: 204, headers });
}

/**
 * Parse `CREDENTIALED_ORIGINS`: comma-separated exact origins.
 *
 * Throws on anything that is not exactly an origin. A path would never match
 * an `Origin` header and hides a typo; a wildcard or `null` would hand
 * credentialed reads to pages nobody chose.
 */
export function parseCredentialedOrigins(value: string | undefined): string[] {
  const entries = (value ?? "").split(",").map((v) => v.trim()).filter(Boolean);
  return entries.map((entry) => {
    let origin: string | null = null;
    if (!entry.includes("*") && entry !== "null") {
      try {
        origin = new URL(entry).origin;
      } catch {
        origin = null;
      }
    }
    if (!origin || origin === "null" || origin !== entry) {
      throw new Error(
        `CREDENTIALED_ORIGINS entry "${entry}" is not an exact origin (scheme://host[:port], lowercase, no path, wildcard or null)`,
      );
    }
    return origin;
  });
}

/**
 * Append values to `Vary` without dropping what is already there.
 *
 * A gzip-stored file already varies on `Accept-Encoding`; a protected one adds
 * `Cookie, Authorization` (the proof changes the answer) and `Origin`. Setting
 * the header would silently lose whichever of them was written first.
 */
export function addVary(headers: Headers, ...values: string[]): void {
  const present = new Set(
    (headers.get("Vary") ?? "")
      .split(",")
      .map((v) => v.trim())
      .filter(Boolean)
      .map((v) => v.toLowerCase()),
  );
  const merged = (headers.get("Vary") ?? "").split(",").map((v) => v.trim()).filter(Boolean);
  for (const value of values) {
    if (present.has(value.toLowerCase())) continue;
    present.add(value.toLowerCase());
    merged.push(value);
  }
  if (merged.length > 0) headers.set("Vary", merged.join(", "));
}

if (import.meta.vitest) {
  const { test, expect } = import.meta.vitest;
  const OWN = "https://serve.example.com";
  const policy = (proof: AccessProof | null, origin: string | null): CorsPolicy =>
    ({ proof, origin, trustedOrigins: [OWN, "https://viewer.example.net"] });

  test("public reads keep the wildcard and no credentials", () => {
    const headers = new Headers();
    applyCors(headers, policy("none", OWN));
    expect(headers.get("Access-Control-Allow-Origin")).toBe("*");
    expect(headers.get("Access-Control-Allow-Credentials")).toBeNull();
    expect(headers.get("Vary")).toBeNull();
  });

  test("a cookie proof is credentialed for a trusted origin only", () => {
    for (const origin of [OWN, "https://viewer.example.net"]) {
      const headers = new Headers();
      applyCors(headers, policy("cookie", origin));
      expect(headers.get("Access-Control-Allow-Origin")).toBe(origin);
      expect(headers.get("Access-Control-Allow-Credentials")).toBe("true");
      expect(headers.get("Vary")).toBe("Origin");
      expect(headers.get("Cross-Origin-Resource-Policy")).toBe("same-origin");
    }
    for (const origin of ["https://evil.example", "null", null]) {
      const headers = new Headers();
      applyCors(headers, policy("cookie", origin));
      expect(headers.get("Access-Control-Allow-Origin")).toBe("*");
      expect(headers.get("Access-Control-Allow-Credentials")).toBeNull();
    }
  });

  test("Basic never gets credentialed CORS, even from a trusted origin", () => {
    const headers = new Headers();
    applyCors(headers, policy("basic", OWN));
    expect(headers.get("Access-Control-Allow-Origin")).toBe("*");
    expect(headers.get("Access-Control-Allow-Credentials")).toBeNull();
    expect(headers.get("Vary")).toBe("Origin");
    expect(headers.get("Cross-Origin-Resource-Policy")).toBeNull();
  });

  test("a bearer proof gets * without credentials, even from a trusted origin", () => {
    const headers = new Headers();
    applyCors(headers, policy("bearer", OWN));
    expect(headers.get("Access-Control-Allow-Origin")).toBe("*");
    expect(headers.get("Access-Control-Allow-Credentials")).toBeNull();
    expect(headers.get("Vary")).toBe("Origin");
  });

  test("every response and every preflight exposes the challenge and the retry delay", () => {
    for (const proof of ["none", "cookie", "basic", "bearer", null] as const) {
      const headers = new Headers();
      applyCors(headers, policy(proof, "https://evil.example"));
      expect(headers.get("Access-Control-Expose-Headers")).toBe("WWW-Authenticate, Retry-After");
    }
    const preflight = preflightResponse({ origin: null, trustedOrigins: [OWN] });
    expect(preflight.headers.get("Access-Control-Expose-Headers")).toBe("WWW-Authenticate, Retry-After");
  });

  test("a refusal credentials a trusted origin and gives everyone else *", () => {
    const trusted = new Headers();
    applyCors(trusted, policy(null, OWN));
    expect(trusted.get("Access-Control-Allow-Origin")).toBe(OWN);
    expect(trusted.get("Access-Control-Allow-Credentials")).toBe("true");
    const other = new Headers();
    applyCors(other, policy(null, "https://evil.example"));
    expect(other.get("Access-Control-Allow-Origin")).toBe("*");
    expect(other.get("Access-Control-Allow-Credentials")).toBeNull();
    expect(other.get("Vary")).toBe("Origin");
  });

  test("a preflight allows fixed headers instead of echoing the request", () => {
    const res = preflightResponse({ origin: "https://evil.example", trustedOrigins: [OWN] });
    expect(res.status).toBe(204);
    expect(res.headers.get("Access-Control-Allow-Headers")).toBe(PREFLIGHT_HEADERS);
    expect(res.headers.get("Access-Control-Max-Age")).toBe("86400");
    expect(res.headers.get("Access-Control-Allow-Origin")).toBe("*");
  });

  test("CREDENTIALED_ORIGINS accepts exact origins and refuses everything else", () => {
    expect(parseCredentialedOrigins(undefined)).toEqual([]);
    expect(parseCredentialedOrigins(" https://a.example.com, http://localhost:3000 "))
      .toEqual(["https://a.example.com", "http://localhost:3000"]);
    for (const bad of ["https://a.example.com/app", "https://*.example.com", "*", "null", "a.example.com", "https://A.example.com"]) {
      expect(() => parseCredentialedOrigins(bad)).toThrow(/CREDENTIALED_ORIGINS/);
    }
  });

  test("addVary merges instead of overwriting", () => {
    const headers = new Headers({ Vary: "Accept-Encoding" });
    addVary(headers, "Cookie", "Authorization", "accept-encoding");
    expect(headers.get("Vary")).toBe("Accept-Encoding, Cookie, Authorization");
  });
}
