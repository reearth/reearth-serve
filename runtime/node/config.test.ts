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
});
