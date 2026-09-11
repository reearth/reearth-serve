import { describe, expect, test } from "vitest";
import { createApp } from "./app";
import type { Deps } from "./types";
import type { AssetMetadata } from "./asset/model";
import type { MetadataStore } from "./asset/repository";
import type { Session, SessionStore } from "./session/repository";
import { SimpleAuthorizer } from "../adapters/cloudflare/authorizer";

// The point of this file: createApp must be constructible from hand-built
// dependencies, with no Cloudflare bindings and no `Env` anywhere (ADR-012 §1).
// If a Cloudflare type leaks back into the app layer, this file stops compiling.

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

class MemorySessionStore implements SessionStore {
  readonly sessions = new Map<string, Session>();

  async save(session: Session): Promise<void> {
    this.sessions.set(session.id, session);
  }
  async find(id: string): Promise<Session | null> {
    return this.sessions.get(id) ?? null;
  }
}

/** Anything the tests below don't exercise: present, typed, and never called. */
function unused<T>(name: string): T {
  return new Proxy({} as object, {
    get() {
      throw new Error(`fake dependency "${name}" was called unexpectedly`);
    },
  }) as T;
}

function fakeDeps(overrides: Partial<Deps> = {}): Deps {
  return {
    metadata: new MemoryMetadataStore(),
    versions: unused("versions"),
    writes: unused("writes"),
    storage: unused("storage"),
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
}

describe("createApp with hand-built deps", () => {
  test("serves health from the injected flag, with no bindings in sight", async () => {
    const app = createApp(fakeDeps({ anonymousUploadEnabled: true }));

    const res = await app.request("/api/v1/health");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, anonymousUploadEnabled: true });
  });

  test("mints an anonymous session in the injected session store", async () => {
    const sessions = new MemorySessionStore();
    const app = createApp(fakeDeps({ sessions }));

    const res = await app.request("/api/v1/health");
    const sessionId = res.headers.get("X-Session-Id");
    expect(sessionId).toMatch(/^[0-9a-f]{16}$/);
    expect(sessions.sessions.has(sessionId!)).toBe(true);
  });

  test("internal routes fail closed when no secret is injected", async () => {
    const app = createApp(fakeDeps());

    const res = await app.request("/api/internal/assets/a1/exists", {
      headers: { Authorization: "Bearer anything" },
    });
    expect(res.status).toBe(503);
  });

  test("internal routes read the injected metadata store once authorized", async () => {
    const metadata = new MemoryMetadataStore();
    metadata.assets.set("a1", {
      id: "a1",
      filename: "a.bin",
      contentType: "application/octet-stream",
      size: 1,
      createdAt: 0,
      expiresAt: 0,
    });
    const app = createApp(fakeDeps({ metadata, internalApiSecret: "s3cret" }));

    const authorized = { headers: { Authorization: "Bearer s3cret" } };
    expect((await app.request("/api/internal/assets/a1/exists", authorized)).status).toBe(200);
    expect((await app.request("/api/internal/assets/missing/exists", authorized)).status).toBe(404);
    expect((await app.request("/api/internal/assets/a1/exists")).status).toBe(401);
  });

  test("internal routes take the shared secret even when OIDC is configured", async () => {
    // Regression: the OIDC middleware used to run on /api/internal/* too, so
    // the container's `Authorization: Bearer <INTERNAL_API_SECRET>` was
    // verified as a JWT and rejected 401 on any server with an issuer set.
    const metadata = new MemoryMetadataStore();
    metadata.assets.set("a1", {
      id: "a1",
      filename: "a.bin",
      contentType: "application/octet-stream",
      size: 1,
      createdAt: 0,
      expiresAt: 0,
    });
    const sessions = new MemorySessionStore();
    const app = createApp(
      fakeDeps({
        metadata,
        sessions,
        internalApiSecret: "s3cret",
        auth: {
          issuer: "https://idp.example.test/",
          jwks: () => {
            throw new Error("JWKS must not be consulted for internal calls");
          },
        },
      }),
    );

    const res = await app.request("/api/internal/assets/a1/exists", {
      headers: { Authorization: "Bearer s3cret" },
    });
    expect(res.status).toBe(200);
    // A machine caller must not burn a demo session either.
    expect(sessions.sessions.size).toBe(0);
  });
});
