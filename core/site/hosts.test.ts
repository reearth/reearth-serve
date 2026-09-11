/**
 * The named-sites API and its use cases (ADR-013 B2, B3, B6), exercised
 * through the real app: routing, zod validation, authorization, the store and
 * the resolver all take part, so a change that breaks the wiring fails here
 * rather than in e2e.
 */
import { describe, expect, test } from "vitest";
import { SignJWT } from "jose";
import type { JWTVerifyGetKey } from "jose";
// The API's view of a row (with `url`, without the internal columns), not the
// store's — these assertions are about what a caller receives.
import type { Role, SiteHost } from "../../shared/api";
import type { Project } from "../project/model";
import type { ProjectStore } from "../project/repository";
import type { Member } from "../member/model";
import type { MemberStore } from "../member/repository";
import { ASSET_ID, fixture, SINGLE_FILE_ID } from "../testing/fixture";
import { NAME_ERRORS } from "./names";
import { RELEASE_COOLDOWN_MS, SITE_HOST_ERRORS, SITE_HOST_QUOTA, purgeReleasedSiteHosts } from "./usecase";

const SUFFIX = ".serve.example.test";
const PROJECT_ID = "p1";
const WORKSPACE_ID = "ws1";
const USER = "u1";
const ISSUER = "https://issuer.example.test/";
const AUDIENCE = "test-audience";
const SECRET = new TextEncoder().encode("a-test-secret-that-is-long-enough-32");

class MemoryProjectStore implements ProjectStore {
  readonly projects = new Map<string, Project>();
  async save(project: Project): Promise<void> { this.projects.set(project.id, project); }
  async find(id: string): Promise<Project | null> { return this.projects.get(id) ?? null; }
  async list(): Promise<Project[]> { return [...this.projects.values()]; }
  async delete(id: string): Promise<void> { this.projects.delete(id); }
}

class MemoryMemberStore implements MemberStore {
  readonly members = new Map<string, Member>();
  async save(member: Member): Promise<void> { this.members.set(`${member.workspaceId}:${member.userId}`, member); }
  async find(workspaceId: string, userId: string): Promise<Member | null> {
    return this.members.get(`${workspaceId}:${userId}`) ?? null;
  }
  async list(): Promise<Member[]> { return [...this.members.values()]; }
  async listByUser(): Promise<Member[]> { return [...this.members.values()]; }
  async delete(): Promise<void> {}
}

async function token(sub = USER): Promise<string> {
  return new SignJWT({})
    .setProtectedHeader({ alg: "HS256" })
    .setIssuer(ISSUER).setAudience(AUDIENCE).setSubject(sub)
    .setExpirationTime("1h")
    .sign(SECRET);
}

/**
 * The shared fixture, upgraded into a project world: the archive asset belongs
 * to a project in a workspace the caller is a member of, with `role` deciding
 * what they may do.
 */
async function siteFixture(options: { role?: Role; suffix?: string | undefined } = {}) {
  const projects = new MemoryProjectStore();
  const members = new MemoryMemberStore();
  await projects.save({
    id: PROJECT_ID, name: "P", createdAt: 0, updatedAt: 0,
    ownerId: "someone-else", workspaceId: WORKSPACE_ID,
  });
  await members.save({
    workspaceId: WORKSPACE_ID, userId: USER,
    role: options.role ?? "editor", createdAt: 0, updatedAt: 0,
  });

  const f = await fixture({
    siteHostSuffix: "suffix" in options ? options.suffix : SUFFIX,
    projects,
    members,
    // Deleting a project asset moves the storage counters.
    storageUsage: {
      async get() { return null; },
      async increment() {},
      async decrement() {},
      async recalculate() {},
    },
    auth: {
      issuer: ISSUER,
      audience: AUDIENCE,
      // A local verifier instead of a JWKS fetch; the middleware's contract is
      // the same either way.
      jwks: (async () => SECRET) as unknown as JWTVerifyGetKey,
    },
  });

  // Both seeded assets become project assets; the single-file one stays
  // single-file, which is the "not an archive" case.
  for (const id of [ASSET_ID, SINGLE_FILE_ID]) {
    const asset = f.metadata.assets.get(id)!;
    f.metadata.assets.set(id, { ...asset, projectId: PROJECT_ID });
  }

  const auth = { Authorization: `Bearer ${await token()}` };
  return { ...f, projects, members, auth };
}

type App = Awaited<ReturnType<typeof siteFixture>>["app"];

function claim(app: App, auth: Record<string, string>, body: unknown, id = ASSET_ID) {
  return app.request(`/api/v1/assets/${id}/hosts`, {
    method: "POST",
    headers: { ...auth, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

/** A request to a named site host: only the Host header distinguishes it. */
function site(label: string, path = "/"): [string, RequestInit] {
  return [`http://${label}${SUFFIX}${path}`, { headers: { Host: `${label}${SUFFIX}` } }];
}

describe("POST /assets/:id/hosts", () => {
  test("an editor claims a name and gets the row and the site URL", async () => {
    const { app, auth, siteHosts } = await siteFixture();
    const res = await claim(app, auth, { hostname: "kawasaki-flood-map" });
    expect(res.status).toBe(201);
    const body = await res.json() as { host: SiteHost; siteUrl: string };
    expect(body.host).toMatchObject({
      hostname: `kawasaki-flood-map${SUFFIX}`,
      assetId: ASSET_ID,
      projectId: PROJECT_ID,
      kind: "subdomain",
      previews: false,
      releasedAt: null,
    });
    // The scheme follows BASE_URL (https://example.test in the fixture).
    expect(body.siteUrl).toBe(`https://kawasaki-flood-map${SUFFIX}/`);
    expect(body.host.url).toBe(body.siteUrl);
    // Internal-only columns stay out of the API.
    expect(body.host).not.toHaveProperty("createdBy");
    expect(body.host).not.toHaveProperty("verifiedAt");
    expect(siteHosts.hosts.get(`kawasaki-flood-map${SUFFIX}`)?.createdBy).toBe(USER);
  });

  test("the full host round-trips as well as the bare label", async () => {
    const { app, auth } = await siteFixture();
    const res = await claim(app, auth, { hostname: `KAWASAKI-FLOOD-MAP${SUFFIX}` });
    expect(res.status).toBe(201);
    expect((await res.json() as { host: SiteHost }).host.hostname).toBe(`kawasaki-flood-map${SUFFIX}`);
  });

  test("a viewer cannot claim; an editor can", async () => {
    const viewer = await siteFixture({ role: "viewer" });
    const denied = await claim(viewer.app, viewer.auth, { hostname: "kawasaki-flood-map" });
    // 404, not 403: the same answer the rest of the asset API gives, so it
    // does not confirm the asset to someone who may not act on it.
    expect(denied.status).toBe(404);
    expect(viewer.siteHosts.hosts.size).toBe(0);

    const editor = await siteFixture({ role: "editor" });
    expect((await claim(editor.app, editor.auth, { hostname: "kawasaki-flood-map" })).status).toBe(201);
  });

  test("an anonymous caller cannot claim a project asset's name", async () => {
    const { app } = await siteFixture();
    expect((await claim(app, {}, { hostname: "kawasaki-flood-map" })).status).toBe(404);
  });

  test("a demo (session-scoped) asset cannot hold a name", async () => {
    const f = await fixture({ siteHostSuffix: SUFFIX });
    // Session IDs are 16 hex characters; the session middleware rejects
    // anything else before a handler sees it.
    const sessionId = "00000000000000ab";
    const asset = f.metadata.assets.get(ASSET_ID)!;
    f.metadata.assets.set(ASSET_ID, { ...asset, sessionId });
    (f.deps.sessions as unknown as { sessions: Map<string, unknown> })
      .sessions.set(sessionId, { id: sessionId, createdAt: 0, expiresAt: Date.now() + 1e6 });

    const res = await f.app.request(`/api/v1/assets/${ASSET_ID}/hosts`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Session-Id": sessionId },
      body: JSON.stringify({ hostname: "kawasaki-flood-map" }),
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: SITE_HOST_ERRORS.projectRequired });
  });

  test("a single-file asset has no site, so it cannot be named", async () => {
    const { app, auth } = await siteFixture();
    const res = await claim(app, auth, { hostname: "some-geojson" }, SINGLE_FILE_ID);
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: SITE_HOST_ERRORS.archiveRequired });
  });

  test("custom domains are refused until B5", async () => {
    const { app, auth } = await siteFixture();
    const res = await claim(app, auth, { hostname: "map.city.example.jp", kind: "custom" });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: SITE_HOST_ERRORS.customUnsupported });
  });

  test("claiming is unavailable where the server has no site-host suffix", async () => {
    const { app, auth } = await siteFixture({ suffix: undefined });
    const res = await claim(app, auth, { hostname: "kawasaki-flood-map" });
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: SITE_HOST_ERRORS.notEnabled });
    // Reading still works — enabling the feature later must not lose rows.
    expect((await app.request(`/api/v1/assets/${ASSET_ID}/hosts`, { headers: auth })).status).toBe(200);
  });

  test("the validation errors reach the caller verbatim", async () => {
    const { app, auth } = await siteFixture();
    const errorFor = async (hostname: string) =>
      (await (await claim(app, auth, { hostname })).json() as { error: string }).error;

    expect(await errorFor("ab")).toBe(NAME_ERRORS.format);
    expect(await errorFor("v3--map")).toBe(NAME_ERRORS.format);
    expect(await errorFor("-map-")).toBe(NAME_ERRORS.format);
    expect(await errorFor("www")).toBe(NAME_ERRORS.reserved);
    expect(await errorFor("api-v2")).toBe(NAME_ERRORS.reserved);
    expect(await errorFor("latest")).toBe(NAME_ERRORS.reserved);
    expect(await errorFor(ASSET_ID)).toBe(NAME_ERRORS.reserved);
  });

  test("a name already claimed is taken", async () => {
    const { app, auth } = await siteFixture();
    expect((await claim(app, auth, { hostname: "kawasaki-flood-map" })).status).toBe(201);
    const again = await claim(app, auth, { hostname: "kawasaki-flood-map" });
    expect(again.status).toBe(400);
    expect(await again.json()).toEqual({ error: NAME_ERRORS.taken });
  });

  test("several names may point at one asset", async () => {
    const { app, auth } = await siteFixture();
    expect((await claim(app, auth, { hostname: "kawasaki-flood-map" })).status).toBe(201);
    expect((await claim(app, auth, { hostname: "kawasaki" })).status).toBe(201);
    const list = await (await app.request(`/api/v1/assets/${ASSET_ID}/hosts`, { headers: auth })).json();
    expect((list as { hosts: SiteHost[] }).hosts.map((h) => h.hostname)).toEqual([
      `kawasaki-flood-map${SUFFIX}`, `kawasaki${SUFFIX}`,
    ]);
  });

  test("the per-project quota bounds squatting", async () => {
    const { app, auth, siteHosts } = await siteFixture();
    for (let i = 0; i < SITE_HOST_QUOTA; i++) {
      expect((await claim(app, auth, { hostname: `site-number-${i}` })).status).toBe(201);
    }
    const over = await claim(app, auth, { hostname: "one-too-many" });
    expect(over.status).toBe(400);
    expect(await over.json()).toEqual({ error: SITE_HOST_ERRORS.quota });

    // Releasing one frees a slot even though the row is still held.
    await app.request(`/api/v1/assets/${ASSET_ID}/hosts/site-number-0${SUFFIX}`, {
      method: "DELETE", headers: auth,
    });
    expect((await claim(app, auth, { hostname: "one-too-many" })).status).toBe(201);
    expect(siteHosts.hosts.size).toBe(SITE_HOST_QUOTA + 1);
  });
});

describe("GET /assets/:id/hosts and GET /projects/:id/hosts", () => {
  test("a viewer may list the asset's names", async () => {
    const editor = await siteFixture();
    await claim(editor.app, editor.auth, { hostname: "kawasaki-flood-map" });

    const res = await editor.app.request(`/api/v1/assets/${ASSET_ID}/hosts`, { headers: editor.auth });
    expect(res.status).toBe(200);
    expect((await res.json() as { hosts: SiteHost[] }).hosts).toHaveLength(1);

    const viewer = await siteFixture({ role: "viewer" });
    expect((await viewer.app.request(`/api/v1/assets/${ASSET_ID}/hosts`, { headers: viewer.auth })).status).toBe(200);
  });

  test("the project listing spans the project's assets", async () => {
    const { app, auth } = await siteFixture();
    await claim(app, auth, { hostname: "kawasaki-flood-map" });

    const res = await app.request(`/api/v1/projects/${PROJECT_ID}/hosts`, { headers: auth });
    expect(res.status).toBe(200);
    expect((await res.json() as { hosts: SiteHost[] }).hosts.map((h) => h.hostname))
      .toEqual([`kawasaki-flood-map${SUFFIX}`]);
  });

  test("a non-member sees no project and no names", async () => {
    const { app } = await siteFixture();
    const stranger = { Authorization: `Bearer ${await token("intruder")}` };
    const res = await app.request(`/api/v1/projects/${PROJECT_ID}/hosts`, { headers: stranger });
    expect(res.status).toBe(404);
  });

  test("a released name is not listed", async () => {
    const { app, auth } = await siteFixture();
    await claim(app, auth, { hostname: "kawasaki-flood-map" });
    await app.request(`/api/v1/assets/${ASSET_ID}/hosts/kawasaki-flood-map${SUFFIX}`, {
      method: "DELETE", headers: auth,
    });
    const res = await app.request(`/api/v1/assets/${ASSET_ID}/hosts`, { headers: auth });
    expect((await res.json() as { hosts: SiteHost[] }).hosts).toEqual([]);
  });
});

describe("the site host itself", () => {
  test("a claimed name serves the asset, and the claim invalidates a cached miss", async () => {
    const { app, auth } = await siteFixture();

    // Someone tries the name before it exists: 404, and the miss is cached.
    expect((await app.request(...site("kawasaki-flood-map"))).status).toBe(404);

    await claim(app, auth, { hostname: "kawasaki-flood-map" });

    const res = await app.request(...site("kawasaki-flood-map"));
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("<title>site</title>");

    // Paths inside the site resolve the same way they do on the ID host.
    expect((await app.request(...site("kawasaki-flood-map", "/docs/"))).status).toBe(200);
  });

  test("releasing turns the host into a 410 page and starts the cooldown", async () => {
    const { app, auth } = await siteFixture();
    await claim(app, auth, { hostname: "kawasaki-flood-map" });
    expect((await app.request(...site("kawasaki-flood-map"))).status).toBe(200);

    const released = await app.request(
      `/api/v1/assets/${ASSET_ID}/hosts/kawasaki-flood-map${SUFFIX}`,
      { method: "DELETE", headers: auth },
    );
    expect(released.status).toBe(204);

    const gone = await app.request(...site("kawasaki-flood-map"));
    expect(gone.status).toBe(410);
    expect(gone.headers.get("Content-Type")).toContain("text/html");
    expect(gone.headers.get("Cache-Control")).toBe("no-store");
    expect(gone.headers.get("X-Robots-Tag")).toBe("noindex");
    expect(await gone.text()).toContain("This site has moved or been removed");

    // …and the name cannot be claimed again while the cooldown runs.
    const again = await claim(app, auth, { hostname: "kawasaki-flood-map" });
    expect(again.status).toBe(400);
    expect((await again.json() as { error: string }).error)
      .toMatch(/^name was recently released and is on cooldown until \d{4}-/);

    // The ID host is unaffected by any of this (B3).
    expect((await app.request(...site(ASSET_ID))).status).toBe(200);
  });

  test("releasing a name the asset does not hold is a 404", async () => {
    const { app, auth } = await siteFixture();
    const res = await app.request(`/api/v1/assets/${ASSET_ID}/hosts/never-claimed${SUFFIX}`, {
      method: "DELETE", headers: auth,
    });
    expect(res.status).toBe(404);
  });

  test("a viewer cannot release", async () => {
    const editor = await siteFixture();
    await claim(editor.app, editor.auth, { hostname: "kawasaki-flood-map" });

    const viewer = await siteFixture({ role: "viewer" });
    // Same store? No — a second fixture. Claim there as well, through its own
    // editor-less API by seeding the store directly.
    viewer.siteHosts.hosts.set(`kawasaki-flood-map${SUFFIX}`, {
      hostname: `kawasaki-flood-map${SUFFIX}`, assetId: ASSET_ID, projectId: PROJECT_ID,
      kind: "subdomain", verifiedAt: null, disabledAt: null, previews: false,
      releasedAt: null, createdAt: 0, createdBy: USER,
    });
    const res = await viewer.app.request(
      `/api/v1/assets/${ASSET_ID}/hosts/kawasaki-flood-map${SUFFIX}`,
      { method: "DELETE", headers: viewer.auth },
    );
    expect(res.status).toBe(404);
    expect(viewer.siteHosts.hosts.get(`kawasaki-flood-map${SUFFIX}`)?.releasedAt).toBeNull();
  });
});

describe("PATCH /assets/:id/hosts/:hostname", () => {
  function patch(app: App, auth: Record<string, string>, body: unknown, name = `kawasaki-flood-map${SUFFIX}`) {
    return app.request(`/api/v1/assets/${ASSET_ID}/hosts/${name}`, {
      method: "PATCH",
      headers: { ...auth, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  }

  test("disabling takes the site down with a 503 page; enabling brings it back", async () => {
    const { app, auth, siteHosts } = await siteFixture();
    await claim(app, auth, { hostname: "kawasaki-flood-map" });
    expect((await app.request(...site("kawasaki-flood-map"))).status).toBe(200);

    const disabled = await patch(app, auth, { disabled: true });
    expect(disabled.status).toBe(200);
    const body = await disabled.json() as { host: SiteHost };
    expect(body.host.disabledAt).toEqual(expect.any(Number));
    expect(siteHosts.hosts.get(`kawasaki-flood-map${SUFFIX}`)?.disabledAt).toEqual(expect.any(Number));

    // The host says "held, not serving" — and the PATCH dropped the cached
    // resolution, so it says it on the very next request.
    const down = await app.request(...site("kawasaki-flood-map"));
    expect(down.status).toBe(503);
    expect(down.headers.get("Content-Type")).toContain("text/html");
    expect(down.headers.get("Cache-Control")).toBe("no-store");
    expect(down.headers.get("X-Robots-Tag")).toBe("noindex");
    expect(down.headers.get("Retry-After")).toBe("3600");
    expect(await down.text()).toContain("This site is temporarily unavailable");

    // The name is still held: nobody else may claim it while it is down.
    const taken = await claim(app, auth, { hostname: "kawasaki-flood-map" });
    expect(taken.status).toBe(400);
    expect(await taken.json()).toEqual({ error: NAME_ERRORS.taken });

    // The ID host and /files/ are capability URLs, unaffected by publish state.
    expect((await app.request(...site(ASSET_ID))).status).toBe(200);
    expect((await app.request(`/files/${ASSET_ID}/`)).status).toBe(200);

    const enabled = await patch(app, auth, { disabled: false });
    expect(enabled.status).toBe(200);
    expect((await enabled.json() as { host: SiteHost }).host.disabledAt).toBeNull();
    expect((await app.request(...site("kawasaki-flood-map"))).status).toBe(200);
  });

  test("the previews flag is stored and reported", async () => {
    const { app, auth, siteHosts } = await siteFixture();
    await claim(app, auth, { hostname: "kawasaki-flood-map" });

    const res = await patch(app, auth, { previews: true });
    expect(res.status).toBe(200);
    expect((await res.json() as { host: SiteHost }).host.previews).toBe(true);
    expect(siteHosts.hosts.get(`kawasaki-flood-map${SUFFIX}`)?.previews).toBe(true);

    // Both switches in one request, each independent of the other.
    const both = await patch(app, auth, { disabled: true, previews: false });
    expect((await both.json() as { host: SiteHost }).host).toMatchObject({
      previews: false, disabledAt: expect.any(Number),
    });
  });

  test("an empty body is refused rather than silently doing nothing", async () => {
    const { app, auth } = await siteFixture();
    await claim(app, auth, { hostname: "kawasaki-flood-map" });
    expect((await patch(app, auth, {})).status).toBe(400);
  });

  test("a released name cannot be updated: 409, not a revival", async () => {
    const { app, auth, siteHosts } = await siteFixture();
    await claim(app, auth, { hostname: "kawasaki-flood-map" });
    await app.request(`/api/v1/assets/${ASSET_ID}/hosts/kawasaki-flood-map${SUFFIX}`, {
      method: "DELETE", headers: auth,
    });

    const res = await patch(app, auth, { disabled: false });
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: SITE_HOST_ERRORS.released });
    // Still released: the 410 page, not the site.
    expect(siteHosts.hosts.get(`kawasaki-flood-map${SUFFIX}`)?.releasedAt).toEqual(expect.any(Number));
    expect((await app.request(...site("kawasaki-flood-map"))).status).toBe(410);
  });

  test("a name the asset does not hold is a 404", async () => {
    const { app, auth } = await siteFixture();
    expect((await patch(app, auth, { disabled: true }, `never-claimed${SUFFIX}`)).status).toBe(404);
  });

  test("a viewer cannot disable a site", async () => {
    const editor = await siteFixture();
    await claim(editor.app, editor.auth, { hostname: "kawasaki-flood-map" });

    const viewer = await siteFixture({ role: "viewer" });
    viewer.siteHosts.hosts.set(`kawasaki-flood-map${SUFFIX}`, {
      hostname: `kawasaki-flood-map${SUFFIX}`, assetId: ASSET_ID, projectId: PROJECT_ID,
      kind: "subdomain", verifiedAt: null, disabledAt: null, previews: false,
      releasedAt: null, createdAt: 0, createdBy: USER,
    });
    const res = await patch(viewer.app, viewer.auth, { disabled: true });
    expect(res.status).toBe(404);
    expect(viewer.siteHosts.hosts.get(`kawasaki-flood-map${SUFFIX}`)?.disabledAt).toBeNull();
  });

  test("an anonymous caller cannot disable a site", async () => {
    const { app, auth } = await siteFixture();
    await claim(app, auth, { hostname: "kawasaki-flood-map" });
    expect((await patch(app, {}, { disabled: true })).status).toBe(404);
  });
});

describe("asset deletion and the cleanup cron", () => {
  test("deleting an asset releases its names rather than cascading them away", async () => {
    const { app, auth, siteHosts, metadata } = await siteFixture();
    await claim(app, auth, { hostname: "kawasaki-flood-map" });
    await claim(app, auth, { hostname: "kawasaki" });

    const deleted = await app.request(`/api/v1/assets/${ASSET_ID}`, { method: "DELETE", headers: auth });
    expect(deleted.status).toBe(204);
    expect(metadata.assets.has(ASSET_ID)).toBe(false);

    // The rows are still there, released: the name stays held for 30 days.
    expect(siteHosts.hosts.size).toBe(2);
    for (const host of siteHosts.hosts.values()) {
      expect(host.releasedAt).not.toBeNull();
      expect(host.assetId).toBeNull();
    }

    // The host says "gone", not "not found", and the name cannot be taken.
    const gone = await app.request(...site("kawasaki-flood-map"));
    expect(gone.status).toBe(410);
  });

  test("the cron purges a released row once its cooldown ends, and not before", async () => {
    const { app, auth, siteHosts, cache } = await siteFixture();
    await claim(app, auth, { hostname: "kawasaki-flood-map" });
    await app.request(`/api/v1/assets/${ASSET_ID}/hosts/kawasaki-flood-map${SUFFIX}`, {
      method: "DELETE", headers: auth,
    });
    const releasedAt = siteHosts.hosts.get(`kawasaki-flood-map${SUFFIX}`)!.releasedAt!;
    const deps = { hosts: siteHosts, cache, suffix: SUFFIX };

    // One day short of the cooldown: still held.
    expect(await purgeReleasedSiteHosts(deps, { now: releasedAt + RELEASE_COOLDOWN_MS - 1 })).toEqual([]);
    expect(siteHosts.hosts.size).toBe(1);

    // A moment past it: purged, and the name is free.
    expect(await purgeReleasedSiteHosts(deps, { now: releasedAt + RELEASE_COOLDOWN_MS + 1 }))
      .toEqual([`kawasaki-flood-map${SUFFIX}`]);
    expect(siteHosts.hosts.size).toBe(0);
    expect((await app.request(...site("kawasaki-flood-map"))).status).toBe(404);
  });

  test("a claim after the cooldown has run out succeeds even before the cron sweeps", async () => {
    const { app, auth, siteHosts } = await siteFixture();
    await claim(app, auth, { hostname: "kawasaki-flood-map" });
    // Back-date the release past the cooldown.
    const hostname = `kawasaki-flood-map${SUFFIX}`;
    const row = siteHosts.hosts.get(hostname)!;
    siteHosts.hosts.set(hostname, {
      ...row, releasedAt: Date.now() - RELEASE_COOLDOWN_MS - 1, assetId: null,
    });

    const res = await claim(app, auth, { hostname: "kawasaki-flood-map" });
    expect(res.status).toBe(201);
    expect(siteHosts.hosts.get(hostname)?.releasedAt).toBeNull();
    expect((await app.request(...site("kawasaki-flood-map"))).status).toBe(200);
  });
});
