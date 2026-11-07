/**
 * The primitives behind password protection (ADR-013 B7): the hash, the signed
 * cookie, the `Authorization: Basic` decode, and the open-redirect guard on
 * `next`.
 *
 * All of it runs at {@link TEST_ITERATIONS} rather than the production 600 000
 * — the work factor travels inside the stored hash, so these verify through
 * exactly the same code path a production hash does.
 */
import { describe, expect, test } from "vitest";
import { TEST_ITERATIONS } from "../../adapters/memory/fixture";
import {
  APEX_COOKIE,
  buildSetCookie,
  COOKIE_MAX_AGE_SECONDS,
  mintAuthCookie,
  parseCookieHeader,
  shouldUseSecureCookie,
  SITE_COOKIE,
  verifyAuthCookie,
} from "./cookie";
import {
  basicPassword,
  constantTimeEqual,
  DEFAULT_ITERATIONS,
  hashPassword,
  verifyPassword,
} from "./password";
import { safeNextPath } from "./resolve";

const SECRET = "a-signing-secret-that-is-long-enough";

describe("PBKDF2 password hashing", () => {
  test("a hash round-trips and rejects everything else", async () => {
    const stored = await hashPassword("open-sesame", { iterations: TEST_ITERATIONS });
    expect(await verifyPassword("open-sesame", stored)).toBe(true);
    expect(await verifyPassword("open-sesam", stored)).toBe(false);
    expect(await verifyPassword("", stored)).toBe(false);
    expect(await verifyPassword("OPEN-SESAME", stored)).toBe(false);
  });

  test("the same password twice gives different hashes (per-asset salt)", async () => {
    const a = await hashPassword("same", { iterations: TEST_ITERATIONS });
    const b = await hashPassword("same", { iterations: TEST_ITERATIONS });
    expect(a.salt).not.toBe(b.salt);
    expect(a.hash).not.toBe(b.hash);
    // Both still verify: it is the salt that differs, not the password.
    expect(await verifyPassword("same", a)).toBe(true);
    expect(await verifyPassword("same", b)).toBe(true);
  });

  test("the work factor is inside the hash, so it can be raised later", async () => {
    const stored = await hashPassword("pw", { iterations: TEST_ITERATIONS });
    expect(stored.hash.startsWith(`pbkdf2-sha256$${TEST_ITERATIONS}$`)).toBe(true);
    // Production hashes at 600k unless a caller says otherwise.
    expect(DEFAULT_ITERATIONS).toBe(600_000);
  });

  test("a malformed stored hash fails closed instead of throwing", async () => {
    expect(await verifyPassword("pw", { hash: "nonsense", salt: "AAAA" })).toBe(false);
    expect(await verifyPassword("pw", { hash: "scrypt$1$AAAA", salt: "AAAA" })).toBe(false);
    expect(await verifyPassword("pw", { hash: "pbkdf2-sha256$0$AAAA", salt: "AAAA" })).toBe(false);
    expect(await verifyPassword("pw", { hash: "pbkdf2-sha256$10$AAAA", salt: "!!!" })).toBe(false);
  });

  test("constantTimeEqual is an equality test", () => {
    expect(constantTimeEqual("abc", "abc")).toBe(true);
    expect(constantTimeEqual("abc", "abd")).toBe(false);
    expect(constantTimeEqual("abc", "ab")).toBe(false);
  });
});

describe("Authorization: Basic", () => {
  test("the user half is ignored and the password half comes back", () => {
    const header = `Basic ${btoa("anyone:s3cret")}`;
    expect(basicPassword(header)).toBe("s3cret");
    // An empty user is what curl sends for `curl -u :pw`.
    expect(basicPassword(`Basic ${btoa(":s3cret")}`)).toBe("s3cret");
    // A password containing a colon survives intact.
    expect(basicPassword(`Basic ${btoa("u:a:b")}`)).toBe("a:b");
  });

  test("anything that is not a Basic header is null", () => {
    expect(basicPassword(null)).toBeNull();
    expect(basicPassword("Bearer abc")).toBeNull();
    expect(basicPassword("Basic !!!not-base64!!!")).toBeNull();
    // No colon at all: not a credential.
    expect(basicPassword(`Basic ${btoa("nocolon")}`)).toBeNull();
  });
});

describe("the auth cookie", () => {
  const claims = { assetId: "3f9a1c2b4d5e6f70", passwordVersion: 2 };
  const now = 1_700_000_000_000;
  const future = Math.floor(now / 1000) + 3600;

  async function mint(overrides: Partial<typeof claims> & { exp?: number } = {}) {
    return mintAuthCookie(SECRET, { ...claims, exp: future, ...overrides });
  }

  test("a freshly minted cookie verifies", async () => {
    const value = await mint();
    expect(await verifyAuthCookie(SECRET, value, { ...claims, now })).toBe(true);
  });

  test("an expired cookie does not", async () => {
    const value = await mint({ exp: Math.floor(now / 1000) - 1 });
    expect(await verifyAuthCookie(SECRET, value, { ...claims, now })).toBe(false);
  });

  test("a cookie from before a password change does not (passwordVersion)", async () => {
    const value = await mint({ passwordVersion: 1 });
    expect(await verifyAuthCookie(SECRET, value, { ...claims, now })).toBe(false);
  });

  test("a cookie for another asset does not", async () => {
    const value = await mint({ assetId: "fedcba9876543210" });
    expect(await verifyAuthCookie(SECRET, value, { ...claims, now })).toBe(false);
  });

  test("a cookie signed with another secret does not", async () => {
    const value = await mintAuthCookie("a-different-secret", { ...claims, exp: future });
    expect(await verifyAuthCookie(SECRET, value, { ...claims, now })).toBe(false);
  });

  test("garbage and absence are rejected without throwing", async () => {
    for (const value of [undefined, null, "", "not-base64url!!", btoa("a.b")]) {
      expect(await verifyAuthCookie(SECRET, value, { ...claims, now })).toBe(false);
    }
  });

  test("a cookie MAC'd without the domain-separation label does not", async () => {
    const payload = `${claims.assetId}.${claims.passwordVersion}.${future}`;
    const key = await crypto.subtle.importKey(
      "raw", new TextEncoder().encode(SECRET), { name: "HMAC", hash: "SHA-256" }, false, ["sign"],
    );
    const mac = new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(payload)));
    const hex = [...mac].map((b) => b.toString(16).padStart(2, "0")).join("");
    const unlabelled = btoa(`${payload}.${hex}`).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
    expect(await verifyAuthCookie(SECRET, unlabelled, { ...claims, now })).toBe(false);
  });

  test("a tampered payload is rejected", async () => {
    const value = await mint();
    const at = Math.floor(value.length / 2);
    const flipped = value.slice(0, at) + (value[at] === "A" ? "B" : "A") + value.slice(at + 1);
    expect(flipped).not.toBe(value);
    expect(await verifyAuthCookie(SECRET, flipped, { ...claims, now })).toBe(false);
  });
});

describe("Set-Cookie", () => {
  test("on the apex: serve_access, scoped to the asset's file prefix", () => {
    const value = buildSetCookie({ value: "v", siteHost: false, assetId: "abc", secure: true });
    expect(APEX_COOKIE).toBe("serve_access");
    expect(value.startsWith("serve_access=v;")).toBe(true);
    expect(value).toContain("Path=/files/abc");
    expect(value).toContain(`Max-Age=${COOKIE_MAX_AGE_SECONDS}`);
    expect(COOKIE_MAX_AGE_SECONDS).toBe(7 * 24 * 60 * 60);
    expect(value).toContain("HttpOnly");
    expect(value).toContain("SameSite=Lax");
    expect(value).toContain("Secure");
  });

  test("on a site host: __Host-serve_access, Path=/, no Domain, Secure even on http loopback", () => {
    const value = buildSetCookie({ value: "v", siteHost: true, assetId: "abc", secure: false });
    expect(SITE_COOKIE).toBe("__Host-serve_access");
    expect(value.startsWith("__Host-serve_access=v;")).toBe(true);
    expect(value).toContain("Path=/;");
    expect(value).not.toContain("Domain");
    expect(value).toContain("Secure");
  });

  test("Secure is dropped only for plain-http loopback", () => {
    expect(shouldUseSecureCookie(new URL("https://serve.example.com/"))).toBe(true);
    expect(shouldUseSecureCookie(new URL("https://localhost:8788/"))).toBe(true);
    expect(shouldUseSecureCookie(new URL("http://localhost:8788/"))).toBe(false);
    expect(shouldUseSecureCookie(new URL("http://127.0.0.1:8788/"))).toBe(false);
    // A plain-http deployment that is not loopback still gets Secure — a
    // cookie that never comes back is the honest answer to cleartext.
    expect(shouldUseSecureCookie(new URL("http://serve.example.com/"))).toBe(true);
    expect(buildSetCookie({ value: "v", siteHost: false, assetId: "abc", secure: false })).not.toContain("Secure");
  });

  test("parseCookieHeader survives the shapes browsers send", () => {
    expect(parseCookieHeader("a=1; __Host-serve_access=xyz; b=2")).toMatchObject({
      a: "1", "__Host-serve_access": "xyz", b: "2",
    });
    expect(parseCookieHeader(null)).toEqual({});
    expect(parseCookieHeader("novalue")).toEqual({});
  });
});

describe("the `next` open-redirect guard", () => {
  test("a rooted path is kept", () => {
    expect(safeNextPath("/docs/", "/")).toBe("/docs/");
    expect(safeNextPath("/a/b?c=1", "/")).toBe("/a/b?c=1");
  });

  test("anything that could leave the origin falls back", () => {
    for (const value of [
      "https://evil.example/",
      "//evil.example/",
      "/\\evil.example/",
      "\\\\evil.example/",
      "docs/",
      "",
      undefined,
      42,
    ]) {
      expect(safeNextPath(value, "/fallback")).toBe("/fallback");
    }
  });
});
