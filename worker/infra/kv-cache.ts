import type { JwksCache } from "../auth/jwks";

/**
 * Cloudflare KV implementation of the JWKS cache port.
 *
 * Kept in the adapter layer so `auth/` never sees `KVNamespace` (ADR-012 §1).
 * ADR-012 §2 replaces this with a general `KeyValue` port later; until then
 * the surface stays deliberately tiny.
 */
export class KVJwksCache implements JwksCache {
  constructor(private kv: KVNamespace) {}

  async get(key: string): Promise<string | null> {
    return this.kv.get(key);
  }

  async put(key: string, value: string, options: { ttlSeconds: number }): Promise<void> {
    await this.kv.put(key, value, { expirationTtl: options.ttlSeconds });
  }
}
