import type { MiddlewareHandler } from "hono";
import { parseBucketName, type BucketName } from "./model";

export type CompatHostConfig = { api: string | undefined; objects: string | undefined };

export type CompatHost =
  | { kind: "gcs-api" }
  | { kind: "objects-path-style" }
  | { kind: "objects-virtual-host"; bucket: BucketName };

function hostname(host: string): string {
  return host.trim().toLowerCase().replace(/:\d+$/, "");
}

export function classifyCompatHost(host: string | null | undefined, cfg: CompatHostConfig): CompatHost | null {
  if (!host) return null;
  const name = hostname(host);
  if (cfg.api && name === hostname(cfg.api)) return { kind: "gcs-api" };
  if (!cfg.objects) return null;
  const objects = hostname(cfg.objects);
  if (name === objects) return { kind: "objects-path-style" };
  if (!name.endsWith(`.${objects}`)) return null;
  const bucket = parseBucketName(name.slice(0, -objects.length - 1));
  return bucket ? { kind: "objects-virtual-host", bucket } : null;
}

export function compatHostMiddleware(
  cfg: CompatHostConfig,
  serve: (host: CompatHost, req: Request) => Response | Promise<Response>,
): MiddlewareHandler {
  return async (c, next) => {
    const host = classifyCompatHost(c.req.header("Host"), cfg);
    if (!host) return next();
    return serve(host, c.req.raw);
  };
}

if (import.meta.vitest) {
  const { test, expect } = import.meta.vitest;
  const { isSiteHost } = await import("../site/middleware");

  const cfg: CompatHostConfig = { api: "storage.example.com", objects: "objects.example.com" };

  test.each<[string, CompatHostConfig, CompatHost | null]>([
    ["storage.example.com", cfg, { kind: "gcs-api" }],
    ["STORAGE.Example.COM", cfg, { kind: "gcs-api" }],
    ["storage.example.com:8443", cfg, { kind: "gcs-api" }],
    ["storage.localhost:8788", { api: "storage.localhost:8788", objects: undefined }, { kind: "gcs-api" }],
    ["storage.localhost", { api: "storage.localhost:8788", objects: undefined }, { kind: "gcs-api" }],
    ["objects.example.com", cfg, { kind: "objects-path-style" }],
    ["media.objects.example.com", cfg, { kind: "objects-virtual-host", bucket: "media" as BucketName }],
    ["Media.Objects.Example.com:443", cfg, { kind: "objects-virtual-host", bucket: "media" as BucketName }],
    ["my.dotted.bucket.objects.example.com", cfg, { kind: "objects-virtual-host", bucket: "my.dotted.bucket" as BucketName }],
    ["ab.objects.example.com", cfg, null],
    ["goog-x.objects.example.com", cfg, null],
    ["xobjects.example.com", cfg, null],
    ["storage.example.com.evil.test", cfg, null],
    ["example.com", cfg, null],
    ["", cfg, null],
    ["storage.example.com", { api: undefined, objects: undefined }, null],
    ["media.objects.example.com", { api: "storage.example.com", objects: undefined }, null],
  ])("%s", (host, config, expected) => {
    expect(classifyCompatHost(host, config)).toEqual(expected);
  });

  test("a site host stays a site host, and the compat host is not taken for one only because it is checked first", () => {
    const site = { baseUrl: "http://localhost:8788", suffix: ".localhost:8788" };
    const local = { api: "storage.localhost:8788", objects: "objects.localhost:8788" };
    expect(classifyCompatHost("0123456789abcdef.localhost:8788", local)).toBeNull();
    expect(isSiteHost("0123456789abcdef.localhost:8788", site)).toBe(true);
    expect(classifyCompatHost("localhost:8788", local)).toBeNull();
    expect(classifyCompatHost("storage.localhost:8788", local)).toEqual({ kind: "gcs-api" });
    expect(isSiteHost("storage.localhost:8788", site)).toBe(true);
  });
}
