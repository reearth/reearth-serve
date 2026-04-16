import type { AssetMetadata } from "./model";
import type { Job } from "../job/model";
import type { AuthUser } from "../auth/types";
import type { Authorizer } from "../auth/authorizer";
import type { MemberStore } from "../member/repository";
import type { ProjectStore } from "../project/repository";

export interface AccessContext {
  sessionId: string | null;
  user: AuthUser | null;
  authorizer: Authorizer;
  members: MemberStore;
  projects: ProjectStore;
}

/**
 * Check if the current user/session can access an asset.
 * - Demo mode (no user): sessionId must match
 * - Authenticated: asset MUST be project-scoped and caller must be a member
 *
 * Authenticated uploads are required to carry a projectId, so a non-project
 * asset reaching this check is either a stray anon/legacy row or another
 * user's demo data; in both cases authenticated callers are denied.
 */
export async function canAccessAsset(
  asset: AssetMetadata,
  ctx: AccessContext,
  action: string = "read",
): Promise<boolean> {
  if (!ctx.user) {
    return !!ctx.sessionId && asset.sessionId === ctx.sessionId;
  }
  if (!asset.projectId) return false;
  return checkProjectAccess(ctx, asset.projectId, "asset", asset.id, action);
}

/**
 * Check if the current user/session can access a job.
 */
export async function canAccessJob(
  job: Job,
  ctx: AccessContext,
  action: string = "read",
): Promise<boolean> {
  if (!ctx.user) {
    return !!ctx.sessionId && job.sessionId === ctx.sessionId;
  }
  if (!job.projectId) return false;
  return checkProjectAccess(ctx, job.projectId, "job", job.id, action);
}

/**
 * Check if the current user can act on a project (workspace membership).
 * Used at upload time to authorize the incoming X-Project-Id binding.
 */
export async function canAccessProject(
  ctx: AccessContext,
  projectId: string,
  action: string = "read",
): Promise<boolean> {
  if (!ctx.user) return false;
  return checkProjectAccess(ctx, projectId, "project", projectId, action);
}

async function checkProjectAccess(
  ctx: AccessContext,
  projectId: string,
  resourceKind: string,
  resourceId: string,
  action: string,
): Promise<boolean> {
  const project = await ctx.projects.find(projectId);
  if (!project) return false;

  const workspaceId = project.workspaceId;
  if (!workspaceId) {
    // Project without workspace: only owner can access
    return project.ownerId === ctx.user!.sub;
  }

  const member = await ctx.members.find(workspaceId, ctx.user!.sub);
  if (!member) return false;

  return ctx.authorizer.check({
    principal: { id: ctx.user!.sub, roles: [member.role] },
    resource: { kind: resourceKind, id: resourceId },
    action,
  });
}

if (import.meta.vitest) {
  const { test, expect, vi } = import.meta.vitest;

  const dummyAuthorizer = { check: vi.fn(async () => true) };
  const dummyMembers = {
    save: vi.fn(), find: vi.fn(async () => null), list: vi.fn(async () => []),
    listByUser: vi.fn(async () => []), delete: vi.fn(),
  };
  const dummyProjects = {
    save: vi.fn(), find: vi.fn(async () => null), list: vi.fn(async () => []), delete: vi.fn(),
  };

  function ctx(overrides: Partial<AccessContext> = {}): AccessContext {
    return {
      sessionId: null,
      user: null,
      authorizer: dummyAuthorizer,
      members: dummyMembers,
      projects: dummyProjects,
      ...overrides,
    };
  }

  function asset(overrides: Partial<AssetMetadata> = {}): AssetMetadata {
    return {
      id: "a1", filename: "f.txt", contentType: "text/plain", size: 10,
      createdAt: Date.now(), expiresAt: Date.now() + 3600000,
      ...overrides,
    };
  }

  function job(overrides: Partial<Job> = {}): Job {
    return {
      id: "j1", assetId: "a1", type: "archive-extraction", status: "pending",
      createdAt: Date.now(), updatedAt: Date.now(),
      ...overrides,
    };
  }

  // --- canAccessAsset: demo mode ---

  test("demo: matching sessionId → true", async () => {
    expect(await canAccessAsset(asset({ sessionId: "sess1" }), ctx({ sessionId: "sess1" }))).toBe(true);
  });

  test("demo: different sessionId → false", async () => {
    expect(await canAccessAsset(asset({ sessionId: "sess1" }), ctx({ sessionId: "sess2" }))).toBe(false);
  });

  test("demo: no sessionId on context → false", async () => {
    expect(await canAccessAsset(asset({ sessionId: "sess1" }), ctx({ sessionId: null }))).toBe(false);
  });

  test("demo: no sessionId on asset → false", async () => {
    expect(await canAccessAsset(asset(), ctx({ sessionId: "sess1" }))).toBe(false);
  });

  // --- canAccessAsset: authenticated, no project ---

  test("auth: no projectId → false (non-project assets are unreachable for authed callers)", async () => {
    expect(await canAccessAsset(asset(), ctx({ user: { sub: "u1" } }))).toBe(false);
  });

  // --- canAccessAsset: authenticated, with project ---

  test("auth: project exists, user is member, authorizer allows → true", async () => {
    const projects = { ...dummyProjects, find: vi.fn(async () => ({ id: "p1", name: "P", createdAt: 0, updatedAt: 0, ownerId: "u2", workspaceId: "ws1" })) };
    const members = { ...dummyMembers, find: vi.fn(async () => ({ workspaceId: "ws1", userId: "u1", role: "editor" as const, createdAt: 0, updatedAt: 0 })) };
    const authorizer = { check: vi.fn(async () => true) };
    expect(await canAccessAsset(asset({ projectId: "p1" }), ctx({ user: { sub: "u1" }, projects, members, authorizer }))).toBe(true);
    expect(authorizer.check).toHaveBeenCalledWith({
      principal: { id: "u1", roles: ["editor"] },
      resource: { kind: "asset", id: "a1" },
      action: "read",
    });
  });

  test("auth: project exists, user is not member → false", async () => {
    const projects = { ...dummyProjects, find: vi.fn(async () => ({ id: "p1", name: "P", createdAt: 0, updatedAt: 0, ownerId: "u2", workspaceId: "ws1" })) };
    expect(await canAccessAsset(asset({ projectId: "p1" }), ctx({ user: { sub: "u1" }, projects }))).toBe(false);
  });

  test("auth: project exists, authorizer denies → false", async () => {
    const projects = { ...dummyProjects, find: vi.fn(async () => ({ id: "p1", name: "P", createdAt: 0, updatedAt: 0, ownerId: "u2", workspaceId: "ws1" })) };
    const members = { ...dummyMembers, find: vi.fn(async () => ({ workspaceId: "ws1", userId: "u1", role: "viewer" as const, createdAt: 0, updatedAt: 0 })) };
    const authorizer = { check: vi.fn(async () => false) };
    expect(await canAccessAsset(asset({ projectId: "p1" }), ctx({ user: { sub: "u1" }, projects, members, authorizer }))).toBe(false);
  });

  test("auth: project not found → false", async () => {
    expect(await canAccessAsset(asset({ projectId: "missing" }), ctx({ user: { sub: "u1" } }))).toBe(false);
  });

  test("auth: project without workspace, owner → true", async () => {
    const projects = { ...dummyProjects, find: vi.fn(async () => ({ id: "p1", name: "P", createdAt: 0, updatedAt: 0, ownerId: "u1" })) };
    expect(await canAccessAsset(asset({ projectId: "p1" }), ctx({ user: { sub: "u1" }, projects }))).toBe(true);
  });

  test("auth: project without workspace, not owner → false", async () => {
    const projects = { ...dummyProjects, find: vi.fn(async () => ({ id: "p1", name: "P", createdAt: 0, updatedAt: 0, ownerId: "u2" })) };
    expect(await canAccessAsset(asset({ projectId: "p1" }), ctx({ user: { sub: "u1" }, projects }))).toBe(false);
  });

  test("auth: delete action passed to authorizer", async () => {
    const projects = { ...dummyProjects, find: vi.fn(async () => ({ id: "p1", name: "P", createdAt: 0, updatedAt: 0, ownerId: "u2", workspaceId: "ws1" })) };
    const members = { ...dummyMembers, find: vi.fn(async () => ({ workspaceId: "ws1", userId: "u1", role: "editor" as const, createdAt: 0, updatedAt: 0 })) };
    const authorizer = { check: vi.fn(async () => true) };
    await canAccessAsset(asset({ projectId: "p1" }), ctx({ user: { sub: "u1" }, projects, members, authorizer }), "delete");
    expect(authorizer.check).toHaveBeenCalledWith(expect.objectContaining({ action: "delete" }));
  });

  // --- canAccessJob ---

  test("job demo: matching sessionId → true", async () => {
    expect(await canAccessJob(job({ sessionId: "sess1" }), ctx({ sessionId: "sess1" }))).toBe(true);
  });

  test("job demo: different sessionId → false", async () => {
    expect(await canAccessJob(job({ sessionId: "sess1" }), ctx({ sessionId: "sess2" }))).toBe(false);
  });

  test("job auth: no projectId → false", async () => {
    expect(await canAccessJob(job(), ctx({ user: { sub: "u1" } }))).toBe(false);
  });

  // --- canAccessProject ---

  test("canAccessProject: unauthenticated → false", async () => {
    const { canAccessProject } = await import("./access");
    expect(await canAccessProject(ctx(), "p1")).toBe(false);
  });

  test("canAccessProject: member → true", async () => {
    const { canAccessProject } = await import("./access");
    const projects = { ...dummyProjects, find: vi.fn(async () => ({ id: "p1", name: "P", createdAt: 0, updatedAt: 0, ownerId: "u2", workspaceId: "ws1" })) };
    const members = { ...dummyMembers, find: vi.fn(async () => ({ workspaceId: "ws1", userId: "u1", role: "editor" as const, createdAt: 0, updatedAt: 0 })) };
    const authorizer = { check: vi.fn(async () => true) };
    expect(await canAccessProject(ctx({ user: { sub: "u1" }, projects, members, authorizer }), "p1", "upload")).toBe(true);
  });

  test("canAccessProject: non-member → false", async () => {
    const { canAccessProject } = await import("./access");
    const projects = { ...dummyProjects, find: vi.fn(async () => ({ id: "p1", name: "P", createdAt: 0, updatedAt: 0, ownerId: "u2", workspaceId: "ws1" })) };
    expect(await canAccessProject(ctx({ user: { sub: "u1" }, projects }), "p1", "upload")).toBe(false);
  });

  test("job auth: project exists, member allowed → true", async () => {
    const projects = { ...dummyProjects, find: vi.fn(async () => ({ id: "p1", name: "P", createdAt: 0, updatedAt: 0, ownerId: "u2", workspaceId: "ws1" })) };
    const members = { ...dummyMembers, find: vi.fn(async () => ({ workspaceId: "ws1", userId: "u1", role: "editor" as const, createdAt: 0, updatedAt: 0 })) };
    const authorizer = { check: vi.fn(async () => true) };
    expect(await canAccessJob(job({ projectId: "p1" }), ctx({ user: { sub: "u1" }, projects, members, authorizer }))).toBe(true);
  });

  test("job auth: not member → false", async () => {
    const projects = { ...dummyProjects, find: vi.fn(async () => ({ id: "p1", name: "P", createdAt: 0, updatedAt: 0, ownerId: "u2", workspaceId: "ws1" })) };
    expect(await canAccessJob(job({ projectId: "p1" }), ctx({ user: { sub: "u1" }, projects }))).toBe(false);
  });
}
