/**
 * Upload integrity (ADR-017 §1–§2): the SHA-256 a client may declare, and the
 * error a store raises when the bytes it received do not hash to it.
 *
 * Runtime-agnostic on purpose (ADR-012): hashing itself happens inside the
 * `FileStorage` adapters, which know whether the runtime offers
 * `crypto.DigestStream` (Workers) or `node:crypto` (Node). Core only parses,
 * compares and records hex strings.
 */

/** Request header carrying the declared SHA-256 on direct uploads, and the response header on `/files`. */
export const CONTENT_SHA256_HEADER = "X-Content-SHA256";

const SHA256_HEX = /^[0-9a-fA-F]{64}$/;

/** True when `value` is 64 hex characters (either case). */
export function isSha256Hex(value: string): boolean {
  return SHA256_HEX.test(value);
}

/**
 * Parse an `X-Content-SHA256` header value.
 *
 * Absent → `undefined` (nothing declared). 64 hex characters in any case →
 * the lowercase form the ledger stores. Anything else → `"invalid"`, which the
 * route answers with 400 before a byte of the body is read.
 */
export function parseSha256Header(value: string | undefined): string | undefined | "invalid" {
  if (value === undefined) return undefined;
  const trimmed = value.trim();
  return isSha256Hex(trimmed) ? trimmed.toLowerCase() : "invalid";
}

/**
 * Thrown by a `FileStorage.put` (or detected at session completion) when the
 * stored bytes do not hash to the declared SHA-256. The adapter has written
 * nothing — or, at completion, the object has been removed — so the caller
 * only has to refuse the upload (422).
 */
export class ChecksumMismatchError extends Error {
  constructor(readonly expected: string, readonly actual?: string) {
    super(`SHA-256 mismatch: declared ${expected}${actual ? `, stored bytes hash to ${actual}` : ""}`);
    this.name = "ChecksumMismatchError";
  }
}

/** Hex digest → the base64 form S3's `x-amz-checksum-sha256` header carries. */
export function sha256HexToBase64(hex: string): string {
  let binary = "";
  for (let i = 0; i < hex.length; i += 2) {
    binary += String.fromCharCode(parseInt(hex.slice(i, i + 2), 16));
  }
  return btoa(binary);
}

/** Raw digest bytes → lowercase hex. */
export function bytesToHex(bytes: ArrayBuffer | Uint8Array): string {
  const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let out = "";
  for (const b of view) out += b.toString(16).padStart(2, "0");
  return out;
}

if (import.meta.vitest) {
  const { test, expect } = import.meta.vitest;
  // sha256("hello")
  const HELLO = "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824";

  test("parseSha256Header accepts 64 hex chars in any case and lowercases them", () => {
    expect(parseSha256Header(undefined)).toBeUndefined();
    expect(parseSha256Header(HELLO)).toBe(HELLO);
    expect(parseSha256Header(HELLO.toUpperCase())).toBe(HELLO);
    expect(parseSha256Header(` ${HELLO} `)).toBe(HELLO);
  });

  test("parseSha256Header rejects anything that is not a hex SHA-256", () => {
    for (const bad of ["", "abc", HELLO.slice(1), `${HELLO}0`, `${HELLO.slice(1)}g`, "LPJNul+wow4m6DsqxbninhsWHlwfp0JecwQzYpOLmCQ="]) {
      expect(parseSha256Header(bad), bad).toBe("invalid");
    }
  });

  test("sha256HexToBase64 matches the S3 checksum encoding", () => {
    expect(sha256HexToBase64(HELLO)).toBe("LPJNul+wow4m6DsqxbninhsWHlwfp0JecwQzYpOLmCQ=");
  });

  test("bytesToHex round-trips", () => {
    expect(bytesToHex(new Uint8Array([0, 15, 255]))).toBe("000fff");
  });
}
