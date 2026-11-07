/**
 * `DnsResolver` over DNS-over-HTTPS (ADR-013 B5, ADR-012 §2).
 *
 * Its own adapter directory rather than `cloudflare/` or a Node-only module:
 * DoH is `fetch` and a JSON body, so one implementation runs on Workers, on
 * Node and on anything else with a `fetch`. `node:dns` would have been the
 * obvious Node answer and is unavailable inside a Worker; there is no reason
 * to carry two implementations of one lookup.
 *
 * The resolver URL is configuration (`SITE_DNS_RESOLVER_URL`) so an operator
 * can point it at their own resolver — and so the e2e suite can point it at a
 * mock that answers the record the test just asked for.
 */
import type { DnsResolver } from "../../core/site/dns";

export const DEFAULT_DOH_RESOLVER_URL = "https://cloudflare-dns.com/dns-query";

/** `type` of a TXT record in a DNS answer (RFC 1035). */
const TXT = 16;

interface DnsJsonAnswer {
  type?: number;
  data?: string;
}

interface DnsJsonResponse {
  Answer?: DnsJsonAnswer[];
}

export class DohDnsResolver implements DnsResolver {
  constructor(private resolverUrl: string = DEFAULT_DOH_RESOLVER_URL) {}

  async lookupTxt(name: string): Promise<string[]> {
    const url = new URL(this.resolverUrl);
    url.searchParams.set("name", name);
    url.searchParams.set("type", "TXT");

    let res: Response;
    try {
      res = await fetch(url, { headers: { accept: "application/dns-json" } });
    } catch (e) {
      // A resolver that is unreachable is the same answer as a record that is
      // not there: not verified yet, try again. Nothing here is worth taking
      // the request down for.
      console.warn(`DNS lookup for ${name} failed:`, e instanceof Error ? e.message : e);
      return [];
    }
    if (!res.ok) {
      console.warn(`DNS lookup for ${name} returned ${res.status}`);
      return [];
    }

    let body: DnsJsonResponse;
    try {
      body = (await res.json()) as DnsJsonResponse;
    } catch {
      return [];
    }

    return (body.Answer ?? [])
      .filter((answer) => answer.type === TXT && typeof answer.data === "string")
      .map((answer) => unquote(answer.data as string));
  }
}

/**
 * TXT contents as DNS-JSON spells them: one or more quoted character strings,
 * which the protocol splits every 255 bytes and the reader is expected to
 * concatenate. `"abc" "def"` is the single value `abcdef`.
 */
export function unquote(data: string): string {
  const parts = data.match(/"(?:[^"\\]|\\.)*"/g);
  if (!parts) return data.trim();
  return parts
    .map((part) => part.slice(1, -1).replace(/\\(.)/g, "$1"))
    .join("");
}

if (import.meta.vitest) {
  const { describe, test, expect, vi } = import.meta.vitest;

  test("unquote joins the character strings of one record", () => {
    expect(unquote('"reearth-serve-verify=abc"')).toBe("reearth-serve-verify=abc");
    expect(unquote('"abc" "def"')).toBe("abcdef");
    expect(unquote('"a\\"b"')).toBe('a"b');
    expect(unquote("bare-value")).toBe("bare-value");
  });

  describe("DohDnsResolver", () => {
    test("asks the configured resolver for TXT and returns the answers", async () => {
      const calls: { url: string; accept: string | undefined }[] = [];
      vi.stubGlobal("fetch", async (input: URL, init?: RequestInit) => {
        calls.push({
          url: input.toString(),
          accept: new Headers(init?.headers).get("accept") ?? undefined,
        });
        return new Response(
          JSON.stringify({ Answer: [{ type: 16, data: '"v=1"' }, { type: 5, data: "cname" }] }),
          { headers: { "Content-Type": "application/dns-json" } },
        );
      });

      const resolver = new DohDnsResolver("https://dns.example.test/dns-query");
      expect(await resolver.lookupTxt("_x.example.jp")).toEqual(["v=1"]);
      expect(calls[0].url).toBe("https://dns.example.test/dns-query?name=_x.example.jp&type=TXT");
      expect(calls[0].accept).toBe("application/dns-json");
      vi.unstubAllGlobals();
    });

    test("a failing resolver is an empty answer, not an exception", async () => {
      vi.stubGlobal("fetch", async () => {
        throw new Error("network down");
      });
      expect(await new DohDnsResolver().lookupTxt("_x.example.jp")).toEqual([]);

      vi.stubGlobal("fetch", async () => new Response("nope", { status: 502 }));
      expect(await new DohDnsResolver().lookupTxt("_x.example.jp")).toEqual([]);
      vi.unstubAllGlobals();
    });
  });
}
