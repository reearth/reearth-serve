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
import type { AssetProtection, ListResult, MetadataStore, VersionStore } from "../asset/repository";
import { hashPassword } from "../access/password";
import type { Session, SessionStore } from "../session/repository";
import type { SiteHost, SiteHostPatch, SiteHostStore } from "../site/repository";
import { MemoryFileStorage } from "../../adapters/memory/storage";
import { MemoryKeyValue } from "../../adapters/memory/memory-kv";
import { MemoryDnsResolver } from "../../adapters/memory/dns";
import { MemoryCustomHostnames } from "../../adapters/memory/custom-hostnames";
import { SimpleAuthorizer } from "../../adapters/cloudflare/authorizer";

/** Archive asset, active version {@link VERSION_ID}. */
export const ASSET_ID = "3f9a1c2b4d5e6f70";
export const VERSION_ID = "0123456789abcdef";
/** Single-file asset from before ADR-005: no version row, legacy layout. */
export const SINGLE_FILE_ID = "fedcba9876543210";

export const INDEX_HTML = "<!doctype html><title>site</title>";
export const DOCS_HTML = "<!doctype html><title>docs</title>";
export const APP_JS = "console.log('hello from a bundle that is long enough to matter')";
/** The archive's own error page, seeded on demand by {@link seedNotFoundPage}. */
export const NOT_FOUND_HTML = "<!doctype html><title>not found</title><p>gone";

export class MemoryMetadataStore implements MetadataStore {
  readonly assets = new Map<string, AssetMetadata>();
  /**
   * Password material, held apart from the asset rows exactly as the SQL store
   * holds it apart from `AssetMetadata` (ADR-013 B7) — so a test that asserts
   * "no hash in the JSON" is testing the real arrangement, not a fake that
   * could never have leaked one.
   */
  readonly protection = new Map<string, AssetProtection>();
  /** How many times `find` was called: the "public costs nothing" assertion. */
  findCalls = 0;
  /** How many times `findProtection` was called. */
  protectionCalls = 0;

  async save(asset: AssetMetadata): Promise<void> {
    this.assets.set(asset.id, asset);
  }
  async find(id: string): Promise<AssetMetadata | null> {
    this.findCalls++;
    return this.assets.get(id) ?? null;
  }
  async findProtection(id: string): Promise<AssetProtection | null> {
    this.protectionCalls++;
    const found = this.protection.get(id);
    return found && found.hash ? found : null;
  }
  async setProtection(
    id: string,
    value: { access: "public" } | { access: "password"; hash: string; salt: string },
  ): Promise<void> {
    const asset = this.assets.get(id);
    if (!asset) return;
    this.assets.set(id, { ...asset, access: value.access });
    const version = this.protection.get(id)?.version ?? 0;
    if (value.access === "public") {
      // The counter outlives the hash, as it does in SQL.
      this.protection.set(id, { hash: "", salt: "", version });
      return;
    }
    this.protection.set(id, { hash: value.hash, salt: value.salt, version: version + 1 });
  }
  /**
   * The patch the SQL store applies, applied here too.
   *
   * It used to be a no-op, which was enough while nothing in the delivery path
   * read a mutable field. ADR-013 C1's `spa` is read by the file handler on
   * every miss, so a test that PATCHes it has to see it afterwards.
   */
  async update(
    id: string,
    patch: {
      activeVersionId?: string | null;
      expiresAt?: number;
      description?: string;
      userMeta?: Record<string, unknown>;
      spa?: boolean;
    },
  ): Promise<void> {
    const asset = this.assets.get(id);
    if (!asset) return;
    const next = { ...asset };
    if (patch.activeVersionId !== undefined) next.activeVersionId = patch.activeVersionId ?? undefined;
    if (patch.expiresAt !== undefined) next.expiresAt = patch.expiresAt;
    if (patch.description !== undefined) next.description = patch.description;
    if (patch.userMeta !== undefined) next.userMeta = patch.userMeta;
    if (patch.spa !== undefined) next.spa = patch.spa;
    this.assets.set(id, next);
  }
  async delete(id: string): Promise<void> {
    this.assets.delete(id);
    this.protection.delete(id);
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
  async findByAssetAndNumber(assetId: string, version: number): Promise<AssetVersion | null> {
    const all = (await this.findByAssetId(assetId)).items;
    return all.find((v) => v.version === version) ?? null;
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

/** In-memory `site_hosts` (ADR-013 B2), with the SQL store's semantics. */
export class MemorySiteHostStore implements SiteHostStore {
  readonly hosts = new Map<string, SiteHost>();

  async find(hostname: string): Promise<SiteHost | null> {
    return this.hosts.get(hostname) ?? null;
  }
  async listByAsset(assetId: string): Promise<SiteHost[]> {
    return this.active().filter((h) => h.assetId === assetId);
  }
  async listByProject(projectId: string): Promise<SiteHost[]> {
    return this.active().filter((h) => h.projectId === projectId);
  }
  async insert(host: SiteHost): Promise<boolean> {
    // The primary key wins, released rows included — same as INSERT OR IGNORE.
    if (this.hosts.has(host.hostname)) return false;
    this.hosts.set(host.hostname, { ...host });
    return true;
  }
  async update(hostname: string, patch: SiteHostPatch): Promise<void> {
    const host = this.hosts.get(hostname);
    if (!host || host.releasedAt !== null) return;
    this.hosts.set(hostname, {
      ...host,
      ...(patch.disabledAt !== undefined && { disabledAt: patch.disabledAt }),
      ...(patch.previews !== undefined && { previews: patch.previews }),
      ...(patch.verifiedAt !== undefined && { verifiedAt: patch.verifiedAt }),
      ...(patch.certificateStatus !== undefined && { certificateStatus: patch.certificateStatus }),
    });
  }
  async remove(hostname: string): Promise<void> {
    this.hosts.delete(hostname);
  }
  async release(hostname: string, releasedAt: number): Promise<void> {
    const host = this.hosts.get(hostname);
    if (!host || host.releasedAt !== null) return;
    this.hosts.set(hostname, { ...host, releasedAt, assetId: null });
  }
  async releaseByAsset(assetId: string, releasedAt: number): Promise<string[]> {
    const released: string[] = [];
    for (const host of this.active()) {
      if (host.assetId !== assetId) continue;
      this.hosts.set(host.hostname, { ...host, releasedAt, assetId: null });
      released.push(host.hostname);
    }
    return released;
  }
  async countActiveByProject(projectId: string): Promise<number> {
    return (await this.listByProject(projectId)).length;
  }
  async purgeReleasedBefore(before: number, limit: number): Promise<string[]> {
    const due = [...this.hosts.values()]
      .filter((h) => h.releasedAt !== null && h.releasedAt < before)
      .sort((a, b) => (a.releasedAt ?? 0) - (b.releasedAt ?? 0))
      .slice(0, limit);
    for (const host of due) this.hosts.delete(host.hostname);
    return due.map((h) => h.hostname);
  }

  private active(): SiteHost[] {
    return [...this.hosts.values()]
      .filter((h) => h.releasedAt === null)
      .sort((a, b) => a.createdAt - b.createdAt);
  }
}

/** The `SIGNING_SECRET` the fixture's app is built with (ADR-013 B7). */
export const SIGNING_SECRET = "test-signing-secret-at-least-32-bytes-long";

/**
 * PBKDF2 iterations for tests.
 *
 * Production is 600 000, which is a few hundred milliseconds per check — fine
 * once per login, ruinous across a suite that does it dozens of times. The
 * count travels inside the stored hash, so a test hash verifies through exactly
 * the same code path as a production one.
 */
export const TEST_ITERATIONS = 1000;

/** Protect a seeded asset with `password`, the way the PATCH endpoint would. */
export async function protect(
  metadata: MemoryMetadataStore,
  id: string,
  password: string,
): Promise<void> {
  const { hash, salt } = await hashPassword(password, { iterations: TEST_ITERATIONS });
  await metadata.setProtection(id, { access: "password", hash, salt });
}

/**
 * Put `404.html` at the root of the seeded archive's active version (ADR-013 C1).
 *
 * Not seeded by default: "no error page" is the state most of the delivery
 * suite asserts against, and a test that wants one says so.
 */
export async function seedNotFoundPage(
  storage: MemoryFileStorage,
  body = NOT_FOUND_HTML,
): Promise<void> {
  await storage.put(
    `assets/${ASSET_ID}/v/${VERSION_ID}/files/404.html`,
    stream(bytes(body)),
    "text/html; charset=utf-8",
    body.length,
  );
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
  const siteHosts = new MemorySiteHostStore();
  const cache = new MemoryKeyValue();
  // Custom domains (ADR-013 B5): a resolver with no records — a test publishes
  // the one it wants found — and a provisioner that issues instantly.
  const dns = new MemoryDnsResolver();
  const customHostnames = new MemoryCustomHostnames();

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
    siteHosts,
    dns,
    customHostnames,
    siteFallbackOrigin: undefined,
    cache,
    signingSecret: SIGNING_SECRET,
    sessions: new MemorySessionStore(),
    sessionTtlSeconds: 60,
    internalApiSecret: undefined,
    auth: {},
    containers: unused("containers"),
    extractionStuckThresholdMs: 1000,
    limits: { subrequestBudget: 700 },
    ...overrides,
  };
  return {
    app: createApp(deps), deps, metadata, versions, storage, siteHosts, cache, geojson,
    // The overridden instances when a test supplied its own, so a test can
    // always assert against the ones the app actually uses.
    dns: (deps.dns as MemoryDnsResolver),
    customHostnames: (deps.customHostnames as MemoryCustomHostnames),
  };
}
