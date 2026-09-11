/**
 * The `DnsResolver` port (ADR-013 B5, ADR-012 §2).
 *
 * Custom domains are proved by a `TXT` record the customer publishes, so the
 * app has to read DNS. That is the only DNS question it ever asks, which is
 * why the port is one method: no A/AAAA, no CNAME chasing, no resolver
 * options.
 *
 * The lookup is deliberately *not* `node:dns`: the adapter
 * (`adapters/doh/dns.ts`) speaks DNS-over-HTTPS, which is `fetch` and nothing
 * else, so the same implementation runs on Workers and on Node. A memory fake
 * (`adapters/memory/dns.ts`) stands in for tests.
 */
export interface DnsResolver {
  /**
   * Every `TXT` record at `name`, unquoted and with multi-string records
   * joined. An empty array means "no such record" — a resolution failure is
   * not distinguished from an absent record, because the caller's answer is
   * the same either way: the domain is not verified yet.
   */
  lookupTxt(name: string): Promise<string[]>;
}
