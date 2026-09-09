import type { KeyValue } from "../kv/port";

type Entry = {
  value: string;
  /** Milliseconds on the store's clock, or null for "never expires". */
  expiresAt: number | null;
};

/**
 * Map-backed `KeyValue` for tests and (later) the in-process Node runtime.
 *
 * It honours TTLs for real instead of ignoring them: the clock is injectable,
 * so a test can jump past an expiry rather than sleep through it, and an
 * expired entry is dropped on read the way a real store drops it.
 */
export class MemoryKeyValue implements KeyValue {
  private readonly entries = new Map<string, Entry>();
  private readonly now: () => number;

  constructor(options: { now?: () => number } = {}) {
    this.now = options.now ?? (() => Date.now());
  }

  async get(key: string): Promise<string | null> {
    const entry = this.entries.get(key);
    if (!entry) return null;
    if (entry.expiresAt !== null && entry.expiresAt <= this.now()) {
      this.entries.delete(key);
      return null;
    }
    return entry.value;
  }

  async put(key: string, value: string, options?: { ttlSeconds?: number }): Promise<void> {
    const ttl = options?.ttlSeconds;
    this.entries.set(key, {
      value,
      expiresAt: ttl === undefined ? null : this.now() + ttl * 1000,
    });
  }

  async delete(key: string): Promise<void> {
    this.entries.delete(key);
  }

  /** Live keys, expired ones excluded. For assertions only. */
  get size(): number {
    let n = 0;
    for (const [, entry] of this.entries) {
      if (entry.expiresAt === null || entry.expiresAt > this.now()) n++;
    }
    return n;
  }
}
