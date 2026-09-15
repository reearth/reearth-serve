/**
 * CORS for file delivery, as a function of the asset's access mode.
 *
 * Cross-origin *reads* of public files are the product — a tileset loaded by
 * somebody else's viewer, a GeoJSON fetched by a notebook — so public assets
 * answer `Access-Control-Allow-Origin: *` and always have.
 *
 * A protected asset cannot: the Fetch spec forbids combining `*` with
 * credentials, and the cookie and the `Authorization` header are exactly what
 * a protected asset is read with. So the handler echoes the request's `Origin`
 * and sets `Access-Control-Allow-Credentials: true`, with `Vary: Origin`
 * because the answer now differs per caller. A page embedding a protected
 * tileset must therefore fetch with `credentials: "include"` (or send Basic) —
 * the one place protection changes how an asset is consumed, which is why
 * `access` is visible in the API response.
 *
 * This is why the blanket `cors()` middleware is gone from the file routes: the
 * policy cannot be decided until the asset row has been read, and a middleware
 * runs before that.
 */

export interface CorsPolicy {
  /** True when the asset is password-protected (ADR-013 B7). */
  protected: boolean;
  /** The request's `Origin`, if it sent one. */
  origin: string | null;
}

const PREFLIGHT_METHODS = "GET, HEAD, OPTIONS";
const PREFLIGHT_DEFAULT_HEADERS = "Authorization, Range, If-None-Match, Content-Type";
const PREFLIGHT_MAX_AGE = "86400";

/** Add the access headers for `policy` to `headers`, in place. */
export function applyCors(headers: Headers, policy: CorsPolicy): void {
  if (!policy.protected) {
    headers.set("Access-Control-Allow-Origin", "*");
    return;
  }
  headers.set("Access-Control-Allow-Credentials", "true");
  addVary(headers, "Origin");
  // With no `Origin` there is no cross-origin request to allow, and echoing
  // nothing is better than echoing a value we made up.
  if (policy.origin) headers.set("Access-Control-Allow-Origin", policy.origin);
}

/** The `204` answer to a preflight. Carries no body and needs no proof. */
export function preflightResponse(request: Request, policy: CorsPolicy): Response {
  const headers = new Headers({
    "Access-Control-Allow-Methods": PREFLIGHT_METHODS,
    "Access-Control-Allow-Headers":
      request.headers.get("Access-Control-Request-Headers") ?? PREFLIGHT_DEFAULT_HEADERS,
    "Access-Control-Max-Age": PREFLIGHT_MAX_AGE,
  });
  applyCors(headers, policy);
  return new Response(null, { status: 204, headers });
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

  test("public assets keep the wildcard and no credentials", () => {
    const headers = new Headers();
    applyCors(headers, { protected: false, origin: "https://app.example" });
    expect(headers.get("Access-Control-Allow-Origin")).toBe("*");
    expect(headers.get("Access-Control-Allow-Credentials")).toBeNull();
    expect(headers.get("Vary")).toBeNull();
  });

  test("protected assets echo the origin and allow credentials", () => {
    const headers = new Headers();
    applyCors(headers, { protected: true, origin: "https://app.example" });
    expect(headers.get("Access-Control-Allow-Origin")).toBe("https://app.example");
    expect(headers.get("Access-Control-Allow-Credentials")).toBe("true");
    expect(headers.get("Vary")).toBe("Origin");
  });

  test("a protected response with no Origin allows nothing cross-origin", () => {
    const headers = new Headers();
    applyCors(headers, { protected: true, origin: null });
    expect(headers.get("Access-Control-Allow-Origin")).toBeNull();
  });

  test("addVary merges instead of overwriting", () => {
    const headers = new Headers({ Vary: "Accept-Encoding" });
    addVary(headers, "Cookie", "Authorization", "accept-encoding");
    expect(headers.get("Vary")).toBe("Accept-Encoding, Cookie, Authorization");
  });
}
