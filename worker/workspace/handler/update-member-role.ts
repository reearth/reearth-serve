import type { Hono } from "hono";
import type { AppEnv } from "../../types";
import type { Role } from "../../../shared/api";
import { updateMemberRole } from "../../member/usecase";

export function registerUpdateMemberRoleRoute(app: Hono<AppEnv>) {
  // PATCH /api/v1/workspaces/:workspaceId/members/:userId
  app.patch("/:workspaceId/members/:userId", async (c) => {
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
}
