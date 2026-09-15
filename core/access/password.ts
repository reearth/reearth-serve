/**
 * Password hashing for protected assets (ADR-013 B7, ADR-014 §1 mode two).
 *
 * PBKDF2-SHA256 over WebCrypto: the one KDF every runtime in ADR-012 offers
 * without a dependency. Argon2/scrypt would be better per unit of CPU, but
 * neither exists in `crypto.subtle`, and a WASM build of either would put a
 * cloud-specific artefact in `core/`.
 *
 * The work factor travels *inside* the stored hash rather than in a column of
 * its own:
 *
 *     pbkdf2-sha256$600000$<base64 derived key>
 *
 * so raising the iteration count later re-verifies old hashes unchanged, and a
 * test can hash at 1 000 iterations without a second storage field. Only the
 * salt is stored separately, because that is the column ADR-013 B7 names.
 */

/** ADR-013 B7: "≥ 600k iterations". */
export const DEFAULT_ITERATIONS = 600_000;

/** Bounds the API enforces on a submitted password. */
export const PASSWORD_MIN_LENGTH = 8;
export const PASSWORD_MAX_LENGTH = 128;

const ALGORITHM = "pbkdf2-sha256";
const KEY_LENGTH_BITS = 256;
const SALT_BYTES = 16;

/** What the asset row stores: the encoded hash and its salt, both base64. */
export interface PasswordHash {
  hash: string;
  salt: string;
}

export function toBase64(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

export function fromBase64(value: string): Uint8Array {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

async function derive(password: string, salt: Uint8Array, iterations: number): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(password),
    "PBKDF2",
    false,
    ["deriveBits"],
  );
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", hash: "SHA-256", salt: salt as BufferSource, iterations },
    key,
    KEY_LENGTH_BITS,
  );
  return new Uint8Array(bits);
}

/**
 * Hash `password` with a fresh 16-byte salt.
 *
 * `iterations` is injectable so the unit suite can run the round trip in
 * milliseconds; nothing outside tests passes it, and the production default is
 * {@link DEFAULT_ITERATIONS}.
 */
export async function hashPassword(
  password: string,
  opts: { iterations?: number; salt?: Uint8Array } = {},
): Promise<PasswordHash> {
  const iterations = opts.iterations ?? DEFAULT_ITERATIONS;
  const salt = opts.salt ?? crypto.getRandomValues(new Uint8Array(SALT_BYTES));
  const derived = await derive(password, salt, iterations);
  return {
    hash: `${ALGORITHM}$${iterations}$${toBase64(derived)}`,
    salt: toBase64(salt),
  };
}

/**
 * True when `password` produces `stored.hash` again.
 *
 * A malformed or unknown-algorithm hash is `false` rather than an exception:
 * this runs on the request path, and a row we cannot read must fail closed
 * without taking the response down with it.
 */
export async function verifyPassword(password: string, stored: PasswordHash): Promise<boolean> {
  const parts = stored.hash.split("$");
  if (parts.length !== 3 || parts[0] !== ALGORITHM) return false;
  const iterations = Number.parseInt(parts[1], 10);
  if (!Number.isSafeInteger(iterations) || iterations <= 0) return false;

  let salt: Uint8Array;
  try {
    salt = fromBase64(stored.salt);
  } catch {
    return false;
  }

  const derived = await derive(password, salt, iterations);
  return constantTimeEqual(toBase64(derived), parts[2]);
}

/**
 * Comparison whose running time does not depend on where the first difference
 * is. Length is not secret here (the encoding is fixed-width), so an early
 * return on a length mismatch is fine.
 */
export function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let mismatch = 0;
  for (let i = 0; i < a.length; i++) mismatch |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return mismatch === 0;
}

/** `Authorization: Basic` → the password half, or null. The user part is ignored. */
export function basicPassword(authorization: string | null | undefined): string | null {
  const match = (authorization ?? "").match(/^Basic\s+(\S+)$/i);
  if (!match) return null;
  let decoded: string;
  try {
    decoded = new TextDecoder().decode(fromBase64(match[1]));
  } catch {
    return null;
  }
  const colon = decoded.indexOf(":");
  if (colon === -1) return null;
  return decoded.slice(colon + 1);
}
