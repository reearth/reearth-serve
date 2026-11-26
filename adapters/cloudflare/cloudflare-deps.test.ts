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
});
