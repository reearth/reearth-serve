import type { Hono } from "hono";
import type { AppEnv } from "../../types";
import { removeMember } from "../../member/usecase";

export function registerRemoveMemberRoute(app: Hono<AppEnv>) {
  // DELETE /api/v1/workspaces/:workspaceId/members/:userId
  app.delete("/:workspaceId/members/:userId", async (c) => {
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
}
