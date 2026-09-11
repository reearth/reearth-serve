/**
 * A whole app built from in-memory fakes, for tests that exercise delivery
 * behaviour end to end (file handler, site hosts).
 *
 * Not a production module and not exported from one: it lives here so the file
 * and site suites share one seeded asset set instead of keeping two copies in
 * step. IDs are ID-shaped (16 lowercase hex) because site hosts only resolve
 * labels of that shape (ADR-013 B1).
 */

import { gzipSync } from "node:zlib";
import { createApp } from "../app";
import type { Deps } from "../types";
import type { AssetMetadata, AssetVersion } from "../asset/model";
import type { ListResult, MetadataStore, VersionStore } from "../asset/repository";
import type { Session, SessionStore } from "../session/repository";
import { MemoryFileStorage } from "../../adapters/memory/storage";
import { SimpleAuthorizer } from "../../adapters/cloudflare/authorizer";

/** Archive asset, active version {@link VERSION_ID}. */
export const ASSET_ID = "3f9a1c2b4d5e6f70";
export const VERSION_ID = "0123456789abcdef";
/** Single-file asset from before ADR-005: no version row, legacy layout. */
export const SINGLE_FILE_ID = "fedcba9876543210";

export const INDEX_HTML = "<!doctype html><title>site</title>";
export const DOCS_HTML = "<!doctype html><title>docs</title>";
export const APP_JS = "console.log('hello from a bundle that is long enough to matter')";

export class MemoryMetadataStore implements MetadataStore {
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

export class MemoryVersionStore implements VersionStore {
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

export class MemorySessionStore implements SessionStore {
  readonly sessions = new Map<string, Session>();
  async save(session: Session): Promise<void> {
    this.sessions.set(session.id, session);
  }
  async find(id: string): Promise<Session | null> {
    return this.sessions.get(id) ?? null;
  }
}

/** A dependency the test does not expect to be touched; calling it fails loudly. */
export function unused<T>(name: string): T {
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

export async function fixture(overrides?: Partial<Deps>) {
  const metadata = new MemoryMetadataStore();
  const versions = new MemoryVersionStore();
  const storage = new MemoryFileStorage();

  // Archive asset with an active version, extracted into the versioned layout.
  // app.js is stored gzip the way the extractor transmuxes deflate entries.
  metadata.assets.set(ASSET_ID, {
    id: ASSET_ID,
    filename: "site.zip",
    contentType: "application/zip",
    size: 3,
    createdAt: 0,
    expiresAt: 0,
    type: "archive",
    status: "ready",
  });
  versions.versions.set(VERSION_ID, {
    id: VERSION_ID,
    assetId: ASSET_ID,
    version: 1,
    filename: "site.zip",
    contentType: "application/zip",
    size: 3,
    createdAt: 0,
    type: "archive",
    status: "ready",
  });
  const prefix = `assets/${ASSET_ID}/v/${VERSION_ID}`;
  await storage.put(`${prefix}/site.zip`, stream(bytes("PK\x03")), "application/zip", 3);
  await storage.put(`${prefix}/files/index.html`, stream(bytes(INDEX_HTML)), "text/html; charset=utf-8", INDEX_HTML.length);
  await storage.put(`${prefix}/files/docs/index.html`, stream(bytes(DOCS_HTML)), "text/html; charset=utf-8", DOCS_HTML.length);
  const gz = new Uint8Array(gzipSync(APP_JS));
  await storage.put(`${prefix}/files/assets/app.js`, stream(gz), "text/javascript", gz.byteLength, { contentEncoding: "gzip" });

  // Legacy single-file asset with no version row.
  const geojson = '{"type":"FeatureCollection","features":[]}';
  metadata.assets.set(SINGLE_FILE_ID, {
    id: SINGLE_FILE_ID,
    filename: "data.geojson",
    contentType: "application/geo+json",
    size: geojson.length,
    createdAt: 0,
    expiresAt: 0,
  });
  await storage.put(`assets/${SINGLE_FILE_ID}/data.geojson`, stream(bytes(geojson)), "application/geo+json", geojson.length);

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
    siteHostSuffix: undefined,
    sessions: new MemorySessionStore(),
    sessionTtlSeconds: 60,
    internalApiSecret: undefined,
    auth: {},
    containers: unused("containers"),
    extractionStuckThresholdMs: 1000,
    limits: { subrequestBudget: 700 },
    ...overrides,
  };
  return { app: createApp(deps), deps, metadata, versions, storage, geojson };
}
