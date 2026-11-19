import { describe, expect, test } from "vitest";
import type { CompatCredential, CredentialId, BucketName } from "../model";
import type { CredentialLookup } from "./auth";
import { parseSignedPathPrefix, parseSignedUrl, verifySignedUrl, type SignedRequest, type SignedUrlConfig } from "./signed-url";
import fixture from "./signed-url.fixture.json";

const credential: CompatCredential = {
  id: "fixture0000000001" as CredentialId,
  projectId: "p1",
  bucket: "media" as BucketName,
  role: "editor",
  clientEmail: fixture.clientEmail,
  publicJwk: fixture.publicJwk,
  label: null,
  createdBy: "u1",
  createdAt: 0,
  revokedAt: null,
};

const store = (row: CompatCredential = credential): CredentialLookup => ({
  findCredential: async () => row,
  findCredentialByEmail: async (email) => (email === row.clientEmail ? row : null),
});

const signedAt = parseSignedUrl(new URL(fixture.url))!.signedAt;
const cfg: SignedUrlConfig = { apiHost: fixture.apiHost, pathPrefix: null, now: signedAt + 60_000 };

function request(overrides: { method?: string; url?: string; headers?: Record<string, string> } = {}): SignedRequest {
  return {
    method: overrides.method ?? "PUT",
    url: new URL(overrides.url ?? fixture.url),
    headers: new Headers(overrides.headers ?? { "Content-Type": fixture.contentType, "Content-Encoding": fixture.contentEncoding }),
  };
}

function withParam(name: string, change: (value: string) => string): string {
  const url = new URL(fixture.url);
  url.searchParams.set(name, change(url.searchParams.get(name)!));
  return url.toString();
}

const bump = (text: string) => text.slice(0, -1) + String.fromCharCode(text.charCodeAt(text.length - 1) ^ 1);

describe("a URL the Go client v1.69 signed with an application's options (content type, Content-Encoding, extra query parameters)", () => {
  test("verifies against the stored public key", async () => {
    expect(await verifySignedUrl(store(), request(), cfg)).toEqual({ ok: true, credential });
  });

  test("verifies with the path escaped differently in transit", async () => {
    const url = fixture.url.replace("%281%29", "(1)").replace("my%20file", "my file");
    expect(await verifySignedUrl(store(), request({ url }), cfg)).toMatchObject({ ok: true });
  });

  test.each<[string, Partial<Parameters<typeof request>[0]>, Partial<SignedUrlConfig>]>([
    ["the method", { method: "PUU" }, {}],
    ["the bucket", { url: fixture.url.replace("/media/", "/medib/") }, {}],
    ["the key", { url: fixture.url.replace(".geojson", ".geojsoo") }, {}],
    ["the content-type header", { headers: { "Content-Type": bump(fixture.contentType), "Content-Encoding": "gzip" } }, {}],
    ["the content-encoding header", { headers: { "Content-Type": fixture.contentType, "Content-Encoding": "gzio" } }, {}],
    ["the host", {}, { apiHost: "storage.example.tesu:8443" }],
    ["X-Goog-Date", { url: withParam("X-Goog-Date", (v) => v.replace(/\dZ$/, (m) => `${Number(m[0]) ^ 1}Z`)) }, {}],
    ["X-Goog-Expires", { url: withParam("X-Goog-Expires", bump) }, {}],
    ["X-Goog-SignedHeaders", { url: withParam("X-Goog-SignedHeaders", (v) => v.replace("content-encoding;", "")) }, {}],
    ["X-Goog-Credential's region", { url: withParam("X-Goog-Credential", (v) => v.replace("/auto/", "/autp/")) }, {}],
    ["x-app-workspace", { url: withParam("x-app-workspace", bump) }, {}],
    ["x-app-project", { url: withParam("x-app-project", bump) }, {}],
    ["x-app-public", { url: withParam("x-app-public", bump) }, {}],
    ["X-Goog-Signature", { url: withParam("X-Goog-Signature", (v) => v.slice(0, -1) + (v.endsWith("0") ? "1" : "0")) }, {}],
    ["an added query parameter", { url: `${fixture.url}&x-app-extra=1` }, {}],
  ])("one changed byte in %s is SignatureDoesNotMatch", async (_, req, config) => {
    expect(await verifySignedUrl(store(), request(req), { ...cfg, ...config })).toEqual({ ok: false, failure: "signature_mismatch" });
  });

  test("a changed client email names no credential", async () => {
    const url = withParam("X-Goog-Credential", (v) => v.replace("0001@", "0002@"));
    expect(await verifySignedUrl(store(), request({ url }), cfg)).toEqual({ ok: false, failure: "unknown_credential" });
  });

  test.each([
    ["another algorithm", withParam("X-Goog-Algorithm", bump)],
    ["a scope date other than X-Goog-Date's", withParam("X-Goog-Credential", (v) => v.replace(/\/(\d{7})(\d)\//, (_, a, b) => `/${a}${Number(b) ^ 1}/`))],
    ["no host among the signed headers", withParam("X-Goog-SignedHeaders", (v) => v.replace(";host", ""))],
    ["an expiry over seven days", withParam("X-Goog-Expires", () => "604801")],
    ["a signature that is not hex", withParam("X-Goog-Signature", (v) => `${v.slice(0, -1)}g`)],
  ])("%s is malformed", async (_, url) => {
    expect(await verifySignedUrl(store(), request({ url }), cfg)).toEqual({ ok: false, failure: "malformed" });
  });

  test("past X-Goog-Date plus X-Goog-Expires it has expired, and well before X-Goog-Date it is not yet valid", async () => {
    const expires = parseSignedUrl(new URL(fixture.url))!.expiresSeconds;
    expect(await verifySignedUrl(store(), request(), { ...cfg, now: signedAt + expires * 1000 })).toMatchObject({ ok: true });
    expect(await verifySignedUrl(store(), request(), { ...cfg, now: signedAt + expires * 1000 + 1 })).toEqual({ ok: false, failure: "expired" });
    expect(await verifySignedUrl(store(), request(), { ...cfg, now: signedAt - 61_000 })).toEqual({ ok: false, failure: "not_yet_valid" });
  });

  test("a revoked credential's URL is refused", async () => {
    expect(await verifySignedUrl(store({ ...credential, revokedAt: 1 }), request(), cfg)).toEqual({ ok: false, failure: "unknown_credential" });
  });

  test("a URL rewritten onto another host under a path prefix verifies once the prefix is configured", async () => {
    const rewritten = new URL(fixture.url);
    rewritten.protocol = "http:";
    rewritten.host = "cms-assets.example.test";
    rewritten.pathname = `/uploads${rewritten.pathname}`;
    const req = request({ url: rewritten.toString() });
    expect(await verifySignedUrl(store(), req, cfg)).toEqual({ ok: false, failure: "signature_mismatch" });
    expect(await verifySignedUrl(store(), req, { ...cfg, pathPrefix: "/uploads" })).toMatchObject({ ok: true });
    expect(await verifySignedUrl(store(), request(), { ...cfg, pathPrefix: "/uploads" })).toMatchObject({ ok: true });
  });

  test("a URL signed for x-goog-content-sha256 is not supported", async () => {
    const url = withParam("X-Goog-SignedHeaders", (v) => `${v};x-goog-content-sha256`);
    expect(await verifySignedUrl(store(), request({ url }), cfg)).toEqual({ ok: false, failure: "unsupported" });
  });
});

test.each<[string | undefined, string | null]>([
  [undefined, null],
  ["", null],
  ["/", null],
  ["/uploads", "/uploads"],
  ["/uploads/", "/uploads"],
  ["/a/b", "/a/b"],
])("COMPAT_SIGNED_PATH_PREFIX %j parses to %j", (value, want) => {
  expect(parseSignedPathPrefix(value)).toBe(want);
});

test.each(["uploads", "/up loads", "/a?b", "/a#b", "https://x.test/a"])("COMPAT_SIGNED_PATH_PREFIX %j is a config error", (value) => {
  expect(() => parseSignedPathPrefix(value)).toThrow(/COMPAT_SIGNED_PATH_PREFIX/);
});
