import { describe, expect, test } from "vitest";
import { createConfig, lintFromString } from "@redocly/openapi-core";
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
    siteHosts: unused("siteHosts"),
    dns: unused("dns"),
    customHostnames: unused("customHostnames"),
    siteFallbackOrigin: undefined,
    cache: unused("cache"),
    signingSecret: undefined,
    credentialedOrigins: [],
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

// External clients generate code from /api/v1/doc (Re:Earth CMS uses
// oapi-codegen), so anything a handler reads or returns must be declared here.
describe("OpenAPI document", () => {
  type Operation = {
    parameters?: { name: string; in: string; required?: boolean }[];
    responses: Record<string, unknown>;
    security?: unknown[];
  };
  type Spec = {
    paths: Record<string, Record<string, Operation>>;
    components: { schemas: Record<string, unknown> };
  };

  async function loadSpec(): Promise<Spec> {
    const res = await createApp(fakeDeps()).request("/api/v1/doc");
    expect(res.status).toBe(200);
    return res.json();
  }

  test("passes Redocly's recommended OpenAPI 3.1 lint", async () => {
    // Covers what codegen trips over: unresolved $refs, undefined security
    // schemes, path templates without a matching path parameter, and schema
    // shapes that are not valid OpenAPI. Warnings (e.g. no info.license) are
    // allowed; errors fail the build.
    const problems = await lintFromString({
      source: JSON.stringify(await loadSpec()),
      absoluteRef: "openapi.json",
      config: await createConfig({ extends: ["recommended"] }),
    });
    const errors = problems
      .filter((p) => p.severity === "error")
      .map((p) => `${p.ruleId} at ${p.location[0]?.pointer}: ${p.message}`);
    expect(errors).toEqual([]);
  });

  test("keeps named components when the app is rebuilt (one createApp per request)", async () => {
    // Regression: hono-openapi resolves schemas in place on module-level
    // routes, so regenerating for a fresh app dropped components.schemas
    // while the $refs stayed.
    const first = await loadSpec();
    const second = await loadSpec();
    expect(Object.keys(second.components.schemas)).toEqual(Object.keys(first.components.schemas));
    expect(second.components.schemas).toHaveProperty("Asset");
  });

  test("names the shared schemas as components", async () => {
    const { components } = await loadSpec();
    for (const name of ["Asset", "AssetVersion", "FileEntry", "Error", "Job", "Project", "Workspace", "Member"]) {
      expect(components.schemas, name).toHaveProperty(name);
    }
  });

  test.each([
    ["/api/v1/assets", "post"],
    ["/api/v1/assets/uploads", "post"],
  ])("%s %s declares X-Project-Id and the errors it produces", async (path, method) => {
    const op = (await loadSpec()).paths[path][method];
    expect(op.parameters).toContainEqual(
      expect.objectContaining({ name: "X-Project-Id", in: "header", required: false }),
    );
    expect(op.responses).toHaveProperty("400");
    expect(op.responses).toHaveProperty("404");
  });

  test("documents public file delivery without auth", async () => {
    const op = (await loadSpec()).paths["/files/{id}/{path}"]?.get;
    expect(op).toBeDefined();
    expect(op.security).toEqual([]);
    expect(op.parameters?.map((p) => `${p.in}:${p.name}`)).toEqual(
      expect.arrayContaining(["path:id", "path:path", "query:thumb", "header:Range", "header:Accept-Encoding", "header:If-None-Match"]),
    );
    expect(Object.keys(op.responses).sort()).toEqual(["200", "206", "301", "304", "400", "401", "404", "429", "503"]);
  });
});
