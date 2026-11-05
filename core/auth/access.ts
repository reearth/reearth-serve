import type { Context } from "hono";
import type { AppEnv } from "../types";
import type { AuthUser } from "./types";
import type { Authorizer, AuthzRequest } from "./authorizer";
import type { AssetMetadata } from "../asset/model";
import type { Job } from "../job/model";
import type { Member } from "../member/model";
import type { MemberStore } from "../member/repository";
import type { Project } from "../project/model";
import type { ProjectStore } from "../project/repository";
import { withinPolicy, type ProjectAction, type WorkspaceAction } from "./permissions";

export type AccessContext = {
  user: AuthUser | null;
  sessionId: string | null;
  authorizer: Authorizer;
  members: MemberStore;
  projects: ProjectStore;
};

export type Denial = { ok: false; reason: "not_found" | "forbidden" };
export type Decision<T> = { ok: true; value: T } | Denial;

type AssetAction = Extract<ProjectAction, `${string}_asset`>;
type JobAction = Extract<ProjectAction, `${string}_job`>;

const notFound: Denial = { ok: false, reason: "not_found" };
const forbidden: Denial = { ok: false, reason: "forbidden" };

export function accessCtx(c: Context<AppEnv>): AccessContext {
  return {
    user: c.get("user"),
    sessionId: c.get("sessionId"),
    authorizer: c.get("authorizer"),
    members: c.get("members"),
    projects: c.get("projects"),
  };
}

async function permitted(ctx: AccessContext, req: AuthzRequest): Promise<boolean> {
  return withinPolicy(req) && await ctx.authorizer.check(req);
}

export async function authorizeWorkspace(
  ctx: AccessContext,
  workspaceId: string,
  action: WorkspaceAction,
): Promise<Decision<Member>> {
  if (!ctx.user) return notFound;
  const member = await ctx.members.find(workspaceId, ctx.user.sub);
  if (!member) return notFound;
  const principal = { id: ctx.user.sub, role: member.role };
  const ok = await permitted(ctx, { principal, workspaceId, resource: { kind: "workspace" }, action });
  return ok ? { ok: true, value: member } : forbidden;
}

export async function authorizeProject(
  ctx: AccessContext,
  projectId: string,
  action: ProjectAction,
): Promise<Decision<Project>> {
  const user = ctx.user;
  if (!user) return notFound;
  const project = await ctx.projects.find(projectId);
  if (!project) return notFound;
  if (!project.workspaceId) {
    return project.ownerId === user.sub ? { ok: true, value: project } : notFound;
  }
  const workspaceId = project.workspaceId;
  const member = await ctx.members.find(workspaceId, user.sub);
  if (!member) return notFound;
  const principal = { id: user.sub, role: member.role };
  const ok = await permitted(ctx, { principal, workspaceId, resource: { kind: "project", projectId }, action });
  return ok ? { ok: true, value: project } : forbidden;
}

export async function authorizeAsset(
  ctx: AccessContext,
  asset: AssetMetadata | null,
  action: AssetAction,
): Promise<Decision<AssetMetadata>> {
  return authorizeOwned(ctx, asset, action);
}

export async function authorizeJob(
  ctx: AccessContext,
  job: Job | null,
  action: JobAction,
): Promise<Decision<Job>> {
  return authorizeOwned(ctx, job, action);
}

async function authorizeOwned<T extends { sessionId?: string; projectId?: string }>(
  ctx: AccessContext,
  target: T | null,
  action: AssetAction | JobAction,
): Promise<Decision<T>> {
  if (!target) return notFound;
  if (!ctx.user) {
    return ctx.sessionId && target.sessionId === ctx.sessionId ? { ok: true, value: target } : notFound;
  }
  if (!target.projectId) return notFound;
  const d = await authorizeProject(ctx, target.projectId, action);
  return d.ok ? { ok: true, value: target } : d;
}

export function deniedResponse(
  c: Context<AppEnv>,
  denial: Denial,
  opts: { notFound: string; forbiddenAs?: 403 | 404 },
): Response {
  if (denial.reason === "forbidden" && opts.forbiddenAs === 403) {
    return c.json({ error: "Forbidden" }, 403);
  }
  return c.json({ error: opts.notFound }, 404);
}

if (import.meta.vitest) {
  const { test, expect, vi, describe, afterEach } = import.meta.vitest;

  const wsProject: Project = { id: "p1", name: "P", createdAt: 0, updatedAt: 0, ownerId: "u2", workspaceId: "ws1" };
  const ownerless: Project = { id: "p2", name: "Mine", createdAt: 0, updatedAt: 0, ownerId: "u1" };

  function ctx(opts: { user?: string; sessionId?: string; role?: Member["role"]; allow?: boolean } = {}) {
    const authorizer = { check: vi.fn(async () => opts.allow ?? true) };
    const projects: ProjectStore = {
      save: vi.fn(), list: vi.fn(async () => []), delete: vi.fn(),
      find: vi.fn(async (id: string) => [wsProject, ownerless].find((p) => p.id === id) ?? null),
    };
    const members: MemberStore = {
      save: vi.fn(), list: vi.fn(async () => []), listByUser: vi.fn(async () => []), delete: vi.fn(),
      find: vi.fn(async (workspaceId: string, userId: string) =>
        opts.role && workspaceId === "ws1" && userId === opts.user
          ? { workspaceId, userId, role: opts.role, createdAt: 0, updatedAt: 0 }
          : null),
    };
    const access: AccessContext = {
      user: opts.user ? { sub: opts.user } : null,
      sessionId: opts.sessionId ?? null,
      authorizer, members, projects,
    };
    return { access, authorizer };
  }

  function asset(overrides: Partial<AssetMetadata> = {}): AssetMetadata {
    return { id: "a1", filename: "f.txt", contentType: "text/plain", size: 10, createdAt: 0, expiresAt: 0, ...overrides };
  }

  function job(overrides: Partial<Job> = {}): Job {
    return { id: "j1", assetId: "a1", type: "archive-extraction", status: "pending", createdAt: 0, updatedAt: 0, ...overrides };
  }

  const NOT_FOUND = { ok: false, reason: "not_found" };
  const FORBIDDEN = { ok: false, reason: "forbidden" };

  describe("anonymous callers", () => {
    test("reach an asset or job of their own session", async () => {
      const { access } = ctx({ sessionId: "s1" });
      expect(await authorizeAsset(access, asset({ sessionId: "s1" }), "read_asset")).toEqual({ ok: true, value: asset({ sessionId: "s1" }) });
      expect(await authorizeJob(access, job({ sessionId: "s1" }), "read_job")).toEqual({ ok: true, value: job({ sessionId: "s1" }) });
    });

    test("do not reach another session's asset or job", async () => {
      const { access } = ctx({ sessionId: "s2" });
      expect(await authorizeAsset(access, asset({ sessionId: "s1" }), "read_asset")).toEqual(NOT_FOUND);
      expect(await authorizeJob(access, job({ sessionId: "s1" }), "read_job")).toEqual(NOT_FOUND);
    });

    test("without a session reach nothing, and a sessionless asset is nobody's", async () => {
      expect(await authorizeAsset(ctx().access, asset({ sessionId: "s1" }), "read_asset")).toEqual(NOT_FOUND);
      expect(await authorizeAsset(ctx({ sessionId: "s1" }).access, asset(), "read_asset")).toEqual(NOT_FOUND);
    });

    test("never reach a project or workspace", async () => {
      expect(await authorizeProject(ctx({ sessionId: "s1" }).access, "p2", "read")).toEqual(NOT_FOUND);
      expect(await authorizeWorkspace(ctx({ sessionId: "s1" }).access, "ws1", "read")).toEqual(NOT_FOUND);
    });
  });

  describe("authenticated callers", () => {
    test("a missing asset or job is not_found", async () => {
      expect(await authorizeAsset(ctx({ user: "u1", role: "owner" }).access, null, "read_asset")).toEqual(NOT_FOUND);
      expect(await authorizeJob(ctx({ user: "u1", role: "owner" }).access, null, "read_job")).toEqual(NOT_FOUND);
    });

    test("an asset or job outside any project is not_found, even with a matching session", async () => {
      expect(await authorizeAsset(ctx({ user: "u1", sessionId: "s1" }).access, asset({ sessionId: "s1" }), "read_asset")).toEqual(NOT_FOUND);
      expect(await authorizeJob(ctx({ user: "u1" }).access, job(), "read_job")).toEqual(NOT_FOUND);
    });

    test("an asset in a missing project is not_found", async () => {
      expect(await authorizeAsset(ctx({ user: "u1", role: "owner" }).access, asset({ projectId: "gone" }), "read_asset")).toEqual(NOT_FOUND);
    });

    test("a member the floor and the authorizer allow reaches the asset, and the project is the resource", async () => {
      const { access, authorizer } = ctx({ user: "u1", role: "editor" });
      expect(await authorizeAsset(access, asset({ projectId: "p1" }), "update_asset")).toEqual({ ok: true, value: asset({ projectId: "p1" }) });
      expect(authorizer.check).toHaveBeenCalledWith({
        principal: { id: "u1", role: "editor" },
        workspaceId: "ws1",
        resource: { kind: "project", projectId: "p1" },
        action: "update_asset",
      });
    });

    test("a member the floor and the authorizer allow reaches the job", async () => {
      const { access, authorizer } = ctx({ user: "u1", role: "editor" });
      expect(await authorizeJob(access, job({ projectId: "p1" }), "retry_job")).toEqual({ ok: true, value: job({ projectId: "p1" }) });
      expect(authorizer.check).toHaveBeenCalledWith(expect.objectContaining({ action: "retry_job" }));
    });

    test("a non-member is not_found and the authorizer is not asked", async () => {
      const { access, authorizer } = ctx({ user: "u1" });
      expect(await authorizeAsset(access, asset({ projectId: "p1" }), "read_asset")).toEqual(NOT_FOUND);
      expect(await authorizeJob(access, job({ projectId: "p1" }), "read_job")).toEqual(NOT_FOUND);
      expect(await authorizeProject(access, "p1", "read")).toEqual(NOT_FOUND);
      expect(await authorizeWorkspace(access, "ws1", "read")).toEqual(NOT_FOUND);
      expect(authorizer.check).not.toHaveBeenCalled();
    });

    test("a member the authorizer refuses is forbidden", async () => {
      const { access } = ctx({ user: "u1", role: "owner", allow: false });
      expect(await authorizeAsset(access, asset({ projectId: "p1" }), "read_asset")).toEqual(FORBIDDEN);
      expect(await authorizeProject(access, "p1", "delete")).toEqual(FORBIDDEN);
      expect(await authorizeWorkspace(access, "ws1", "delete")).toEqual(FORBIDDEN);
    });

    test("the role floor refuses a viewer's upload though the authorizer allows everything, and never asks it", async () => {
      const { access, authorizer } = ctx({ user: "u1", role: "viewer", allow: true });
      expect(await authorizeProject(access, "p1", "create_asset")).toEqual(FORBIDDEN);
      expect(await authorizeWorkspace(access, "ws1", "create_project")).toEqual(FORBIDDEN);
      expect(authorizer.check).not.toHaveBeenCalled();
    });

    test("an ownerless project is its creator's alone, without the authorizer", async () => {
      const mine = ctx({ user: "u1" });
      expect(await authorizeProject(mine.access, "p2", "delete")).toEqual({ ok: true, value: ownerless });
      expect(await authorizeAsset(mine.access, asset({ projectId: "p2" }), "delete_asset")).toEqual({ ok: true, value: asset({ projectId: "p2" }) });
      expect(mine.authorizer.check).not.toHaveBeenCalled();
      expect(await authorizeProject(ctx({ user: "u3" }).access, "p2", "read")).toEqual(NOT_FOUND);
    });

    test("a workspace project's creator who is not a member is not_found", async () => {
      expect(await authorizeProject(ctx({ user: "u2" }).access, "p1", "read")).toEqual(NOT_FOUND);
    });

    test("authorizeWorkspace returns the caller's membership", async () => {
      const d = await authorizeWorkspace(ctx({ user: "u1", role: "admin" }).access, "ws1", "manage_members");
      expect(d).toEqual({ ok: true, value: expect.objectContaining({ userId: "u1", role: "admin" }) });
    });
  });

  describe("through CerbosAuthorizer", () => {
    afterEach(() => vi.unstubAllGlobals());

    function stubCerbos(effect: string) {
      const fetchMock = vi.fn(async (_url: string, init: RequestInit) => {
        const body = JSON.parse(String(init.body)) as { resources: Array<{ actions: string[] }> };
        return new Response(JSON.stringify({ results: [{ actions: { [body.resources[0].actions[0]]: effect } }] }));
      });
      vi.stubGlobal("fetch", fetchMock);
      return fetchMock;
    }

    async function withCerbos(role: Member["role"]) {
      const { CerbosAuthorizer } = await import("./authorizer");
      const { access } = ctx({ user: "u1", role });
      return { ...access, authorizer: new CerbosAuthorizer("http://pdp") };
    }

    test("an asset check names the project as the Cerbos resource, with its workspace as an attribute", async () => {
      const fetchMock = stubCerbos("EFFECT_ALLOW");
      expect((await authorizeAsset(await withCerbos("editor"), asset({ projectId: "p1" }), "update_asset")).ok).toBe(true);
      expect(fetchMock.mock.calls[0][0]).toBe("http://pdp/api/check/resources");
      expect(JSON.parse(String(fetchMock.mock.calls[0][1].body))).toEqual({
        principal: { id: "u1", roles: ["editor"] },
        resources: [{ resource: { kind: "project", id: "p1", attr: { workspaceId: "ws1" } }, actions: ["update_asset"] }],
      });
    });

    test("a workspace check names the workspace as the Cerbos resource, and a Cerbos deny is forbidden", async () => {
      const fetchMock = stubCerbos("EFFECT_DENY");
      expect(await authorizeWorkspace(await withCerbos("owner"), "ws1", "delete")).toEqual(FORBIDDEN);
      expect(JSON.parse(String(fetchMock.mock.calls[0][1].body))).toEqual({
        principal: { id: "u1", roles: ["owner"] },
        resources: [{ resource: { kind: "workspace", id: "ws1", attr: { workspaceId: "ws1" } }, actions: ["delete"] }],
      });
    });
  });

  describe("deniedResponse", () => {
    async function respond(denial: Denial, forbiddenAs?: 403 | 404) {
      const { Hono } = await import("hono");
      const app = new Hono<AppEnv>().get("/", (c) => deniedResponse(c, denial, { notFound: "Thing not found", forbiddenAs }));
      const res = await app.request("/");
      return { status: res.status, body: await res.json() };
    }

    test("not_found is 404 with the route's message, whatever forbiddenAs says", async () => {
      expect(await respond({ ok: false, reason: "not_found" })).toEqual({ status: 404, body: { error: "Thing not found" } });
      expect(await respond({ ok: false, reason: "not_found" }, 403)).toEqual({ status: 404, body: { error: "Thing not found" } });
    });

    test("forbidden is 404 by default and 403 when the route asks for it", async () => {
      expect(await respond({ ok: false, reason: "forbidden" })).toEqual({ status: 404, body: { error: "Thing not found" } });
      expect(await respond({ ok: false, reason: "forbidden" }, 404)).toEqual({ status: 404, body: { error: "Thing not found" } });
      expect(await respond({ ok: false, reason: "forbidden" }, 403)).toEqual({ status: 403, body: { error: "Forbidden" } });
    });
  });
}
