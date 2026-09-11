/**
 * Failed-password throttling (ADR-013 B7).
 *
 * A shared site password is low-entropy by nature — it is chosen by a person
 * and typed by a dozen of them — so the limiter, not the password, is what
 * makes guessing impractical. Failures are counted per `(assetId, client IP)`
 * over a 15-minute window; the eleventh failure in that window is answered
 * `429` until the window rolls over, and the count applies to the form and to
 * `Authorization: Basic` alike (otherwise the limit would be one `curl` loop
 * away from meaningless).
 *
 * Storage is the `KeyValue` port (ADR-012 §2), which has no atomic increment:
 * the counter is a read-modify-write and two racing failures can be recorded
 * as one. That undercount is acceptable — it costs at most a handful of extra
 * guesses per window — and the alternative (a SQL row per attempt) buys
 * precision nothing here needs.
 */

import type { KeyValue } from "../kv/port";

export const RATE_WINDOW_SECONDS = 15 * 60;

/** Failures allowed per window when the client IP is known. */
export const RATE_LIMIT_PER_IP = 10;

/**
 * Failures allowed per window when it is not.
 *
 * With no IP, every visitor of the asset shares one bucket, so the per-IP limit
 * would let one bad actor lock out an entire site. The fallback is deliberately
 * looser: it still bounds an unauthenticated guessing run, but it takes a
 * volume no honest set of visitors reaches to shut the asset's form.
 */
export const RATE_LIMIT_GLOBAL = 100;

interface Bucket {
  count: number;
  /** Window end, epoch ms. */
  resetAt: number;
}

/**
 * The requesting client's address, or null when the runtime exposes none.
 *
 * `CF-Connecting-IP` is Cloudflare's, and is the only one of the two that a
 * visitor cannot set (the edge overwrites it). `X-Forwarded-For`'s first hop is
 * the best a reverse proxy in front of the Node runtime offers, and it is
 * spoofable by anyone who can reach the process directly — which is why
 * exceeding the limit only ever *adds* a restriction and the fallback bucket
 * below exists.
 */
export function clientIp(request: Request): string | null {
  const cf = request.headers.get("CF-Connecting-IP")?.trim();
  if (cf) return cf;
  const forwarded = request.headers.get("X-Forwarded-For");
  const first = forwarded?.split(",")[0]?.trim();
  return first || null;
}

function key(assetId: string, ip: string | null): string {
  return `pwfail:${assetId}:${ip ?? "_global"}`;
}

function limitFor(ip: string | null): number {
  return ip ? RATE_LIMIT_PER_IP : RATE_LIMIT_GLOBAL;
}

async function read(kv: KeyValue, storageKey: string, now: number): Promise<Bucket | null> {
  const raw = await kv.get(storageKey);
  if (!raw) return null;
  try {
    const bucket = JSON.parse(raw) as Bucket;
    if (typeof bucket.count !== "number" || typeof bucket.resetAt !== "number") return null;
    return bucket.resetAt > now ? bucket : null;
  } catch {
    return null;
  }
}

export interface RateLimitState {
  limited: boolean;
  /** Seconds until the window rolls over; at least 1 so `Retry-After` is valid. */
  retryAfterSeconds: number;
}

/** Whether this `(asset, client)` has spent its budget for the current window. */
export async function checkRateLimit(
  kv: KeyValue,
  assetId: string,
  ip: string | null,
  now: number = Date.now(),
): Promise<RateLimitState> {
  const bucket = await read(kv, key(assetId, ip), now);
  if (!bucket || bucket.count < limitFor(ip)) {
    return { limited: false, retryAfterSeconds: 0 };
  }
  return { limited: true, retryAfterSeconds: retryAfter(bucket.resetAt, now) };
}

/**
 * Record one failed password check.
 *
 * The attempt that spends the last of the budget is still answered `401` — it
 * was a wrong password, and that is the honest answer. The *next* attempt is
 * the one {@link checkRateLimit} refuses, which is why every caller checks
 * before it verifies.
 */
export async function recordFailure(
  kv: KeyValue,
  assetId: string,
  ip: string | null,
  now: number = Date.now(),
): Promise<void> {
  const storageKey = key(assetId, ip);
  const existing = await read(kv, storageKey, now);
  const bucket: Bucket = existing
    ? { count: existing.count + 1, resetAt: existing.resetAt }
    : { count: 1, resetAt: now + RATE_WINDOW_SECONDS * 1000 };

  await kv.put(storageKey, JSON.stringify(bucket), {
    // The TTL follows the window, so an abandoned bucket disappears on its own
    // rather than being swept.
    ttlSeconds: Math.max(1, Math.ceil((bucket.resetAt - now) / 1000)),
  });
}

/** Drop the counter — called after a successful check, so one typo costs nothing. */
export async function clearFailures(kv: KeyValue, assetId: string, ip: string | null): Promise<void> {
  await kv.delete(key(assetId, ip));
}

function retryAfter(resetAt: number, now: number): number {
  return Math.max(1, Math.ceil((resetAt - now) / 1000));
}
