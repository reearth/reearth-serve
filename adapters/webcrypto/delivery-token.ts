import {
  EXPIRY_LEEWAY_SECONDS,
  MAX_TOKEN_LIFETIME_SECONDS,
  decodeCanonicalBase64Url,
  bytesToBase64Url,
  decodeClaims,
  encodeClaims,
  labelledMacInput,
  type DeliveryKey,
  type DeliveryKeyRing,
  type DeliveryTokenCodec,
  type KeyId,
  type UnixSeconds,
  type UnsignedClaims,
  type VerifyResult,
} from "../../core/access/token";

const HMAC = { name: "HMAC", hash: "SHA-256" } as const;
const MAC_BYTES = 32;

/** HMAC-SHA256 delivery tokens (ADR-014 §4). Keys are imported once, when the codec is built. */
export class WebCryptoDeliveryTokenCodec implements DeliveryTokenCodec {
  private readonly activeKid: KeyId;
  private readonly activeKey: Promise<CryptoKey>;
  private readonly keys: ReadonlyMap<KeyId, Promise<CryptoKey>>;

  constructor(ring: DeliveryKeyRing) {
    this.activeKid = ring.active.kid;
    this.activeKey = importKey(ring.active);
    const keys = new Map([[ring.active.kid, this.activeKey]]);
    if (ring.inactive) keys.set(ring.inactive.kid, importKey(ring.inactive));
    this.keys = keys;
  }

  async sign(claims: UnsignedClaims, now: UnixSeconds): Promise<string> {
    if (claims.exp - now > MAX_TOKEN_LIFETIME_SECONDS) {
      throw new RangeError(`delivery token lifetime exceeds ${MAX_TOKEN_LIFETIME_SECONDS} seconds`);
    }
    const encoded = encodeClaims({ ...claims, v: 1, kid: this.activeKid });
    if (!decodeClaims(encoded)) throw new TypeError("delivery token claims are invalid");
    const mac = await crypto.subtle.sign("HMAC", await this.activeKey, labelledMacInput(encoded));
    return `${encoded}.${bytesToBase64Url(new Uint8Array(mac))}`;
  }

  async verify(token: string, now: UnixSeconds): Promise<VerifyResult> {
    const dot = token.indexOf(".");
    if (dot === -1) return { ok: false, reason: "malformed" };
    const encoded = token.slice(0, dot);
    const claims = decodeClaims(encoded);
    const mac = decodeCanonicalBase64Url(token.slice(dot + 1));
    if (!claims || mac?.length !== MAC_BYTES) return { ok: false, reason: "malformed" };
    const key = this.keys.get(claims.kid);
    if (!key) return { ok: false, reason: "unknown_kid" };
    if (!(await crypto.subtle.verify("HMAC", await key, mac, labelledMacInput(encoded)))) {
      return { ok: false, reason: "bad_signature" };
    }
    if (now - claims.exp > EXPIRY_LEEWAY_SECONDS) return { ok: false, reason: "expired" };
    return { ok: true, claims };
  }
}

function importKey(key: DeliveryKey): Promise<CryptoKey> {
  return crypto.subtle.importKey("raw", key.secret, HMAC, false, ["sign", "verify"]);
}
