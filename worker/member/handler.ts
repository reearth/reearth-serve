import { Hono } from "hono";
import type { AppEnv } from "../types";
import type { Role } from "../../shared/api";
import { addMember, listMembers, removeMember, updateMemberRole } from "./usecase";

export const memberRoutes = new Hono<AppEnv>();

// GET /api/v1/workspaces/:workspaceId/members
memberRoutes.get("/", async (c) => {
  const user = c.get("user");
  if (!user) {
    return c.json({ error: "Authentication required" }, 401);
  }

  const members = c.get("members");
  const workspaceId = c.req.param("workspaceId")!;

  // Check membership
  const self = await members.find(workspaceId, user.sub);
  if (!self) {
    return c.json({ error: "Workspace not found" }, 404);
  }

  const list = await listMembers(members, workspaceId);
  return c.json({ members: list });
});

// POST /api/v1/workspaces/:workspaceId/members
memberRoutes.post("/", async (c) => {
  const user = c.get("user");
  if (!user) {
    return c.json({ error: "Authentication required" }, 401);
  }

  const members = c.get("members");
  const authorizer = c.get("authorizer");
  const workspaceId = c.req.param("workspaceId")!;

  // Check membership and authorization
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
memberRoutes.patch("/:userId", async (c) => {
  const user = c.get("user");
  if (!user) {
    return c.json({ error: "Authentication required" }, 401);
  }

  const members = c.get("members");
  const authorizer = c.get("authorizer");
  const workspaceId = c.req.param("workspaceId")!;
  const targetUserId = c.req.param("userId")!;

  // Check membership and authorization
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
memberRoutes.delete("/:userId", async (c) => {
  const user = c.get("user");
  if (!user) {
    return c.json({ error: "Authentication required" }, 401);
  }

  const members = c.get("members");
  const authorizer = c.get("authorizer");
  const workspaceId = c.req.param("workspaceId")!;
  const targetUserId = c.req.param("userId")!;

  // Check membership and authorization
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
