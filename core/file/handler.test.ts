import { describe, expect, test } from "vitest";
import { gzipSync } from "node:zlib";
import { createApp } from "../app";
import type { Deps } from "../types";
import type { AssetMetadata, AssetVersion } from "../asset/model";
import type { ListResult, MetadataStore, VersionStore } from "../asset/repository";
import type { Session, SessionStore } from "../session/repository";
import { MemoryFileStorage } from "../../adapters/memory/storage";
import { SimpleAuthorizer } from "../../adapters/cloudflare/authorizer";
import { DEFAULT_CACHE_CONTROL, ENTRY_CACHE_CONTROL, PINNED_CACHE_CONTROL } from "./caching";

// Delivery semantics that static-site hosting depends on (ADR-013): index
// file resolution, directory redirects, and the cache/ETag policy. Everything
// runs against the in-memory adapters, so a single-file and an archive asset
// are seeded straight into storage under the versioned and legacy layouts.

class MemoryMetadataStore implements MetadataStore {
  readonly assets = new Map<string, AssetMetadata>();
  async save(asset: AssetMetadata): Promise<void> {
    this.assets.set(asset.id, asset);
  }
  async find(id: string): Promise<AssetMetadata | null> {
    return this.assets.get(id) ?? null;
  }
  async update(): Promise<void> {}
  async delete(id: string): Promise<void> {
    this.assets.delete(id);
  }
  async list(): Promise<{ items: AssetMetadata[]; cursor?: string }> {
    return { items: [...this.assets.values()] };
  }
}

class MemoryVersionStore implements VersionStore {
  readonly versions = new Map<string, AssetVersion>();
  async save(version: AssetVersion): Promise<AssetVersion> {
    this.versions.set(version.id, version);
    return version;
  }
  async find(id: string): Promise<AssetVersion | null> {
    return this.versions.get(id) ?? null;
  }
  async findByAssetId(assetId: string): Promise<ListResult<AssetVersion>> {
    return { items: [...this.versions.values()].filter((v) => v.assetId === assetId) };
  }
  async findLatest(assetId: string): Promise<AssetVersion | null> {
    const all = (await this.findByAssetId(assetId)).items.sort((a, b) => b.version - a.version);
    return all[0] ?? null;
  }
  async update(): Promise<void> {}
  async delete(id: string): Promise<void> {
    this.versions.delete(id);
  }
  async deleteByAssetId(assetId: string): Promise<{ totalSize: number; count: number }> {
    const items = (await this.findByAssetId(assetId)).items;
    for (const v of items) this.versions.delete(v.id);
    return { totalSize: items.reduce((n, v) => n + v.size, 0), count: items.length };
  }
  async count(assetId: string): Promise<number> {
    return (await this.findByAssetId(assetId)).items.length;
  }
}

class MemorySessionStore implements SessionStore {
  readonly sessions = new Map<string, Session>();
  async save(session: Session): Promise<void> {
    this.sessions.set(session.id, session);
  }
  async find(id: string): Promise<Session | null> {
    return this.sessions.get(id) ?? null;
  }
}

function unused<T>(name: string): T {
  return new Proxy({} as object, {
    get() {
      throw new Error(`fake dependency "${name}" was called unexpectedly`);
    },
  }) as T;
}

function bytes(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

function stream(data: Uint8Array): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(c) {
      c.enqueue(data);
      c.close();
    },
  });
}

const INDEX_HTML = "<!doctype html><title>site</title>";
const DOCS_HTML = "<!doctype html><title>docs</title>";
const APP_JS = "console.log('hello from a bundle that is long enough to matter')";

async function fixture() {
  const metadata = new MemoryMetadataStore();
  const versions = new MemoryVersionStore();
  const storage = new MemoryFileStorage();

  // Archive asset "site" with active version "v1", extracted into the
  // versioned layout. app.js is stored gzip the way the extractor transmuxes
  // deflate entries.
  metadata.assets.set("site", {
    id: "site",
    filename: "site.zip",
    contentType: "application/zip",
    size: 3,
    createdAt: 0,
    expiresAt: 0,
    type: "archive",
    status: "ready",
  });
  versions.versions.set("v1", {
    id: "v1",
    assetId: "site",
    version: 1,
    filename: "site.zip",
    contentType: "application/zip",
    size: 3,
    createdAt: 0,
    type: "archive",
    status: "ready",
  });
  await storage.put("assets/site/v/v1/site.zip", stream(bytes("PK\x03")), "application/zip", 3);
  await storage.put("assets/site/v/v1/files/index.html", stream(bytes(INDEX_HTML)), "text/html; charset=utf-8", INDEX_HTML.length);
  await storage.put("assets/site/v/v1/files/docs/index.html", stream(bytes(DOCS_HTML)), "text/html; charset=utf-8", DOCS_HTML.length);
  const gz = new Uint8Array(gzipSync(APP_JS));
  await storage.put("assets/site/v/v1/files/assets/app.js", stream(gz), "text/javascript", gz.byteLength, { contentEncoding: "gzip" });

  // Legacy single-file asset "geo" with no version row.
  const geojson = '{"type":"FeatureCollection","features":[]}';
  metadata.assets.set("geo", {
    id: "geo",
    filename: "data.geojson",
    contentType: "application/geo+json",
    size: geojson.length,
    createdAt: 0,
    expiresAt: 0,
  });
  await storage.put("assets/geo/data.geojson", stream(bytes(geojson)), "application/geo+json", geojson.length);

  const deps: Deps = {
    metadata,
    versions,
    storage,
    writes: unused("writes"),
    uploadSessions: unused("uploadSessions"),
    presignedUrls: null,
    jobs: unused("jobs"),
    ttlSeconds: 3600,
    baseUrl: "https://example.test",
    authorizer: new SimpleAuthorizer(),
    projects: unused("projects"),
    workspaces: unused("workspaces"),
    members: unused("members"),
    extractionQueue: null,
    thumbnailQueue: null,
    storageUsage: unused("storageUsage"),
    pendingCleanup: unused("pendingCleanup"),
    anonymousUploadEnabled: false,
    sessions: new MemorySessionStore(),
    sessionTtlSeconds: 60,
    internalApiSecret: undefined,
    auth: {},
    containers: unused("containers"),
    extractionStuckThresholdMs: 1000,
    limits: { subrequestBudget: 700 },
  };
  return { app: createApp(deps), geojson };
}

describe("index file resolution", () => {
  test("GET /files/:id serves the archive's index.html", async () => {
    const { app } = await fixture();
    const res = await app.request("/files/site");
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("text/html; charset=utf-8");
    expect(await res.text()).toBe(INDEX_HTML);
  });

  test("a trailing slash resolves the directory's index.html", async () => {
    const { app } = await fixture();
    expect(await (await app.request("/files/site/")).text()).toBe(INDEX_HTML);
    expect(await (await app.request("/files/site/docs/")).text()).toBe(DOCS_HTML);
  });

  test("a directory without a trailing slash redirects to the slash form", async () => {
    const { app } = await fixture();
    const res = await app.request("http://localhost/files/site/docs?x=1");
    expect(res.status).toBe(301);
    expect(res.headers.get("Location")).toBe("http://localhost/files/site/docs/?x=1");
  });

  test("the archive itself is still reachable by its filename", async () => {
    const { app } = await fixture();
    const res = await app.request("/files/site/site.zip");
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("application/zip");
  });

  test("a missing entry is 404, not the index", async () => {
    const { app } = await fixture();
    expect((await app.request("/files/site/nope.js")).status).toBe(404);
    expect((await app.request("/files/site/nope/")).status).toBe(404);
  });

  test("GET /files/:id on a single-file asset serves the file", async () => {
    const { app, geojson } = await fixture();
    const bare = await app.request("/files/geo");
    expect(bare.status).toBe(200);
    expect(bare.headers.get("Content-Type")).toBe("application/geo+json");
    expect(await bare.text()).toBe(geojson);
    expect(await (await app.request("/files/geo/data.geojson")).text()).toBe(geojson);
  });

  test("HEAD returns headers and no body", async () => {
    const { app } = await fixture();
    const res = await app.request("/files/site", { method: "HEAD" });
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Length")).toBe(String(INDEX_HTML.length));
    expect(await res.text()).toBe("");
  });
});

describe("cache policy", () => {
  test("HTML at an asset URL is revalidated on every load", async () => {
    const { app } = await fixture();
    const res = await app.request("/files/site/index.html");
    expect(res.headers.get("Cache-Control")).toBe(ENTRY_CACHE_CONTROL);
    expect(res.headers.get("ETag")).toMatch(/^"[0-9a-f]{32}"$/);
  });

  test("other files at an asset URL are cacheable but not immutable", async () => {
    const { app } = await fixture();
    const res = await app.request("/files/site/assets/app.js", { headers: { "Accept-Encoding": "gzip" } });
    expect(res.headers.get("Cache-Control")).toBe(DEFAULT_CACHE_CONTROL);
    expect(res.headers.get("Content-Encoding")).toBe("gzip");
    expect(res.headers.get("Vary")).toBe("Accept-Encoding");
    // Untouched stored bytes → strong tag.
    expect(res.headers.get("ETag")).toMatch(/^"[0-9a-f]{32}"$/);
  });

  test("a version-pinned URL is immutable", async () => {
    const { app } = await fixture();
    const res = await app.request("/files/v1/index.html");
    expect(res.status).toBe(200);
    expect(res.headers.get("Cache-Control")).toBe(PINNED_CACHE_CONTROL);
  });

  test("decoding gzip on the fly yields a weak ETag and the plain body", async () => {
    const { app } = await fixture();
    const res = await app.request("/files/site/assets/app.js", { headers: { "Accept-Encoding": "identity" } });
    expect(res.headers.get("Content-Encoding")).toBeNull();
    expect(res.headers.get("ETag")).toMatch(/^W\/"[0-9a-f]{32}"$/);
    expect(await res.text()).toBe(APP_JS);
  });

  test("If-None-Match with the current tag answers 304 without a body", async () => {
    const { app } = await fixture();
    const first = await app.request("/files/site/index.html");
    const etag = first.headers.get("ETag")!;
    const res = await app.request("/files/site/index.html", { headers: { "If-None-Match": etag } });
    expect(res.status).toBe(304);
    expect(res.headers.get("ETag")).toBe(etag);
    expect(res.headers.get("Cache-Control")).toBe(ENTRY_CACHE_CONTROL);
    expect(await res.text()).toBe("");
  });

  test("If-None-Match compares weakly across encodings", async () => {
    const { app } = await fixture();
    const strong = (await app.request("/files/site/assets/app.js", { headers: { "Accept-Encoding": "gzip" } })).headers.get("ETag")!;
    const res = await app.request("/files/site/assets/app.js", {
      headers: { "Accept-Encoding": "identity", "If-None-Match": strong },
    });
    expect(res.status).toBe(304);
  });

  test("a stale If-None-Match gets the full response", async () => {
    const { app } = await fixture();
    const res = await app.request("/files/site/index.html", { headers: { "If-None-Match": '"0000"' } });
    expect(res.status).toBe(200);
    expect(await res.text()).toBe(INDEX_HTML);
  });

  test("range requests keep Accept-Ranges and the ETag", async () => {
    const { app } = await fixture();
    const res = await app.request("/files/site/index.html", { headers: { Range: "bytes=0-4" } });
    expect(res.status).toBe(206);
    expect(res.headers.get("Content-Range")).toBe(`bytes 0-4/${INDEX_HTML.length}`);
    expect(res.headers.get("Accept-Ranges")).toBe("bytes");
    expect(res.headers.get("ETag")).toBeTruthy();
    expect(await res.text()).toBe("<!doc");
  });
});
