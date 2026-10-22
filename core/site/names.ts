/**
 * Site-name validation (ADR-013 B2) — pure, no I/O.
 *
 * Everything the table cannot tell us lives here: DNS-label shape, the `--`
 * ban that keeps B4's preview separator unambiguous, the ID shape that lets
 * the resolver answer ID hosts without touching the table (B6), and the
 * reserved list. Uniqueness and the release cooldown need the table and are
 * checked in the use case.
 */

/** Asset and version IDs: 16 lowercase hex characters (B1). */
export const ID_LABEL = /^[0-9a-f]{16}$/;

/**
 * Reserved names. Current and planned first-party subdomains plus the shapes
 * that make convincing phishing hosts. `latest` is here because B4 gives it
 * meaning; `v{digits}` is rejected by rule for the same reason.
 */
export const RESERVED_NAMES: ReadonlySet<string> = new Set([
  "www", "api", "app", "admin", "dashboard", "login", "auth", "files",
  "static", "assets", "cdn", "mail", "ftp", "ns1", "ns2", "status", "docs",
  "help", "support", "latest", "reearth", "eukarya", "plateau", "serve",
  "untiled",
]);

/** The exact error strings B6 specifies. Handlers return these verbatim. */
export const NAME_ERRORS = {
  format:
    'name must be 3–63 lowercase letters, digits or hyphens and may not contain "--"',
  reserved: "name is reserved",
  taken: "name is taken",
} as const;

/** "name was recently released and is on cooldown until …" (B6). */
export function cooldownError(until: number): string {
  return `name was recently released and is on cooldown until ${new Date(until).toISOString()}`;
}

export type NameCheck =
  | { ok: true; name: string }
  | { ok: false; error: string };

/**
 * Take the bare label out of whatever the caller sent.
 *
 * The API accepts either form — `kawasaki-flood-map` or the full
 * `kawasaki-flood-map.serve.reearth.land` — because the response prints the
 * full host and round-tripping it should work. A host that does not end with
 * the suffix is returned unchanged and then fails validation on its dots.
 */
export function toSiteName(input: string, suffix: string | undefined): string {
  const value = input.trim().toLowerCase().replace(/\.$/, "");
  if (suffix && value.endsWith(suffix)) {
    return value.slice(0, value.length - suffix.length);
  }
  return value;
}

/**
 * Validate a bare site name.
 *
 * ID-shaped and `v{n}` names report "name is reserved" rather than a format
 * error: they are well-formed labels that the system has taken for itself,
 * which is what "reserved" means to the person typing one.
 */
export function validateSiteName(input: string): NameCheck {
  const name = input.trim().toLowerCase();

  if (name.length < 3 || name.length > 63) return bad(NAME_ERRORS.format);
  if (!/^[a-z0-9-]+$/.test(name)) return bad(NAME_ERRORS.format);
  if (name.startsWith("-") || name.endsWith("-")) return bad(NAME_ERRORS.format);
  // Anywhere, not just at positions 3–4 where IDNA forbids it: B4 splits on
  // the first `--`, so a name containing one would make the split ambiguous.
  if (name.includes("--")) return bad(NAME_ERRORS.format);

  if (ID_LABEL.test(name)) return bad(NAME_ERRORS.reserved);
  if (/^v[0-9]+$/.test(name)) return bad(NAME_ERRORS.reserved);
  // Hyphen-delimited parts too, so `api-v2` and `login-reearth` are out. Cheap,
  // and it removes the obvious phishing shapes.
  if (name.split("-").some((part) => RESERVED_NAMES.has(part))) {
    return bad(NAME_ERRORS.reserved);
  }

  return { ok: true, name };
}

function bad(error: string): NameCheck {
  return { ok: false, error };
}

if (import.meta.vitest) {
  const { describe, test, expect } = import.meta.vitest;

  const ok = (input: string) => validateSiteName(input);
  const errorOf = (input: string) => {
    const r = validateSiteName(input);
    return r.ok ? null : r.error;
  };

  describe("validateSiteName accepts", () => {
    test("plain DNS labels", () => {
      expect(ok("kawasaki-flood-map")).toEqual({ ok: true, name: "kawasaki-flood-map" });
      expect(ok("abc")).toEqual({ ok: true, name: "abc" });
      expect(ok("a1b")).toEqual({ ok: true, name: "a1b" });
      expect(ok("123")).toEqual({ ok: true, name: "123" });
      expect(ok("a".repeat(63)).ok).toBe(true);
    });

    test("mixed case and surrounding space, lowercased", () => {
      expect(ok("  Kawasaki-Flood-Map ")).toEqual({ ok: true, name: "kawasaki-flood-map" });
    });

    test("hex that is not exactly 16 characters", () => {
      expect(ok("3f9a1c2b4d5e6f7").ok).toBe(true);
      expect(ok("3f9a1c2b4d5e6f701").ok).toBe(true);
      // Sixteen characters, but `g` is not hex.
      expect(ok("3f9a1c2b4d5e6f7g").ok).toBe(true);
    });

    test("a reserved word that is not a whole hyphen-delimited part", () => {
      expect(ok("apiary").ok).toBe(true);
      expect(ok("wwwx").ok).toBe(true);
      expect(ok("serverless").ok).toBe(true);
    });

    test("v followed by something that is not only digits", () => {
      expect(ok("v1a").ok).toBe(true);
      expect(ok("viewer").ok).toBe(true);
    });
  });

  describe("validateSiteName rejects with the format error", () => {
    test("too short or too long", () => {
      expect(errorOf("ab")).toBe(NAME_ERRORS.format);
      expect(errorOf("")).toBe(NAME_ERRORS.format);
      expect(errorOf("a".repeat(64))).toBe(NAME_ERRORS.format);
    });

    test("characters outside [a-z0-9-]", () => {
      expect(errorOf("Kawasaki_Map")).toBe(NAME_ERRORS.format);
      expect(errorOf("flood.map")).toBe(NAME_ERRORS.format);
      expect(errorOf("kawasaki flood")).toBe(NAME_ERRORS.format);
      expect(errorOf("川崎")).toBe(NAME_ERRORS.format);
      expect(errorOf("xn--p8j2a")).toBe(NAME_ERRORS.format); // punycode: also a `--`
    });

    test("leading or trailing hyphen", () => {
      expect(errorOf("-map")).toBe(NAME_ERRORS.format);
      expect(errorOf("map-")).toBe(NAME_ERRORS.format);
      expect(errorOf("---")).toBe(NAME_ERRORS.format);
    });

    test("a double hyphen anywhere, not just at positions 3–4", () => {
      expect(errorOf("v3--map")).toBe(NAME_ERRORS.format);
      expect(errorOf("ab--cd")).toBe(NAME_ERRORS.format);
      expect(errorOf("map--")).toBe(NAME_ERRORS.format);
      expect(errorOf("kawasaki--flood--map")).toBe(NAME_ERRORS.format);
    });
  });

  describe("validateSiteName rejects with the reserved error", () => {
    test("ID-shaped names", () => {
      expect(errorOf("3f9a1c2b4d5e6f70")).toBe(NAME_ERRORS.reserved);
      expect(errorOf("0123456789abcdef")).toBe(NAME_ERRORS.reserved);
    });

    test("version-shaped names", () => {
      expect(errorOf("v42")).toBe(NAME_ERRORS.reserved);
      expect(errorOf("v100")).toBe(NAME_ERRORS.reserved);
      // `v1` and `v0` never reach the rule — they are below the 3-character
      // minimum — but they are rejected all the same, which is what matters.
      expect(errorOf("v1")).toBe(NAME_ERRORS.format);
    });

    test("every word on the reserved list", () => {
      for (const word of RESERVED_NAMES) {
        expect(errorOf(word), word).toBe(NAME_ERRORS.reserved);
      }
    });

    test("reserved words as hyphen-delimited parts", () => {
      expect(errorOf("api-v2")).toBe(NAME_ERRORS.reserved);
      expect(errorOf("login-reearth")).toBe(NAME_ERRORS.reserved);
      expect(errorOf("kawasaki-admin")).toBe(NAME_ERRORS.reserved);
      expect(errorOf("my-cdn-1")).toBe(NAME_ERRORS.reserved);
    });

    test("format is checked before reserved", () => {
      // `www` is reserved, but this one is malformed first.
      expect(errorOf("-www")).toBe(NAME_ERRORS.format);
    });
  });

  describe("toSiteName", () => {
    const suffix = ".serve.reearth.land";

    test("passes a bare label through, lowercased", () => {
      expect(toSiteName("Kawasaki-Flood-Map", suffix)).toBe("kawasaki-flood-map");
    });

    test("strips the configured suffix from a full host", () => {
      expect(toSiteName("kawasaki-flood-map.serve.reearth.land", suffix)).toBe("kawasaki-flood-map");
      expect(toSiteName("KAWASAKI.SERVE.REEARTH.LAND", suffix)).toBe("kawasaki");
      expect(toSiteName("kawasaki.serve.reearth.land.", suffix)).toBe("kawasaki");
    });

    test("leaves a host under a different suffix alone (it then fails validation)", () => {
      expect(toSiteName("map.city.example.jp", suffix)).toBe("map.city.example.jp");
      expect(validateSiteName("map.city.example.jp").ok).toBe(false);
    });

    test("without a configured suffix nothing is stripped", () => {
      expect(toSiteName("kawasaki-flood-map", undefined)).toBe("kawasaki-flood-map");
    });
  });

  test("cooldownError names the moment the name frees up", () => {
    expect(cooldownError(Date.UTC(2026, 8, 11))).toBe(
      "name was recently released and is on cooldown until 2026-09-11T00:00:00.000Z",
    );
  });
}
