import type { CompatCredential } from "../model";
import type { CredentialLookup } from "./auth";

export type SignedRequest = { method: string; url: URL; headers: Headers };

export type SignedUrlConfig = {
  /**
   * The configured compat API host, never the received Host, which an application may
   * rewrite after signing. The client signs its hostname without the port.
   */
  apiHost: string;
  pathPrefix: string | null;
  now: number;
};

export type SignedUrlFailure = "malformed" | "not_yet_valid" | "expired" | "unknown_credential" | "signature_mismatch" | "unsupported";

export type SignedUrlClaim = {
  clientEmail: string;
  timestamp: string;
  scope: string;
  signedAt: number;
  expiresSeconds: number;
  signedHeaders: string[];
  signature: Uint8Array<ArrayBuffer>;
};

const ALGORITHM = "GOOG4-RSA-SHA256";
const SIGNATURE_PARAM = "X-Goog-Signature";
const MAX_EXPIRES_SECONDS = 7 * 24 * 3600;
const CLOCK_TOLERANCE_MS = 60_000;

export function isSignedRequest(url: URL): boolean {
  return url.searchParams.has(SIGNATURE_PARAM);
}

export function parseSignedPathPrefix(value: string | undefined): string | null {
  const trimmed = value?.trim().replace(/\/+$/, "");
  if (!trimmed) return null;
  if (!/^(\/[A-Za-z0-9._~!$&'()*+,;=:@-]+)+$/.test(trimmed)) {
    throw new Error(`COMPAT_SIGNED_PATH_PREFIX "${value}" is not a path like /uploads`);
  }
  return trimmed;
}

export function objectPathOf(rawPath: string, prefix: string | null): string | null {
  let path: string;
  try {
    path = decodeURIComponent(rawPath);
  } catch {
    return null;
  }
  if (prefix && (path === prefix || path.startsWith(`${prefix}/`))) path = path.slice(prefix.length);
  return path.startsWith("/") ? path.slice(1) : null;
}

/** Go's `url.QueryEscape` with a space as `%20`, which `signedURLV4` uses for the path and the query. */
function goEscape(text: string): string {
  return encodeURIComponent(text).replace(/[!'()*]/g, (ch) => `%${ch.charCodeAt(0).toString(16).toUpperCase()}`);
}

function hexBytes(hex: string): Uint8Array<ArrayBuffer> | null {
  if (hex.length === 0 || hex.length % 2 !== 0 || !/^[0-9a-f]+$/i.test(hex)) return null;
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i++) bytes[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return bytes;
}

function hexOf(bytes: ArrayBuffer): string {
  return [...new Uint8Array(bytes)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export function parseSignedUrl(url: URL): SignedUrlClaim | null {
  const q = url.searchParams;
  const single = (name: string) => (q.getAll(name).length === 1 ? q.get(name) : null);
  if (single("X-Goog-Algorithm") !== ALGORITHM) return null;
  const credential = single("X-Goog-Credential");
  const timestamp = single("X-Goog-Date");
  const expires = single("X-Goog-Expires");
  const signedHeaders = single("X-Goog-SignedHeaders");
  const signature = hexBytes(single(SIGNATURE_PARAM) ?? "");
  if (!credential || !timestamp || !expires || !signedHeaders || !signature) return null;

  const date = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/.exec(timestamp);
  const slash = credential.indexOf("/");
  const scope = credential.slice(slash + 1);
  if (!date || slash < 1 || !new RegExp(`^${timestamp.slice(0, 8)}/[^/]+/storage/goog4_request$`).test(scope)) return null;
  if (!/^\d{1,6}$/.test(expires) || Number(expires) < 1 || Number(expires) > MAX_EXPIRES_SECONDS) return null;
  const headers = signedHeaders.split(";");
  if (!headers.includes("host") || headers.some((h) => !/^[a-z0-9-]+$/.test(h))) return null;

  const [, y, mo, d, h, mi, s] = date.map(Number);
  return {
    clientEmail: credential.slice(0, slash),
    timestamp,
    scope,
    signedAt: Date.UTC(y!, mo! - 1, d!, h!, mi!, s!),
    expiresSeconds: Number(expires),
    signedHeaders: headers,
    signature,
  };
}

export function canonicalRequest(req: SignedRequest, claim: SignedUrlClaim, cfg: Omit<SignedUrlConfig, "now">): string | null {
  const objectPath = objectPathOf(req.url.pathname, cfg.pathPrefix);
  if (objectPath === null) return null;
  const path = `/${objectPath.split("/").map(goEscape).join("/")}`;

  const byKey = new Map<string, string[]>();
  for (const [k, v] of req.url.searchParams) {
    if (k !== SIGNATURE_PARAM) byKey.set(k, [...(byKey.get(k) ?? []), v]);
  }
  const query = [...byKey.keys()].sort()
    .flatMap((k) => byKey.get(k)!.map((v) => `${goEscape(k)}=${goEscape(v)}`))
    .join("&");

  const hostname = cfg.apiHost.replace(/:\d+$/, "");
  const headers = claim.signedHeaders.map((name) => {
    const value = name === "host" ? hostname : (req.headers.get(name) ?? "");
    return `${name}:${value.trim().replace(/\s+/g, " ")}`;
  });
  return [req.method, path, query, headers.join("\n") + "\n", claim.signedHeaders.join(";"), "UNSIGNED-PAYLOAD"].join("\n");
}

async function stringToSign(claim: SignedUrlClaim, canonical: string): Promise<Uint8Array<ArrayBuffer>> {
  const digest = hexOf(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(canonical)));
  return new TextEncoder().encode([ALGORITHM, claim.timestamp, claim.scope, digest].join("\n"));
}

async function signatureValid(credential: CompatCredential, claim: SignedUrlClaim, canonical: string): Promise<boolean> {
  const key = await crypto.subtle.importKey(
    "jwk",
    { kty: credential.publicJwk.kty, n: credential.publicJwk.n, e: credential.publicJwk.e },
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["verify"],
  );
  return crypto.subtle.verify("RSASSA-PKCS1-v1_5", key, claim.signature, await stringToSign(claim, canonical));
}

export async function verifySignedUrl(
  store: CredentialLookup,
  req: SignedRequest,
  cfg: SignedUrlConfig,
): Promise<{ ok: true; credential: CompatCredential } | { ok: false; failure: SignedUrlFailure }> {
  const claim = parseSignedUrl(req.url);
  if (!claim) return { ok: false, failure: "malformed" };
  if (claim.signedHeaders.includes("x-goog-content-sha256")) return { ok: false, failure: "unsupported" };
  if (claim.signedAt > cfg.now + CLOCK_TOLERANCE_MS) return { ok: false, failure: "not_yet_valid" };
  if (cfg.now > claim.signedAt + claim.expiresSeconds * 1000) return { ok: false, failure: "expired" };
  const canonical = canonicalRequest(req, claim, cfg);
  if (canonical === null) return { ok: false, failure: "malformed" };
  const credential = await store.findCredentialByEmail(claim.clientEmail);
  if (!credential || credential.revokedAt !== null) return { ok: false, failure: "unknown_credential" };
  return await signatureValid(credential, claim, canonical)
    ? { ok: true, credential }
    : { ok: false, failure: "signature_mismatch" };
}
