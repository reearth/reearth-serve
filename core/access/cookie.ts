/**
 * The viewer-authentication cookie (ADR-013 B7).
 *
 * A password check costs a PBKDF2; doing one per file of a hosted site would
 * make the site unusable. The cookie carries the *result* of one check, signed
 * so the server needs no session row to trust it:
 *
 *     rs_site_auth = base64url( assetId · passwordVersion · exp · HMAC-SHA256(secret, the same three) )
 *
 * - **`assetId`** binds the cookie to one asset, so a cookie minted on one
 *   protected site proves nothing about another (on a site host the origin
 *   already separates them; on the apex `/files/{id}` path form only this
 *   field does).
 * - **`passwordVersion`** is the asset's counter, bumped on every password
 *   change. Rotating the password therefore invalidates every outstanding
 *   cookie without any server-side state to sweep.
 * - **`exp`** is a UNIX timestamp in seconds; the lifetime is 7 days.
 *
 * The secret is `SIGNING_SECRET` — the name ADR-014 §4 reserves for signed
 * URLs, so both proofs share one deployment secret and one rotation.
 */

/** Cookie name, identical on a site host and on the apex. */
export const AUTH_COOKIE = "rs_site_auth";

/** ADR-013 B7: "lifetime 7 days". */
export const COOKIE_MAX_AGE_SECONDS = 7 * 24 * 60 * 60;

const SEPARATOR = ".";

function base64urlEncode(value: string): string {
  const bytes = new TextEncoder().encode(value);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function base64urlDecode(value: string): string | null {
  try {
    const padded = value.replace(/-/g, "+").replace(/_/g, "/");
    return atob(padded + "=".repeat((4 - (padded.length % 4)) % 4));
  } catch {
    return null;
  }
}

function toHex(bytes: Uint8Array): string {
  return [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function sign(secret: string, payload: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const mac = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(payload));
  return toHex(new Uint8Array(mac));
}

export interface CookieClaims {
  assetId: string;
  passwordVersion: number;
  /** Expiry, UNIX seconds. */
  exp: number;
}

/** Mint a cookie value for `claims`. */
export async function mintAuthCookie(secret: string, claims: CookieClaims): Promise<string> {
  const payload = `${claims.assetId}${SEPARATOR}${claims.passwordVersion}${SEPARATOR}${claims.exp}`;
  const mac = await sign(secret, payload);
  return base64urlEncode(`${payload}${SEPARATOR}${mac}`);
}

/**
 * True when `value` is a cookie this deployment minted for this asset at this
 * password version, and it has not expired.
 *
 * Everything is checked: a forged signature, a cookie for another asset, one
 * from before a password change, and one past its expiry are all rejected.
 */
export async function verifyAuthCookie(
  secret: string,
  value: string | undefined | null,
  expected: { assetId: string; passwordVersion: number; now: number },
): Promise<boolean> {
  if (!value) return false;
  const decoded = base64urlDecode(value);
  if (!decoded) return false;

  const parts = decoded.split(SEPARATOR);
  if (parts.length !== 4) return false;
  const [assetId, versionText, expText, mac] = parts;

  const payload = `${assetId}${SEPARATOR}${versionText}${SEPARATOR}${expText}`;
  const want = await sign(secret, payload);
  // Compared before the claims so a forged cookie and a stale one take the
  // same path through this function.
  if (!timingSafeEqual(mac, want)) return false;

  if (assetId !== expected.assetId) return false;
  if (versionText !== String(expected.passwordVersion)) return false;

  const exp = Number.parseInt(expText, 10);
  if (!Number.isSafeInteger(exp)) return false;
  return exp > Math.floor(expected.now / 1000);
}

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let mismatch = 0;
  for (let i = 0; i < a.length; i++) mismatch |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return mismatch === 0;
}

/** Parse a `Cookie` header into a map. Unparseable pairs are skipped. */
export function parseCookieHeader(header: string | null | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const pair of (header ?? "").split(";")) {
    const eq = pair.indexOf("=");
    if (eq === -1) continue;
    const name = pair.slice(0, eq).trim();
    if (!name) continue;
    out[name] = pair.slice(eq + 1).trim();
  }
  return out;
}

/**
 * Build the `Set-Cookie` value.
 *
 * `Secure` is on everywhere except plain-http loopback, where a browser would
 * drop the cookie and local development of a protected site would be
 * impossible. `SameSite=Lax` keeps the cookie off cross-site subresource
 * requests while still arriving on a top-level navigation — which is how a
 * visitor reaches the page after the `303`.
 */
export function buildSetCookie(opts: {
  value: string;
  path: string;
  secure: boolean;
  maxAgeSeconds?: number;
}): string {
  const parts = [
    `${AUTH_COOKIE}=${opts.value}`,
    `Path=${opts.path}`,
    `Max-Age=${opts.maxAgeSeconds ?? COOKIE_MAX_AGE_SECONDS}`,
    "HttpOnly",
    "SameSite=Lax",
  ];
  if (opts.secure) parts.push("Secure");
  return parts.join("; ");
}

/**
 * Whether the cookie may carry `Secure`.
 *
 * Loopback over plain http is the one exception (see {@link buildSetCookie});
 * every other plain-http deployment gets `Secure` anyway, which is a cookie
 * that never comes back — the honest outcome for serving a password over
 * cleartext.
 */
export function shouldUseSecureCookie(url: URL): boolean {
  if (url.protocol === "https:") return true;
  const host = url.hostname.replace(/^\[|\]$/g, "");
  return !(host === "localhost" || host === "127.0.0.1" || host === "::1");
}
