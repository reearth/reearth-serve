/**
 * One password attempt, for the form and for `Authorization: Basic` alike
 * (ADR-013 B7, ADR-020 §9 item 6).
 *
 * PBKDF2 stays at 600 000 iterations, which is a few hundred milliseconds of
 * CPU. A tool that sends Basic on every tile request would pay that per
 * request, so each isolate remembers the checks that succeeded. A memo hit
 * also skips the limiter's KV read and delete: the attempt already proved the
 * password, so there is nothing to throttle and no counter to clear.
 *
 * The memo key is an HMAC under a random per-isolate key, so the map never
 * holds a password or anything that can be checked against one offline, and
 * it includes `password_version`, so a password change misses at once.
 */

import type { AssetProtection } from "../asset/repository";
import type { KeyValue } from "../kv/port";
import { verifyPassword } from "./password";
import { checkRateLimit, clearFailures, recordFailure } from "./ratelimit";

const MEMO_TTL_MS = 300_000;
const MEMO_MAX_ENTRIES = 1_000;

export class PasswordMemo {
  readonly #expiresAt = new Map<string, number>();
  #key: Promise<CryptoKey> | null = null;

  constructor(private readonly maxEntries = MEMO_MAX_ENTRIES) {}

  async keyFor(assetId: string, passwordVersion: number, password: string): Promise<string> {
    // Created on first use: Workers refuse random values outside a request.
    this.#key ??= crypto.subtle.importKey(
      "raw",
      crypto.getRandomValues(new Uint8Array(32)),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"],
    );
    const mac = await crypto.subtle.sign(
      "HMAC",
      await this.#key,
      new TextEncoder().encode(`${assetId}|${passwordVersion}|${password}`),
    );
    return btoa(String.fromCharCode(...new Uint8Array(mac)));
  }

  /** True on a live entry, which also becomes the most recently used. */
  has(key: string, now: number): boolean {
    const expiresAt = this.#expiresAt.get(key);
    if (expiresAt === undefined) return false;
    this.#expiresAt.delete(key);
    if (expiresAt <= now) return false;
    this.#expiresAt.set(key, expiresAt);
    return true;
  }

  add(key: string, now: number): void {
    this.#expiresAt.delete(key);
    this.#expiresAt.set(key, now + MEMO_TTL_MS);
    while (this.#expiresAt.size > this.maxEntries) {
      this.#expiresAt.delete(this.#expiresAt.keys().next().value!);
    }
  }
}

const isolateMemo = new PasswordMemo();

export type AttemptResult =
  | { kind: "ok" }
  | { kind: "wrong" }
  | { kind: "limited"; retryAfterSeconds: number };

/** Check `password` against `protection`, memoized and rate limited. */
export async function attemptPassword(
  kv: KeyValue,
  assetId: string,
  protection: AssetProtection,
  password: string | undefined,
  ip: string | null,
  now: number,
): Promise<AttemptResult> {
  const memoKey = password === undefined
    ? null
    : await isolateMemo.keyFor(assetId, protection.version, password);
  if (memoKey && isolateMemo.has(memoKey, now)) return { kind: "ok" };

  const limit = await checkRateLimit(kv, assetId, ip, now);
  if (limit.limited) return { kind: "limited", retryAfterSeconds: limit.retryAfterSeconds };

  if (memoKey && password !== undefined && await verifyPassword(password, protection)) {
    await clearFailures(kv, assetId, ip);
    isolateMemo.add(memoKey, now);
    return { kind: "ok" };
  }
  await recordFailure(kv, assetId, ip, now);
  return { kind: "wrong" };
}

if (import.meta.vitest) {
  const { test, expect } = import.meta.vitest;

  test("memo entries expire after 300 s", async () => {
    const memo = new PasswordMemo();
    const key = await memo.keyFor("a", 1, "pw");
    memo.add(key, 0);
    expect(memo.has(key, MEMO_TTL_MS - 1)).toBe(true);
    expect(memo.has(key, MEMO_TTL_MS)).toBe(false);
  });

  test("the least recently used entry is evicted past the cap", async () => {
    const memo = new PasswordMemo(2);
    const [a, b, c] = await Promise.all(["a", "b", "c"].map((id) => memo.keyFor(id, 1, "pw")));
    memo.add(a, 0);
    memo.add(b, 0);
    expect(memo.has(a, 1)).toBe(true);
    memo.add(c, 0);
    expect(memo.has(b, 1)).toBe(false);
    expect(memo.has(a, 1)).toBe(true);
    expect(memo.has(c, 1)).toBe(true);
  });

  test("the key binds asset, password version and password", async () => {
    const memo = new PasswordMemo();
    const key = await memo.keyFor("a", 1, "pw");
    expect(await memo.keyFor("a", 1, "pw")).toBe(key);
    for (const [assetId, version, password] of [["b", 1, "pw"], ["a", 2, "pw"], ["a", 1, "pW"]] as const) {
      expect(await memo.keyFor(assetId, version, password)).not.toBe(key);
    }
    expect(key).not.toContain("pw");
  });
}
