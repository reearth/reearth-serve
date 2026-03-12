import { Hono } from "hono";
import type { AppEnv } from "../types";
import type { Role } from "../../shared/api";
import { createWorkspace, getWorkspace, deleteWorkspace } from "./usecase";
import { addMember, listMembers, removeMember, updateMemberRole } from "../member/usecase";

export const workspaceRoutes = new Hono<AppEnv>();

// POST /api/v1/workspaces — create a workspace
workspaceRoutes.post("/", async (c) => {
  const user = c.get("user");
  if (!user) {
    return c.json({ error: "Authentication required" }, 401);
  }

  const body = await c.req.json<{ name?: string }>();
  if (!body.name) {
    return c.json({ error: "Missing required field: name" }, 400);
  }

  const workspaces = c.get("workspaces");
  const members = c.get("members");
  const workspace = await createWorkspace(workspaces, members, body.name, user.sub);
  return c.json({ workspace }, 201);
});

// GET /api/v1/workspaces/:id — get workspace
workspaceRoutes.get("/:id", async (c) => {
  const user = c.get("user");
  if (!user) {
    return c.json({ error: "Authentication required" }, 401);
  }

  const workspaces = c.get("workspaces");
  const members = c.get("members");
  const id = c.req.param("id");

  // Check membership
  const member = await members.find(id, user.sub);
  if (!member) {
    return c.json({ error: "Workspace not found" }, 404);
  }

  const workspace = await getWorkspace(workspaces, id);
  if (!workspace) {
    return c.json({ error: "Workspace not found" }, 404);
  }

  return c.json({ workspace });
});

// DELETE /api/v1/workspaces/:id — delete workspace (owner only)
workspaceRoutes.delete("/:id", async (c) => {
  const user = c.get("user");
  if (!user) {
    return c.json({ error: "Authentication required" }, 401);
  }

  const workspaces = c.get("workspaces");
  const members = c.get("members");
  const authorizer = c.get("authorizer");
  const id = c.req.param("id");

  // Check membership and authorization
  const member = await members.find(id, user.sub);
  if (!member) {
    return c.json({ error: "Workspace not found" }, 404);
  }

  const allowed = await authorizer.check({
    principal: { id: user.sub, roles: [member.role] },
    resource: { kind: "workspace", id },
    action: "delete",
  });
  if (!allowed) {
    return c.json({ error: "Forbidden" }, 403);
  }

  const deleted = await deleteWorkspace(workspaces, members, id);
  if (!deleted) {
    return c.json({ error: "Workspace not found" }, 404);
  }

  return c.body(null, 204);
});

// --- Member routes (nested under /api/v1/workspaces/:workspaceId/members) ---

// GET /api/v1/workspaces/:workspaceId/members
workspaceRoutes.get("/:workspaceId/members", async (c) => {
  const user = c.get("user");
  if (!user) {
    return c.json({ error: "Authentication required" }, 401);
  }

  const members = c.get("members");
  const workspaceId = c.req.param("workspaceId");

  const self = await members.find(workspaceId, user.sub);
  if (!self) {
    return c.json({ error: "Workspace not found" }, 404);
  }

  const list = await listMembers(members, workspaceId);
  return c.json({ members: list });
});

// POST /api/v1/workspaces/:workspaceId/members
workspaceRoutes.post("/:workspaceId/members", async (c) => {
  const user = c.get("user");
  if (!user) {
    return c.json({ error: "Authentication required" }, 401);
  }

  const members = c.get("members");
  const authorizer = c.get("authorizer");
  const workspaceId = c.req.param("workspaceId");

  const self = await members.find(workspaceId, user.sub);
  if (!self) {
    return c.json({ error: "Workspace not found" }, 404);
  }

  const allowed = await authorizer.check({
    principal: { id: user.sub, roles: [self.role] },
    resource: { kind: "workspace", id: workspaceId },
    action: "manage-members",
  });
  if (!allowed) {
    return c.json({ error: "Forbidden" }, 403);
  }

  const body = await c.req.json<{ userId?: string; role?: string }>();
  if (!body.userId || !body.role) {
    return c.json({ error: "Missing required fields: userId, role" }, 400);
  }

  try {
    const member = await addMember(members, workspaceId, body.userId, body.role as Role);
    return c.json({ member }, 201);
  } catch (e) {
    return c.json({ error: (e as Error).message }, 409);
  }
});

// PATCH /api/v1/workspaces/:workspaceId/members/:userId
workspaceRoutes.patch("/:workspaceId/members/:userId", async (c) => {
  const user = c.get("user");
  if (!user) {
    return c.json({ error: "Authentication required" }, 401);
  }

  const members = c.get("members");
  const authorizer = c.get("authorizer");
  const workspaceId = c.req.param("workspaceId");
  const targetUserId = c.req.param("userId");

  const self = await members.find(workspaceId, user.sub);
  if (!self) {
    return c.json({ error: "Workspace not found" }, 404);
  }

  const allowed = await authorizer.check({
    principal: { id: user.sub, roles: [self.role] },
    resource: { kind: "workspace", id: workspaceId },
    action: "manage-members",
  });
  if (!allowed) {
    return c.json({ error: "Forbidden" }, 403);
  }

  const body = await c.req.json<{ role?: string }>();
  if (!body.role) {
    return c.json({ error: "Missing required field: role" }, 400);
  }

  try {
    const member = await updateMemberRole(members, workspaceId, targetUserId, body.role as Role);
    if (!member) {
      return c.json({ error: "Member not found" }, 404);
    }
    return c.json({ member });
  } catch (e) {
    return c.json({ error: (e as Error).message }, 400);
  }
});

// DELETE /api/v1/workspaces/:workspaceId/members/:userId
workspaceRoutes.delete("/:workspaceId/members/:userId", async (c) => {
  const user = c.get("user");
  if (!user) {
    return c.json({ error: "Authentication required" }, 401);
  }

  const members = c.get("members");
  const authorizer = c.get("authorizer");
  const workspaceId = c.req.param("workspaceId");
  const targetUserId = c.req.param("userId");

  const self = await members.find(workspaceId, user.sub);
  if (!self) {
    return c.json({ error: "Workspace not found" }, 404);
  }

  const allowed = await authorizer.check({
    principal: { id: user.sub, roles: [self.role] },
    resource: { kind: "workspace", id: workspaceId },
    action: "manage-members",
  });
  if (!allowed) {
    return c.json({ error: "Forbidden" }, 403);
  }

  try {
    const removed = await removeMember(members, workspaceId, targetUserId);
    if (!removed) {
      return c.json({ error: "Member not found" }, 404);
    }
    return c.body(null, 204);
  } catch (e) {
    return c.json({ error: (e as Error).message }, 400);
  }
});
