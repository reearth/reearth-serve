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

export type SignedUrlFailure =
  | { reason: "malformed" | "not_yet_valid" | "expired" | "unknown_credential" | "signature_mismatch" }
  | { reason: "unsupported"; header: string };

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
const MAX_QUERY_PARAMS = 64;

export const WRITE_HEADERS = { lengthRange: "x-goog-content-length-range", generationMatch: "x-goog-if-generation-match" } as const;
export const USER_META_PREFIX = "x-goog-meta-";

function supportedSignedHeader(name: string): boolean {
  return !name.startsWith("x-goog-") || name.startsWith(USER_META_PREFIX) || Object.values<string>(WRITE_HEADERS).includes(name);
}

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

export function objectPathOf(rawPath: string): string | null {
  let path: string;
  try {
    path = decodeURIComponent(rawPath);
  } catch {
    return null;
  }
  return path.startsWith("/") ? path.slice(1) : null;
}

function signedPathCandidates(rawPath: string, prefix: string | null): string[] {
  const path = objectPathOf(rawPath);
  if (path === null) return [];
  const bare = prefix?.slice(1);
  return bare && path.startsWith(`${bare}/`) ? [path, path.slice(bare.length + 1)] : [path];
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

/** Go's `url.Values.Encode` sorts keys by UTF-8 bytes, where JavaScript's `sort` orders by UTF-16 code units. */
function byUtf8(a: string, b: string): number {
  const x = new TextEncoder().encode(a);
  const y = new TextEncoder().encode(b);
  for (let i = 0; i < Math.min(x.length, y.length); i++) {
    if (x[i] !== y[i]) return x[i]! - y[i]!;
  }
  return x.length - y.length;
}

function hexOf(bytes: ArrayBuffer): string {
  return [...new Uint8Array(bytes)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export function parseSignedUrl(url: URL): SignedUrlClaim | null {
  const q = url.searchParams;
  if (q.size > MAX_QUERY_PARAMS) return null;
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
  const signedAt = Date.UTC(y!, mo! - 1, d!, h!, mi!, s!);
  if (new Date(signedAt).toISOString().replace(/[-:]|\.\d{3}/g, "") !== timestamp) return null;
  return {
    clientEmail: credential.slice(0, slash),
    timestamp,
    scope,
    signedAt,
    expiresSeconds: Number(expires),
    signedHeaders: headers,
    signature,
  };
}

export function canonicalRequest(req: SignedRequest, claim: SignedUrlClaim, cfg: { apiHost: string; objectPath: string }): string {
  const path = `/${cfg.objectPath.split("/").map(goEscape).join("/")}`;

  const byKey = new Map<string, string[]>();
  for (const [k, v] of req.url.searchParams) {
    if (k === SIGNATURE_PARAM) continue;
    const values = byKey.get(k);
    if (values) values.push(v);
    else byKey.set(k, [v]);
  }
  const query = [...byKey.keys()].sort(byUtf8)
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
): Promise<{ ok: true; credential: CompatCredential; objectPath: string } | { ok: false; failure: SignedUrlFailure }> {
  const fail = (reason: Exclude<SignedUrlFailure["reason"], "unsupported">) => ({ ok: false as const, failure: { reason } });
  const claim = parseSignedUrl(req.url);
  if (!claim) return fail("malformed");
  const unsupported = claim.signedHeaders.find((name) => !supportedSignedHeader(name));
  if (unsupported) return { ok: false, failure: { reason: "unsupported", header: unsupported } };
  if (claim.signedAt > cfg.now + CLOCK_TOLERANCE_MS) return fail("not_yet_valid");
  if (cfg.now > claim.signedAt + claim.expiresSeconds * 1000) return fail("expired");
  const readings = signedPathCandidates(req.url.pathname, cfg.pathPrefix);
  if (readings.length === 0) return fail("malformed");
  const credential = await store.findCredentialByEmail(claim.clientEmail);
  if (!credential || credential.revokedAt !== null) return fail("unknown_credential");
  for (const objectPath of readings) {
    if (await signatureValid(credential, claim, canonicalRequest(req, claim, { apiHost: cfg.apiHost, objectPath }))) {
      return { ok: true, credential, objectPath };
    }
  }
  return fail("signature_mismatch");
}
