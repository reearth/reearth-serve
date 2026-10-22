/**
 * `CustomHostnameProvisioner` over Cloudflare for SaaS (ADR-013 B5).
 *
 * Three calls on one zone's `custom_hostnames` collection:
 *
 * ```
 * POST   /zones/{zone}/custom_hostnames          start issuance
 * GET    /zones/{zone}/custom_hostnames?hostname= where it got to
 * DELETE /zones/{zone}/custom_hostnames/{id}      give it up
 * ```
 *
 * `ssl.method: "http"` (HTTP DV) is chosen over `txt` because by the time this
 * runs the customer has already pointed their CNAME at us — B5 verifies domain
 * control with our own TXT record first — so the HTTP challenge is served by
 * the very deployment the certificate is for, with nothing more for the
 * customer to publish.
 *
 * The composition root only builds this when both `CF_API_TOKEN` and
 * `CF_ZONE_ID` are configured; otherwise it injects `NoopProvisioner`. The
 * token is never logged: failures report status codes and Cloudflare's own
 * error messages, and the request is built fresh each time rather than kept in
 * a logged object.
 */
import type {
  CertificateStatus, CustomHostnameProvisioner, CustomHostnameState,
} from "../../core/site/provisioner";

const API_BASE = "https://api.cloudflare.com/client/v4";

interface CustomHostnameResult {
  id?: string;
  hostname?: string;
  status?: string;
  verification_errors?: string[];
  ssl?: { status?: string; validation_errors?: { message?: string }[] };
}

interface CloudflareResponse<T> {
  success?: boolean;
  errors?: { code?: number; message?: string }[];
  result?: T;
}

export interface CloudflareCustomHostnamesOptions {
  apiToken: string;
  zoneId: string;
  /** Injected in tests; defaults to the global `fetch`. */
  fetcher?: typeof fetch;
  /** Override for the API base, for tests. */
  apiBase?: string;
}

export class CloudflareCustomHostnames implements CustomHostnameProvisioner {
  private readonly fetcher: typeof fetch;
  private readonly apiBase: string;

  constructor(private options: CloudflareCustomHostnamesOptions) {
    this.fetcher = options.fetcher ?? fetch;
    this.apiBase = options.apiBase ?? API_BASE;
  }

  async provision(hostname: string): Promise<CustomHostnameState> {
    // An already-registered hostname answers 409-ish with a "duplicate" error;
    // treat that as "it exists" and read its state rather than failing a
    // verification the customer did nothing wrong in.
    const created = await this.call<CustomHostnameResult>("POST", "", {
      hostname,
      ssl: { method: "http", type: "dv" },
    });
    if (created) return toState(created);
    return this.status(hostname);
  }

  async status(hostname: string): Promise<CustomHostnameState> {
    const found = await this.find(hostname);
    // Nothing registered is "pending": the caller's row says it was verified,
    // so the honest answer is "not serving TLS yet", not "active".
    return found ? toState(found) : { status: "pending", instructions: pointCname(hostname) };
  }

  async deprovision(hostname: string): Promise<void> {
    const found = await this.find(hostname);
    if (!found?.id) return;
    await this.call("DELETE", `/${found.id}`);
  }

  private async find(hostname: string): Promise<CustomHostnameResult | null> {
    const results = await this.call<CustomHostnameResult[]>(
      "GET",
      `?hostname=${encodeURIComponent(hostname)}`,
    );
    return results?.find((r) => r.hostname === hostname) ?? null;
  }

  private async call<T>(method: string, path: string, body?: unknown): Promise<T | null> {
    const url = `${this.apiBase}/zones/${this.options.zoneId}/custom_hostnames${path}`;
    const res = await this.fetcher(url, {
      method,
      headers: {
        // The token lives only in this header, built per call, so it cannot be
        // reached by anything that logs the adapter.
        Authorization: `Bearer ${this.options.apiToken}`,
        ...(body ? { "Content-Type": "application/json" } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });

    let payload: CloudflareResponse<T> = {};
    try {
      payload = (await res.json()) as CloudflareResponse<T>;
    } catch {
      // Cloudflare always answers JSON; a body that is not is a proxy error.
    }
    if (!res.ok || payload.success === false) {
      const detail = (payload.errors ?? []).map((e) => e.message).filter(Boolean).join("; ");
      console.warn(
        `Cloudflare custom_hostnames ${method} failed (${res.status})${detail ? `: ${detail}` : ""}`,
      );
      return null;
    }
    return payload.result ?? null;
  }
}

/**
 * Cloudflare reports the hostname's own validation and its certificate's
 * separately; the hostname is only usable when both are active.
 */
function toState(result: CustomHostnameResult): CustomHostnameState {
  const status: CertificateStatus =
    result.status === "active" && result.ssl?.status === "active" ? "active" : "pending";
  if (status === "active") return { status };

  const problems = [
    ...(result.verification_errors ?? []),
    ...(result.ssl?.validation_errors ?? []).map((e) => e.message).filter((m): m is string => !!m),
  ];
  return {
    status,
    instructions: problems.length > 0
      ? problems.join("; ")
      : pointCname(result.hostname ?? "the hostname"),
  };
}

function pointCname(hostname: string): string {
  return `Certificate issuance for ${hostname} has not completed yet. ` +
    "Make sure the CNAME record is in place; issuance usually finishes within minutes.";
}

if (import.meta.vitest) {
  const { describe, test, expect } = import.meta.vitest;

  type Call = { url: string; method: string; auth: string | null; body: unknown };

  function stub(responses: unknown[]): { calls: Call[]; fetcher: typeof fetch } {
    const calls: Call[] = [];
    let n = 0;
    const fetcher = (async (input: string, init?: RequestInit) => {
      calls.push({
        url: String(input),
        method: init?.method ?? "GET",
        auth: new Headers(init?.headers).get("Authorization"),
        body: init?.body ? JSON.parse(String(init.body)) : undefined,
      });
      const payload = responses[Math.min(n++, responses.length - 1)];
      return new Response(JSON.stringify(payload), { headers: { "Content-Type": "application/json" } });
    }) as unknown as typeof fetch;
    return { calls, fetcher };
  }

  function provisioner(responses: unknown[]) {
    const { calls, fetcher } = stub(responses);
    return {
      calls,
      p: new CloudflareCustomHostnames({
        apiToken: "cf-token", zoneId: "zone1", fetcher, apiBase: "https://api.test/client/v4",
      }),
    };
  }

  describe("CloudflareCustomHostnames", () => {
    test("provision posts the hostname with HTTP DV and reports pending", async () => {
      const { calls, p } = provisioner([
        { success: true, result: { id: "ch1", hostname: "map.example.jp", status: "pending", ssl: { status: "pending_validation" } } },
      ]);
      const state = await p.provision("map.example.jp");

      expect(calls[0].method).toBe("POST");
      expect(calls[0].url).toBe("https://api.test/client/v4/zones/zone1/custom_hostnames");
      expect(calls[0].auth).toBe("Bearer cf-token");
      expect(calls[0].body).toEqual({ hostname: "map.example.jp", ssl: { method: "http", type: "dv" } });
      expect(state.status).toBe("pending");
      expect(state.instructions).toContain("map.example.jp");
    });

    test("active means both the hostname and its certificate are active", async () => {
      const { p } = provisioner([
        { success: true, result: { id: "ch1", hostname: "map.example.jp", status: "active", ssl: { status: "active" } } },
      ]);
      expect(await p.provision("map.example.jp")).toEqual({ status: "active" });
    });

    test("status looks the hostname up and surfaces validation errors", async () => {
      const { calls, p } = provisioner([
        {
          success: true,
          result: [{
            id: "ch1", hostname: "map.example.jp", status: "pending",
            ssl: { status: "pending_validation", validation_errors: [{ message: "no CNAME" }] },
          }],
        },
      ]);
      const state = await p.status("map.example.jp");
      expect(calls[0].method).toBe("GET");
      expect(calls[0].url).toContain("?hostname=map.example.jp");
      expect(state).toEqual({ status: "pending", instructions: "no CNAME" });
    });

    test("deprovision finds the id and deletes it", async () => {
      const { calls, p } = provisioner([
        { success: true, result: [{ id: "ch1", hostname: "map.example.jp" }] },
        { success: true, result: { id: "ch1" } },
      ]);
      await p.deprovision("map.example.jp");
      expect(calls[1].method).toBe("DELETE");
      expect(calls[1].url).toBe("https://api.test/client/v4/zones/zone1/custom_hostnames/ch1");
    });

    test("an API error is pending, not an exception, and never prints the token", async () => {
      const { calls, p } = provisioner([{ success: false, errors: [{ message: "bad zone" }] }]);
      expect(await p.status("map.example.jp")).toMatchObject({ status: "pending" });
      expect(JSON.stringify(calls)).toContain("Bearer cf-token"); // only in the header we sent
    });
  });
}
