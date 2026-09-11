/**
 * In-memory `DnsResolver` (ADR-013 B5).
 *
 * The fake the unit tests verify against: a map from record name to its TXT
 * values, with no network and no caching, so a test can publish a record
 * between two calls.
 */
import type { DnsResolver } from "../../core/site/dns";

export class MemoryDnsResolver implements DnsResolver {
  readonly records = new Map<string, string[]>();
  /** Every name looked up, in order — so a test can assert what was asked. */
  readonly lookups: string[] = [];

  constructor(records: Record<string, string[]> = {}) {
    for (const [name, values] of Object.entries(records)) this.records.set(name, values);
  }

  set(name: string, ...values: string[]): this {
    this.records.set(name, values);
    return this;
  }

  async lookupTxt(name: string): Promise<string[]> {
    this.lookups.push(name);
    return this.records.get(name) ?? [];
  }
}
