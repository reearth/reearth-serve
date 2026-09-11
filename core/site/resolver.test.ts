import { describe, expect, test } from "vitest";
import { MemoryKeyValue } from "../../adapters/memory/memory-kv";
import { MemorySiteHostStore } from "../testing/fixture";
import { composeSiteHostResolver, hostCacheKey } from "./resolver";
import type { SiteHost } from "./repository";

// The resolution order of ADR-013 B6, in isolation from the middleware.

const SUFFIX = ".serve.example.test";
const ASSET_ID = "3f9a1c2b4d5e6f70";

function row(over: Partial<SiteHost> = {}): SiteHost {
  return {
    hostname: `kawasaki-flood-map${SUFFIX}`,
    assetId: ASSET_ID,
    projectId: "p1",
    kind: "subdomain",
    verifiedAt: null,
    disabledAt: null,
    previews: false,
    releasedAt: null,
    createdAt: 1000,
    createdBy: "u1",
    ...over,
  };
}

function setup(rows: SiteHost[] = [], opts: { cache?: MemoryKeyValue } = {}) {
  const hosts = new MemorySiteHostStore();
  for (const r of rows) hosts.hosts.set(r.hostname, r);
  const cache = opts.cache;
  const resolve = composeSiteHostResolver({ hosts, cache, suffix: SUFFIX });
  return { hosts, cache, resolve };
}

describe("composeSiteHostResolver", () => {
  test("an ID-shaped label resolves without touching the table", async () => {
    const hosts = new MemorySiteHostStore();
    // A store that throws if anything reads it: an ID host must cost no I/O.
    const resolve = composeSiteHostResolver({
      hosts: new Proxy(hosts, { get() { throw new Error("table read on an ID host"); } }),
      suffix: SUFFIX,
    });
    expect(await resolve(ASSET_ID)).toEqual({ kind: "asset", id: ASSET_ID });
    expect(await resolve("0123456789abcdef")).toEqual({ kind: "asset", id: "0123456789abcdef" });
  });

  test("a `--` label is a miss until B4 implements previews", async () => {
    const { resolve } = setup([row({ hostname: `v3--kawasaki-flood-map${SUFFIX}` })]);
    // Even with a row of that exact name in the table: the preview seam must
    // never fall through to a plain lookup, or `v3--name` would serve the
    // production site.
    expect(await resolve("v3--kawasaki-flood-map")).toBeNull();
    expect(await resolve("latest--kawasaki-flood-map")).toBeNull();
  });

  test("an active row resolves to its asset", async () => {
    const { resolve } = setup([row()]);
    expect(await resolve("kawasaki-flood-map")).toEqual({ kind: "asset", id: ASSET_ID });
  });

  test("a released row is gone, not a miss", async () => {
    const { resolve } = setup([row({ releasedAt: 5000, assetId: null })]);
    expect(await resolve("kawasaki-flood-map")).toEqual({ kind: "gone" });
  });

  test("an unclaimed name is a miss", async () => {
    const { resolve } = setup([]);
    expect(await resolve("kawasaki-flood-map")).toBeNull();
  });

  test("the label is joined to the suffix to make the lookup key", async () => {
    const { resolve } = setup([row({ hostname: `other${SUFFIX}`, assetId: "fedcba9876543210" })]);
    expect(await resolve("other")).toEqual({ kind: "asset", id: "fedcba9876543210" });
    expect(await resolve("kawasaki-flood-map")).toBeNull();
  });
});

describe("the resolution cache", () => {
  test("a hit is served from the cache on the second call", async () => {
    const cache = new MemoryKeyValue();
    const { hosts, resolve } = setup([row()], { cache });

    expect(await resolve("kawasaki-flood-map")).toEqual({ kind: "asset", id: ASSET_ID });
    expect(await cache.get(hostCacheKey(`kawasaki-flood-map${SUFFIX}`))).toBe(
      JSON.stringify({ t: "asset", id: ASSET_ID }),
    );

    // Drop the row: the answer must still come back, from the cache.
    hosts.hosts.clear();
    expect(await resolve("kawasaki-flood-map")).toEqual({ kind: "asset", id: ASSET_ID });
  });

  test("misses are cached too, so an unclaimed name is not a read per request", async () => {
    const cache = new MemoryKeyValue();
    const { hosts, resolve } = setup([], { cache });

    expect(await resolve("kawasaki-flood-map")).toBeNull();
    hosts.hosts.set(`kawasaki-flood-map${SUFFIX}`, row());
    // Still the cached miss — which is why claiming drops the key.
    expect(await resolve("kawasaki-flood-map")).toBeNull();
    await cache.delete(hostCacheKey(`kawasaki-flood-map${SUFFIX}`));
    expect(await resolve("kawasaki-flood-map")).toEqual({ kind: "asset", id: ASSET_ID });
  });

  test("a released row is cached as gone", async () => {
    const cache = new MemoryKeyValue();
    const { hosts, resolve } = setup([row({ releasedAt: 5000, assetId: null })], { cache });
    expect(await resolve("kawasaki-flood-map")).toEqual({ kind: "gone" });
    hosts.hosts.clear();
    expect(await resolve("kawasaki-flood-map")).toEqual({ kind: "gone" });
  });

  test("a cache that throws does not take the site down", async () => {
    const hosts = new MemorySiteHostStore();
    hosts.hosts.set(`kawasaki-flood-map${SUFFIX}`, row());
    const broken = {
      get: async () => { throw new Error("kv down"); },
      put: async () => { throw new Error("kv down"); },
      delete: async () => { throw new Error("kv down"); },
    };
    const resolve = composeSiteHostResolver({ hosts, cache: broken, suffix: SUFFIX });
    expect(await resolve("kawasaki-flood-map")).toEqual({ kind: "asset", id: ASSET_ID });
  });

  test("an ID host never writes a cache entry", async () => {
    const cache = new MemoryKeyValue();
    const { resolve } = setup([], { cache });
    await resolve(ASSET_ID);
    expect(cache.size).toBe(0);
  });
});
