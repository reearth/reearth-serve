import { describe, expect, test, vi } from "vitest";
import { buildDeps } from "./cloudflare-deps";

// The real launcher imports `cloudflare:workers`, which only exists inside workerd.
vi.mock("./container", () => ({ CloudflareContainerLauncher: class {} }));

const env = { BASE_URL: "https://api.example.test", ASSET_TTL_SECONDS: "3600" } as unknown as Env;

describe("buildDeps", () => {
  test("COMPAT_GCS_HOST takes a bare host[:port]", () => {
    expect(buildDeps(env).compatApiHost).toBeUndefined();
    expect(buildDeps({ ...env, COMPAT_GCS_HOST: "storage.example.test:8443" }).compatApiHost).toBe("storage.example.test:8443");
  });

  test("a COMPAT_GCS_HOST with a scheme or path is a config error naming the setting", () => {
    for (const bad of ["https://storage.example.test", "storage.example.test/gcs"]) {
      expect(() => buildDeps({ ...env, COMPAT_GCS_HOST: bad })).toThrow(/COMPAT_GCS_HOST/);
    }
  });

  test("a compat host on the BASE_URL host, or one host for both, is a config error naming the setting", () => {
    expect(() => buildDeps({ ...env, COMPAT_GCS_HOST: "api.example.test" })).toThrow(/COMPAT_GCS_HOST/);
    expect(() => buildDeps({ ...env, COMPAT_OBJECTS_HOST: "example.test" })).toThrow(/COMPAT_OBJECTS_HOST/);
    expect(() => buildDeps({ ...env, COMPAT_GCS_HOST: "storage.example.test", COMPAT_OBJECTS_HOST: "storage.example.test" }))
      .toThrow(/COMPAT_OBJECTS_HOST/);
  });

  test("an objects host under the site-host suffix, the API host or the BASE_URL host is a config error naming the setting", () => {
    expect(() => buildDeps({ ...env, SITE_HOST_SUFFIX: ".sites.example.net", SITE_REGISTRABLE_DOMAIN: "example.net", COMPAT_OBJECTS_HOST: "o.sites.example.net" })).toThrow(/COMPAT_OBJECTS_HOST/);
    expect(() => buildDeps({ ...env, COMPAT_GCS_HOST: "storage.example.test", COMPAT_OBJECTS_HOST: "objects.storage.example.test" })).toThrow(/COMPAT_OBJECTS_HOST/);
    expect(() => buildDeps({ ...env, COMPAT_OBJECTS_HOST: `objects.${new URL(env.BASE_URL).hostname}` })).toThrow(/COMPAT_OBJECTS_HOST/);
  });
});
