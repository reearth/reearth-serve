/** Delivery token claims, encoding, asset paths and the key ring (ADR-014 §4). */

export type KeyId = string & { readonly __brand: "KeyId" };
export type AssetPath = string & { readonly __brand: "AssetPath" };
export type UnixSeconds = number & { readonly __brand: "UnixSeconds" };

export type DeliveryClaims = {
  v: 1;
  kid: KeyId;
  assetId: string;
  versionId: string | null;
  prefix: AssetPath;
  exp: UnixSeconds;
};

export type UnsignedClaims = Omit<DeliveryClaims, "v" | "kid">;

export type VerifyFailure = "malformed" | "unknown_kid" | "bad_signature" | "expired";

export type VerifyResult =
  | { ok: true; claims: DeliveryClaims }
  | { ok: false; reason: VerifyFailure };

export interface DeliveryTokenCodec {
  sign(claims: UnsignedClaims, now: UnixSeconds): Promise<string>;
  verify(token: string, now: UnixSeconds): Promise<VerifyResult>;
}

export type DeliveryKey = { kid: KeyId; secret: Uint8Array<ArrayBuffer> };

export type DeliveryKeyRing = { active: DeliveryKey; inactive: DeliveryKey | null };

const MAC_LABEL = "serve-delivery-v1";
export const EXPIRY_LEEWAY_SECONDS = 30;
export const MAX_TOKEN_LIFETIME_SECONDS = 7 * 24 * 60 * 60;
const MIN_SECRET_BYTES = 32;
const MAX_KEYS = 2;

export function toUnixSeconds(epochMs: number): UnixSeconds {
  return Math.floor(epochMs / 1000) as UnixSeconds;
}

export function parseAssetPath(encodedPath: string): AssetPath | null {
  const decoded = decodeOnce(encodedPath.startsWith("/") ? encodedPath.slice(1) : encodedPath);
  return decoded === null ? null : toAssetPath(decoded);
}

function decodeOnce(raw: string): string | null {
  let failed = false;
  const decoded = raw.replace(/(?:%[0-9A-Fa-f]{2})+/g, (run) => {
    try {
      return decodeURIComponent(run);
    } catch {
      failed = true;
      return run;
    }
  });
  return failed ? null : decoded;
}

function toAssetPath(decoded: string): AssetPath | null {
  if (decoded.startsWith("/") || /[\\\0]|%2f/i.test(decoded)) return null;
  if (decoded.split("/").some((segment) => segment === "." || segment === "..")) return null;
  return decoded as AssetPath;
}

export function encodeClaims(claims: DeliveryClaims): string {
  const { v, kid, assetId, versionId, prefix, exp } = claims;
  return bytesToBase64Url(utf8.encode(JSON.stringify({ v, kid, assetId, versionId, prefix, exp })));
}

export function decodeClaims(encoded: string): DeliveryClaims | null {
  const bytes = decodeCanonicalBase64Url(encoded);
  if (!bytes) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(strictUtf8.decode(bytes));
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  const { v, kid, assetId, versionId, prefix, exp } = parsed as Record<string, unknown>;
  if (v !== 1) return null;
  if (typeof kid !== "string" || kid === "") return null;
  if (typeof assetId !== "string" || assetId === "") return null;
  if (versionId !== null && (typeof versionId !== "string" || versionId === "")) return null;
  if (typeof prefix !== "string") return null;
  if (typeof exp !== "number" || !Number.isSafeInteger(exp) || exp < 0) return null;
  const path = toAssetPath(prefix);
  if (path === null) return null;
  return { v, kid: kid as KeyId, assetId, versionId, prefix: path, exp: exp as UnixSeconds };
}

export function labelledMacInput(encodedClaims: string): Uint8Array<ArrayBuffer> {
  return utf8.encode(`${MAC_LABEL}\n${encodedClaims}`);
}

export function bytesToBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

const BASE64URL_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
const UNUSED_TRAILING_BITS = [0, 0, 0b1111, 0b11];

export function decodeCanonicalBase64Url(encoded: string): Uint8Array<ArrayBuffer> | null {
  const tail = encoded.length % 4;
  if (tail === 1 || !/^[A-Za-z0-9_-]*$/.test(encoded)) return null;
  if (tail !== 0 && BASE64URL_ALPHABET.indexOf(encoded[encoded.length - 1]) & UNUSED_TRAILING_BITS[tail]) return null;
  const binary = atob(encoded.replace(/-/g, "+").replace(/_/g, "/"));
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

const utf8 = new TextEncoder();
const strictUtf8 = new TextDecoder("utf-8", { fatal: true });

export function parseDeliveryTokenKeys(raw: string): DeliveryKeyRing {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw keysError("not valid JSON");
  }
  if (typeof parsed !== "object" || parsed === null) throw keysError(SHAPE);
  const { active, keys } = parsed as Record<string, unknown>;
  if (typeof active !== "string" || typeof keys !== "object" || keys === null || Array.isArray(keys)) {
    throw keysError(SHAPE);
  }
  const entries = Object.entries(keys);
  if (entries.length > MAX_KEYS) {
    throw keysError(`lists ${entries.length} keys; at most ${MAX_KEYS} are allowed`);
  }
  const ring = entries.map(([kid, secret]) => deliveryKey(kid, secret));
  const activeKey = ring.find((key) => key.kid === active);
  if (!activeKey) throw keysError(`active key ${active} is not listed`);
  return { active: activeKey, inactive: ring.find((key) => key !== activeKey) ?? null };
}

const SHAPE = 'expected {"active":"<kid>","keys":{"<kid>":"<base64 secret>"}}';

function deliveryKey(kid: string, secret: unknown): DeliveryKey {
  if (kid === "") throw keysError("a key id is empty");
  if (typeof secret !== "string") throw keysError(`key ${kid} is not a base64 string`);
  let binary: string;
  try {
    binary = atob(secret);
  } catch {
    throw keysError(`key ${kid} is not valid base64`);
  }
  if (binary.length < MIN_SECRET_BYTES) {
    throw keysError(`key ${kid} is shorter than ${MIN_SECRET_BYTES} bytes`);
  }
  return { kid: kid as KeyId, secret: Uint8Array.from(binary, (char) => char.charCodeAt(0)) };
}

function keysError(detail: string): Error {
  return new Error(`DELIVERY_TOKEN_KEYS: ${detail}`);
}
