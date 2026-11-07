import { describe, expect, test } from "vitest";
import { loadConfig } from "./config";

describe("loadConfig", () => {
  test("an empty environment yields a runnable scratch configuration", () => {
    const config = loadConfig({});
    expect(config.port).toBe(8788);
    expect(config.baseUrl).toBe("http://localhost:8788");
    expect(config.sqlitePath).toBe(":memory:");
    expect(config.objectStore).toBeNull();
    expect(config.containerLauncher).toBe("none");
    // No secret by default: protected sites (ADR-013 B7) fail closed until an
    // operator sets one, rather than running on a guessable default.
    expect(config.signingSecret).toBeUndefined();
  });

  test("SIGNING_SECRET is read, and an empty value is no secret at all", () => {
    expect(loadConfig({ SIGNING_SECRET: "s3cret" }).signingSecret).toBe("s3cret");
    expect(loadConfig({ SIGNING_SECRET: "" }).signingSecret).toBeUndefined();
  });

  test("without CERBOS_ENDPOINT the local directory and the policy table decide", () => {
    expect(loadConfig({}).tenancy).toEqual({ kind: "local" });
    expect(loadConfig({ CERBOS_ENDPOINT: "" }).tenancy).toEqual({ kind: "local" });
  });

  test("CERBOS_ENDPOINT selects Cerbos, and a value that is not an http(s) URL fails naming the setting", () => {
    expect(loadConfig({ CERBOS_ENDPOINT: "http://localhost:3592" }).tenancy).toEqual({
      kind: "cerbos",
      endpoint: "http://localhost:3592",
    });
    expect(() => loadConfig({ CERBOS_ENDPOINT: "localhost:3592" })).toThrow(/CERBOS_ENDPOINT/);
    expect(() => loadConfig({ CERBOS_ENDPOINT: "not a url" })).toThrow(/CERBOS_ENDPOINT/);
  });

  test("BASE_URL defaults to the configured port, not the default one", () => {
    expect(loadConfig({ PORT: "9000" }).baseUrl).toBe("http://localhost:9000");
    expect(loadConfig({ PORT: "9000", BASE_URL: "https://x.test" }).baseUrl).toBe("https://x.test");
  });

  test("anonymous uploads stay closed unless the value is exactly \"true\"", () => {
    expect(loadConfig({}).anonymousUploadEnabled).toBe(false);
    expect(loadConfig({ ANONYMOUS_UPLOAD_ENABLED: "1" }).anonymousUploadEnabled).toBe(false);
    expect(loadConfig({ ANONYMOUS_UPLOAD_ENABLED: "TRUE" }).anonymousUploadEnabled).toBe(false);
    expect(loadConfig({ ANONYMOUS_UPLOAD_ENABLED: "true" }).anonymousUploadEnabled).toBe(true);
  });

  test("a non-numeric or zero TTL falls back to the default", () => {
    expect(loadConfig({ ASSET_TTL_SECONDS: "60" }).assetTtlSeconds).toBe(60);
    expect(loadConfig({ ASSET_TTL_SECONDS: "nope" }).assetTtlSeconds).toBe(3600);
    expect(loadConfig({ ASSET_TTL_SECONDS: "0" }).assetTtlSeconds).toBe(3600);
  });

  test("OBJECT_STORE_* is parsed only when the three required values are present", () => {
    expect(loadConfig({ OBJECT_STORE_ENDPOINT: "https://s3.test" }).objectStore).toBeNull();
    expect(
      loadConfig({
        OBJECT_STORE_ENDPOINT: "https://s3.test",
        OBJECT_STORE_ACCESS_KEY_ID: "key",
        OBJECT_STORE_SECRET_ACCESS_KEY: "secret",
      }).objectStore,
    ).toEqual({
      endpoint: "https://s3.test",
      accessKeyId: "key",
      secretAccessKey: "secret",
      bucket: "reearth-serve",
      region: "auto",
      pathStyle: false,
    });
  });

  test("an unsupported CONTAINER_LAUNCHER fails loudly instead of silently doing nothing", () => {
    expect(() => loadConfig({ CONTAINER_LAUNCHER: "docker" })).toThrow(/not supported/);
    expect(loadConfig({ CONTAINER_LAUNCHER: "none" }).containerLauncher).toBe("none");
  });

  test("CREDENTIALED_ORIGINS is parsed, and a malformed entry refuses to start", () => {
    expect(loadConfig({}).credentialedOrigins).toEqual([]);
    expect(loadConfig({ CREDENTIALED_ORIGINS: "https://a.example.com,https://b.example.net" }).credentialedOrigins)
      .toEqual(["https://a.example.com", "https://b.example.net"]);
    expect(() => loadConfig({ CREDENTIALED_ORIGINS: "https://a.example.com/app" })).toThrow(/CREDENTIALED_ORIGINS/);
  });

  test("site hosts refuse to start on the API's own registrable domain", () => {
    const sites = { SITE_HOST_SUFFIX: ".sites.example.net", SITE_REGISTRABLE_DOMAIN: "example.net" };
    // The Node default BASE_URL does not count: the operator must say it.
    expect(() => loadConfig(sites)).toThrow(/BASE_URL/);
    expect(() => loadConfig({ ...sites, BASE_URL: "https://api.example.net" })).toThrow(/same site/);
    expect(loadConfig({ ...sites, BASE_URL: "https://api.example.com" }).siteDomainIsPublicSuffix).toBe(false);
    expect(loadConfig({
      SITE_HOST_SUFFIX: ".localhost:8788", BASE_URL: "http://localhost:8788",
      SITE_REGISTRABLE_DOMAIN: "localhost", SITE_DOMAIN_IS_PUBLIC_SUFFIX: "true",
    }).siteDomainIsPublicSuffix).toBe(true);
  });
});
