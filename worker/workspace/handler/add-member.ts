import type { Hono } from "hono";
import type { AppEnv } from "../../types";
import type { Role } from "../../../shared/api";
import { addMember } from "../../member/usecase";

export function registerAddMemberRoute(app: Hono<AppEnv>) {
  // POST /api/v1/workspaces/:workspaceId/members
  app.post("/:workspaceId/members", async (c) => {
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
}
