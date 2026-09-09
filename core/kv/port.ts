/**
 * Provider-independent key-value port (ADR-012 §2).
 *
 * The smallest surface every provider offers: opaque string values under
 * string keys, with an optional TTL. Deliberately no `list`, no metadata and
 * no CAS — anything that needs those belongs in SQL, not here. Cloudflare KV
 * is one adapter (`adapters/cloudflare/kv.ts`); an in-memory map (`adapters/memory/memory-kv.ts`) and
 * later a SQL-backed table are the off-Cloudflare ones.
 *
 * Expiry is best-effort in both directions: a value may disappear before its
 * TTL (eviction) and an expired value must never be returned. Callers treat
 * every read as a cache read that can miss.
 */
export interface KeyValue {
  get(key: string): Promise<string | null>;
  put(key: string, value: string, options?: { ttlSeconds?: number }): Promise<void>;
  delete(key: string): Promise<void>;
}
