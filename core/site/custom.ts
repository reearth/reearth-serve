/**
 * Custom-domain validation and the verification record (ADR-013 B5) — pure,
 * no I/O.
 *
 * `names.ts` is the equivalent for `subdomain` rows and validates a single
 * label; this validates a whole DNS name the customer already owns. The two
 * are deliberately separate rule sets: a name under our suffix is ours to
 * reserve words in, and `map.city.example.jp` is not.
 */

import type { SiteHost } from "./repository";

/** The label the TXT record is published under. */
export const VERIFY_LABEL = "_reearth-serve-verify";

/** The `key=value` shape of the TXT record's contents. */
export const VERIFY_PREFIX = "reearth-serve-verify";

export const CUSTOM_HOST_ERRORS = {
  format:
    "hostname must be a DNS name of 1–253 characters with at least two labels of " +
    "1–63 letters, digits or hyphens (no leading or trailing hyphen)",
  reserved: "hostname must not be under this service's own domain",
  notCustom: "host is not a custom domain",
  unverified: "verification record not found",
  previews: "previews are not available on custom domains",
  rateLimited: "too many verification attempts for this hostname; try again later",
} as const;

export type CustomHostCheck =
  | { ok: true; hostname: string }
  | { ok: false; error: string };

const LABEL = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/;

/**
 * Validate a hostname the customer owns.
 *
 * Everything a DNS name must be (length, labels, no leading/trailing hyphen),
 * plus the two things it must not be here: under our own wildcard suffix —
 * that is a `subdomain` claim, and letting it in as `custom` would let someone
 * register a name the B2 rules reject — and the apex itself, which would take
 * the management surface down.
 */
export function validateCustomHostname(
  input: string,
  opts: { suffix?: string | undefined; apexHost?: string | undefined } = {},
): CustomHostCheck {
  // A trailing dot is the fully-qualified spelling of the same name; the Host
  // header never carries one, so the row must not either.
  const hostname = input.trim().toLowerCase().replace(/\.$/, "");

  if (hostname.length < 1 || hostname.length > 253) return bad(CUSTOM_HOST_ERRORS.format);
  const labels = hostname.split(".");
  // A single label is a host on somebody's internal network, not a domain the
  // public internet can reach, and it cannot carry a `_verify` record we can
  // read.
  if (labels.length < 2) return bad(CUSTOM_HOST_ERRORS.format);
  if (labels.some((label) => label.length < 1 || label.length > 63 || !LABEL.test(label))) {
    return bad(CUSTOM_HOST_ERRORS.format);
  }

  if (opts.suffix && hostname.endsWith(opts.suffix)) return bad(CUSTOM_HOST_ERRORS.reserved);
  // The suffix without its leading dot is the wildcard's own parent; a row for
  // it would answer on the zone apex.
  if (opts.suffix && hostname === opts.suffix.slice(1)) return bad(CUSTOM_HOST_ERRORS.reserved);
  if (opts.apexHost && hostname === opts.apexHost.toLowerCase()) return bad(CUSTOM_HOST_ERRORS.reserved);

  return { ok: true, hostname };
}

function bad(error: string): CustomHostCheck {
  return { ok: false, error };
}

/** `_reearth-serve-verify.map.city.example.jp` */
export function verificationRecordName(hostname: string): string {
  return `${VERIFY_LABEL}.${hostname}`;
}

/** `reearth-serve-verify=<token>` */
export function verificationRecordValue(token: string): string {
  return `${VERIFY_PREFIX}=${token}`;
}

/** What the API tells the customer to publish, and where to point the domain. */
export interface CustomHostInstructions {
  verification: { record: string; type: "TXT"; value: string };
  cname: { target: string };
}

export function customHostInstructions(
  host: Pick<SiteHost, "hostname" | "verificationToken">,
  cnameTarget: string,
): CustomHostInstructions {
  return {
    verification: {
      record: verificationRecordName(host.hostname),
      type: "TXT",
      value: verificationRecordValue(host.verificationToken ?? ""),
    },
    cname: { target: cnameTarget },
  };
}

/**
 * A fresh verification token: 32 hex characters from the platform CSPRNG.
 *
 * `crypto.getRandomValues` is the one randomness API both Workers and Node
 * expose as a global, so this stays cloud-free (ADR-012). The token is a
 * bearer proof of domain control, so it must not be derived from the hostname
 * or the clock.
 */
export function newVerificationToken(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
}

if (import.meta.vitest) {
  const { describe, test, expect } = import.meta.vitest;

  const SUFFIX = ".serve.reearth.land";
  const check = (input: string) =>
    validateCustomHostname(input, { suffix: SUFFIX, apexHost: "serve.reearth.land" });
  const errorOf = (input: string) => {
    const r = check(input);
    return r.ok ? null : r.error;
  };

  describe("validateCustomHostname accepts", () => {
    test("a normal two-or-more-label name", () => {
      expect(check("map.city.example.jp")).toEqual({ ok: true, hostname: "map.city.example.jp" });
      expect(check("example.jp")).toEqual({ ok: true, hostname: "example.jp" });
      expect(check("a-b.c-d.example")).toEqual({ ok: true, hostname: "a-b.c-d.example" });
    });

    test("mixed case, surrounding space and the fully-qualified trailing dot", () => {
      expect(check("  Map.City.Example.JP. ")).toEqual({ ok: true, hostname: "map.city.example.jp" });
    });

    test("punycode, which is plain [a-z0-9-] once encoded", () => {
      expect(check("xn--p8j2a.example.jp").ok).toBe(true);
    });
  });

  describe("validateCustomHostname rejects with the format error", () => {
    test("a single label", () => {
      expect(errorOf("localhost")).toBe(CUSTOM_HOST_ERRORS.format);
      expect(errorOf("")).toBe(CUSTOM_HOST_ERRORS.format);
    });

    test("characters outside [a-z0-9-.]", () => {
      expect(errorOf("map_1.example.jp")).toBe(CUSTOM_HOST_ERRORS.format);
      expect(errorOf("川崎.example.jp")).toBe(CUSTOM_HOST_ERRORS.format);
      expect(errorOf("map.example.jp:8080")).toBe(CUSTOM_HOST_ERRORS.format);
      expect(errorOf("map .example.jp")).toBe(CUSTOM_HOST_ERRORS.format);
    });

    test("an empty, over-long or hyphen-edged label", () => {
      expect(errorOf("map..example.jp")).toBe(CUSTOM_HOST_ERRORS.format);
      expect(errorOf("-map.example.jp")).toBe(CUSTOM_HOST_ERRORS.format);
      expect(errorOf("map-.example.jp")).toBe(CUSTOM_HOST_ERRORS.format);
      expect(errorOf(`${"a".repeat(64)}.example.jp`)).toBe(CUSTOM_HOST_ERRORS.format);
    });

    test("a name longer than 253 characters", () => {
      const long = `${Array.from({ length: 26 }, () => "a".repeat(9)).join(".")}.example.jp`;
      expect(long.length).toBeGreaterThan(253);
      expect(errorOf(long)).toBe(CUSTOM_HOST_ERRORS.format);
    });
  });

  describe("validateCustomHostname rejects our own domain", () => {
    test("anything under the configured suffix", () => {
      expect(errorOf("kawasaki.serve.reearth.land")).toBe(CUSTOM_HOST_ERRORS.reserved);
      expect(errorOf("a.b.serve.reearth.land")).toBe(CUSTOM_HOST_ERRORS.reserved);
    });

    test("the suffix's own apex and the deployment's apex", () => {
      expect(errorOf("serve.reearth.land")).toBe(CUSTOM_HOST_ERRORS.reserved);
      expect(
        validateCustomHostname("api.reearth.land", { apexHost: "api.reearth.land" }),
      ).toEqual({ ok: false, error: CUSTOM_HOST_ERRORS.reserved });
    });

    test("but a lookalike that merely starts the same is fine", () => {
      expect(check("notserve.reearth.land").ok).toBe(true);
    });
  });

  test("the verification record names the label and the token", () => {
    expect(verificationRecordName("map.city.example.jp")).toBe(
      "_reearth-serve-verify.map.city.example.jp",
    );
    expect(verificationRecordValue("abc")).toBe("reearth-serve-verify=abc");
  });

  test("newVerificationToken is 32 hex characters and does not repeat", () => {
    const a = newVerificationToken();
    expect(a).toMatch(/^[0-9a-f]{32}$/);
    expect(newVerificationToken()).not.toBe(a);
  });
}
