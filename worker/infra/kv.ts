import type { KeyValue } from "../kv/port";

/**
 * Cloudflare KV implementation of the `KeyValue` port (ADR-012 §2).
 *
 * The only place a `KVNamespace` is touched outside the composition root.
 * A TTL maps straight onto KV's `expirationTtl`; omitting it stores the value
 * without an expiry, exactly as the index writes in `metadata.ts` do.
 */
export class CloudflareKeyValue implements KeyValue {
  constructor(private kv: KVNamespace) {}

  async get(key: string): Promise<string | null> {
    return this.kv.get(key);
  }

  async put(key: string, value: string, options?: { ttlSeconds?: number }): Promise<void> {
    const ttl = options?.ttlSeconds;
    await this.kv.put(key, value, ttl !== undefined ? { expirationTtl: ttl } : undefined);
  }

  async delete(key: string): Promise<void> {
    await this.kv.delete(key);
  }
}
