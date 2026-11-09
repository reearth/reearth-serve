import { describe, expect, test, vi } from "vitest";
import { createApp } from "./app";
import type { Deps } from "./types";
import type { AssetMetadata } from "./asset/model";
import type { MetadataStore, VersionStore } from "./asset/repository";
import type { Session, SessionStore } from "./session/repository";
import { MemoryFileStorage } from "../adapters/memory/storage";
import type { Project } from "./project/model";
import type { ProjectStore } from "./project/repository";
import { TenancyUnavailableError, type Tenancy, type TenantScope } from "./tenancy/port";

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
  // Access mode (ADR-013 B7): nothing here is protected.
  async findProtection(): Promise<null> {
    return null;
  }
  async setProtection(): Promise<void> {}
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

function strictFake<T>(name: string, implemented: Partial<T> = {}): T {
  return new Proxy(implemented as object, {
    get(target, prop) {
      if (prop in target) return Reflect.get(target, prop);
      throw new Error(`fake dependency "${name}.${String(prop)}" was called unexpectedly`);
    },
  }) as T;
}

const anonymousTenancy: Tenancy = {
  async enter() {
    return { user: null, scope: strictFake<TenantScope>("tenancy scope") };
  },
};

function signedInTenancy(check: () => Promise<boolean>): Tenancy {
  const member = { workspaceId: "ws1", userId: "u1", role: "editor" as const, createdAt: 0, updatedAt: 0 };
  return {
    async enter() {
      return {
        user: { id: "u1", sub: "u1" },
        scope: {
          workspaces: strictFake("workspaces"),
          members: { find: async () => member, list: async () => [member], listForCaller: async () => [member] },
          authorizer: { check },
          admin: null,
        },
      };
    },
  };
}

function projectsWith(project: Project): ProjectStore {
  return { save: async () => {}, list: async () => [project], delete: async () => {}, find: async () => project };
}

function fakeDeps(overrides: Partial<Deps> = {}): Deps {
  return {
    metadata: new MemoryMetadataStore(),
    versions: strictFake("versions"),
    writes: strictFake("writes"),
    storage: strictFake("storage"),
    uploadSessions: strictFake("uploadSessions"),
    presignedUrls: null,
    jobs: strictFake("jobs"),
    ttlSeconds: 3600,
    baseUrl: "https://example.test",
    projects: strictFake("projects"),
    extractionQueue: null,
    thumbnailQueue: null,
    verificationQueue: null,
    storageUsage: strictFake("storageUsage"),
    pendingCleanup: strictFake("pendingCleanup"),
    blobRefs: strictFake("blobRefs"),
    anonymousUploadEnabled: false,
    siteHostSuffix: undefined,
    siteHosts: strictFake("siteHosts"),
    dns: strictFake("dns"),
    customHostnames: strictFake("customHostnames"),
    siteFallbackOrigin: undefined,
    cache: strictFake("cache"),
    signingSecret: undefined,
    credentialedOrigins: [],
    sessions: new MemorySessionStore(),
    sessionTtlSeconds: 60,
    internalApiSecret: undefined,
    auth: {},
    tenancy: anonymousTenancy,
    containers: strictFake("containers"),
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

  test("anonymous file reads neither mint nor validate a session", async () => {
    const metadata = new MemoryMetadataStore();
    metadata.assets.set("a1", {
      id: "a1",
      filename: "a.txt",
      contentType: "text/plain",
      size: 5,
      createdAt: 0,
      expiresAt: 0,
    });
    const storage = new MemoryFileStorage();
    await storage.put("assets/a1/a.txt", new Blob(["hello"]).stream(), "text/plain", 5);
    const sessions = new MemorySessionStore();
    const app = createApp(
      fakeDeps({
        metadata,
        storage,
        sessions,
        versions: strictFake<VersionStore>("versions", { find: async () => null, findLatest: async () => null }),
      }),
    );

    const requests: Record<string, string>[] = [{}, { "X-Session-Id": "not-a-session" }];
    for (const headers of requests) {
      const res = await app.request("/files/a1/a.txt", { headers });
      expect(res.status).toBe(200);
      expect(await res.text()).toBe("hello");
      expect(res.headers.get("X-Session-Id")).toBeNull();
    }
    expect(sessions.sessions.size).toBe(0);
  });

  test("anonymous API calls still get a session", async () => {
    const sessions = new MemorySessionStore();
    const app = createApp(fakeDeps({ sessions }));

    const res = await app.request("/api/v1/assets", { method: "POST" });
    const sessionId = res.headers.get("X-Session-Id");
    expect(sessionId).toMatch(/^[0-9a-f]{16}$/);
    expect(sessions.sessions.has(sessionId!)).toBe(true);
  });

  test("a validator 400 keeps the minted session header", async () => {
    const sessions = new MemorySessionStore();
    const app = createApp(fakeDeps({ sessions }));

    const res = await app.request("/api/v1/projects", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{not json",
    });
    expect(res.status).toBe(400);
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

describe("directory and decision failures", () => {
  const project: Project = { id: "p1", name: "P", createdAt: 0, updatedAt: 0, ownerId: "u1", workspaceId: "ws1" };

  test("a decision service outage answers 503 with Retry-After from a routed handler", async () => {
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    const app = createApp(fakeDeps({
      projects: projectsWith(project),
      tenancy: signedInTenancy(async () => { throw new TenancyUnavailableError("down"); }),
    }));
    const res = await app.request("/api/v1/projects/p1");
    logged.mockRestore();
    expect(res.status).toBe(503);
    expect(res.headers.get("Retry-After")).toBe("5");
    expect(await res.json()).toEqual({ error: "Authorization service unavailable" });
  });

  test("any other error keeps the plain 500", async () => {
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    const app = createApp(fakeDeps({
      projects: projectsWith(project),
      tenancy: signedInTenancy(async () => { throw new Error("bug"); }),
    }));
    const res = await app.request("/api/v1/projects/p1");
    logged.mockRestore();
    expect(res.status).toBe(500);
    expect(await res.text()).toBe("Internal Server Error");
  });

  test("workspace writes answer 405 when an external directory owns membership", async () => {
    const app = createApp(fakeDeps({ tenancy: signedInTenancy(async () => true) }));
    const res = await app.request("/api/v1/workspaces", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "W" }),
    });
    expect(res.status).toBe(405);
    expect(await res.json()).toEqual({ error: "Workspaces and members are managed by an external directory" });
  });
});

