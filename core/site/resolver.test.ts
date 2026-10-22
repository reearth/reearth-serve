import { describe, expect, test } from "vitest";
import { MemoryKeyValue } from "../../adapters/memory/memory-kv";
import { MemorySiteHostStore, MemoryVersionStore } from "../testing/fixture";
import { composeSiteHostResolver, hostCacheKey } from "./resolver";
import type { AssetVersion } from "../asset/model";
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
    verificationToken: null,
    certificateStatus: null,
    ...over,
  };
}

/** Version `n` of {@link ASSET_ID}, with a distinguishable version ID. */
function version(n: number): AssetVersion {
  return {
    id: `00000000000000${String(n).padStart(2, "0")}`,
    assetId: ASSET_ID,
    version: n,
    filename: "site.zip",
    contentType: "application/zip",
    size: 3,
    createdAt: n,
    type: "archive",
    status: "ready",
  };
}

function setup(rows: SiteHost[] = [], opts: { cache?: MemoryKeyValue; versions?: number[] } = {}) {
  const hosts = new MemorySiteHostStore();
  for (const r of rows) hosts.hosts.set(r.hostname, r);
  const versions = new MemoryVersionStore();
  for (const n of opts.versions ?? []) versions.versions.set(version(n).id, version(n));
  const cache = opts.cache;
  const resolver = composeSiteHostResolver({ hosts, versions, cache, suffix: SUFFIX });
  // Almost every case here is a host under the suffix, so the helper takes the
  // bare label; `resolveCustom` is the B5 form, whose key is the whole host.
  const resolve = (label: string) => resolver({ form: "label", label });
  const resolveCustom = (hostname: string) => resolver({ form: "custom", hostname });
  return { hosts, versions, cache, resolve, resolveCustom };
}

describe("composeSiteHostResolver", () => {
  test("an ID-shaped label resolves without touching the table", async () => {
    const hosts = new MemorySiteHostStore();
    // A store that throws if anything reads it: an ID host must cost no I/O.
    const resolver = composeSiteHostResolver({
      hosts: new Proxy(hosts, { get() { throw new Error("table read on an ID host"); } }),
      versions: new MemoryVersionStore(),
      suffix: SUFFIX,
    });
    const resolve = (label: string) => resolver({ form: "label", label });
    expect(await resolve(ASSET_ID)).toEqual({ kind: "asset", id: ASSET_ID });
    expect(await resolve("0123456789abcdef")).toEqual({ kind: "asset", id: "0123456789abcdef" });
  });

  test("a `--` label never falls through to a plain lookup", async () => {
    // A row whose hostname is literally `v3--…` cannot be claimed (B2 forbids
    // `--`), but if one existed the preview branch must still not serve it as
    // a named site.
    const { resolve } = setup([row({ hostname: `v3--kawasaki-flood-map${SUFFIX}` })]);
    expect(await resolve("v3--kawasaki-flood-map")).toBeNull();
  });

  test("an active row resolves to its asset", async () => {
    const { resolve } = setup([row()]);
    expect(await resolve("kawasaki-flood-map")).toEqual({ kind: "asset", id: ASSET_ID });
  });

  test("a disabled row is disabled, not a miss and not gone", async () => {
    const { resolve } = setup([row({ disabledAt: 4000 })]);
    expect(await resolve("kawasaki-flood-map")).toEqual({ kind: "disabled" });
  });

  test("a released row that was also disabled is gone: release outranks disable", async () => {
    const { resolve } = setup([row({ disabledAt: 4000, releasedAt: 5000, assetId: null })]);
    expect(await resolve("kawasaki-flood-map")).toEqual({ kind: "gone" });
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

describe("preview hosts (ADR-013 B4)", () => {
  /** A name with previews on and versions 1–3 of its asset. */
  function previewSetup(over: Partial<SiteHost> = {}) {
    return setup([row({ previews: true, ...over })], { versions: [1, 2, 3] });
  }

  test("`v{n}--name` resolves to that version's ID, pinned", async () => {
    const { resolve } = previewSetup();
    expect(await resolve("v1--kawasaki-flood-map")).toEqual({
      kind: "asset", id: version(1).id, preview: "pinned",
    });
    expect(await resolve("v3--kawasaki-flood-map")).toEqual({
      kind: "asset", id: version(3).id, preview: "pinned",
    });
  });

  test("`latest--name` resolves to the newest version, following the asset", async () => {
    const { resolve } = previewSetup();
    expect(await resolve("latest--kawasaki-flood-map")).toEqual({
      kind: "asset", id: version(3).id, preview: "latest",
    });
  });

  test("the split is on the FIRST `--`, so the name is what follows it", async () => {
    const { resolve } = previewSetup();
    // Names cannot contain `--` (B2), so everything after the first one is the
    // name and this can only ever miss — never resolve to some other site.
    expect(await resolve("v1--kawasaki--flood-map")).toBeNull();
  });

  test("a left side that is not a version is a 404, with no table read", async () => {
    const hosts = new MemorySiteHostStore();
    const versions = new MemoryVersionStore();
    const resolver = composeSiteHostResolver({
      hosts: new Proxy(hosts, { get() { throw new Error("table read on a bad preview label"); } }),
      versions, suffix: SUFFIX,
    });
    const resolve = (label: string) => resolver({ form: "label", label });
    for (const label of ["staging--kawasaki-flood-map", "--kawasaki-flood-map", "v--x", "3--x"]) {
      expect(await resolve(label), label).toBeNull();
    }
  });

  test("`v0` and `v01` are not versions", async () => {
    const { resolve } = previewSetup();
    // ADR-005 numbers versions from 1, and `v01` would be a second spelling of
    // `v1` — two hostnames for one page.
    expect(await resolve("v0--kawasaki-flood-map")).toBeNull();
    expect(await resolve("v01--kawasaki-flood-map")).toBeNull();
  });

  test("a version number the asset does not have is a 404", async () => {
    const { resolve } = previewSetup();
    expect(await resolve("v4--kawasaki-flood-map")).toBeNull();
  });

  test("an asset with no versions has no `latest--` host", async () => {
    const { resolve } = setup([row({ previews: true })], { versions: [] });
    expect(await resolve("latest--kawasaki-flood-map")).toBeNull();
  });

  test("previews off is a 404: the name serves, its previews do not", async () => {
    const { resolve } = setup([row({ previews: false })], { versions: [1, 2, 3] });
    expect(await resolve("kawasaki-flood-map")).toEqual({ kind: "asset", id: ASSET_ID });
    expect(await resolve("v1--kawasaki-flood-map")).toBeNull();
    expect(await resolve("latest--kawasaki-flood-map")).toBeNull();
  });

  test("an unclaimed name has no previews", async () => {
    const { resolve } = setup([], { versions: [1] });
    expect(await resolve("v1--kawasaki-flood-map")).toBeNull();
  });

  test("a disabled name takes its previews down with it (503)", async () => {
    const { resolve } = previewSetup({ disabledAt: 4000 });
    expect(await resolve("v1--kawasaki-flood-map")).toEqual({ kind: "disabled" });
    expect(await resolve("latest--kawasaki-flood-map")).toEqual({ kind: "disabled" });
  });

  test("a released name's previews are gone with it (410)", async () => {
    const { resolve } = previewSetup({ releasedAt: 5000, assetId: null });
    expect(await resolve("v1--kawasaki-flood-map")).toEqual({ kind: "gone" });
  });

  test("a custom-domain row never has previews, whatever the flag says", async () => {
    // B5: `v{n}--` has no meaning on a customer's own domain.
    const { resolve } = setup([row({ kind: "custom", previews: true })], { versions: [1] });
    expect(await resolve("v1--kawasaki-flood-map")).toBeNull();
  });

  test("a name and its previews share one cache entry", async () => {
    const cache = new MemoryKeyValue();
    const { hosts, resolve } = setup([row({ previews: true })], { cache, versions: [1, 2, 3] });

    expect(await resolve("kawasaki-flood-map")).toEqual({ kind: "asset", id: ASSET_ID });
    expect(cache.size).toBe(1);

    // The row is gone from the table; the preview is still answered, from the
    // entry the bare name wrote.
    hosts.hosts.clear();
    expect(await resolve("v2--kawasaki-flood-map")).toEqual({
      kind: "asset", id: version(2).id, preview: "pinned",
    });
    expect(cache.size).toBe(1);
  });
});

describe("the resolution cache", () => {
  test("a hit is served from the cache on the second call", async () => {
    const cache = new MemoryKeyValue();
    const { hosts, resolve } = setup([row()], { cache });

    expect(await resolve("kawasaki-flood-map")).toEqual({ kind: "asset", id: ASSET_ID });
    expect(await cache.get(hostCacheKey(`kawasaki-flood-map${SUFFIX}`))).toBe(
      // `previews` rides along so a preview host costs no second read (B4).
      JSON.stringify({ t: "asset", id: ASSET_ID, previews: false }),
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

  test("a disabled row is cached as disabled, which is why the PATCH drops the key", async () => {
    const cache = new MemoryKeyValue();
    const { hosts, resolve } = setup([row({ disabledAt: 4000 })], { cache });
    expect(await resolve("kawasaki-flood-map")).toEqual({ kind: "disabled" });

    // Enabling the row without dropping the key leaves the site down until the
    // entry expires; the use case drops it for exactly this reason.
    hosts.hosts.set(`kawasaki-flood-map${SUFFIX}`, row({ disabledAt: null }));
    expect(await resolve("kawasaki-flood-map")).toEqual({ kind: "disabled" });
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
    const resolver = composeSiteHostResolver({
      hosts, versions: new MemoryVersionStore(), cache: broken, suffix: SUFFIX,
    });
    const resolve = (label: string) => resolver({ form: "label", label });
    expect(await resolve("kawasaki-flood-map")).toEqual({ kind: "asset", id: ASSET_ID });
  });

  test("an ID host never writes a cache entry", async () => {
    const cache = new MemoryKeyValue();
    const { resolve } = setup([], { cache });
    await resolve(ASSET_ID);
    expect(cache.size).toBe(0);
  });
});
