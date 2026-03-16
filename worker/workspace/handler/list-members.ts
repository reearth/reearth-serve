import type { Hono } from "hono";
import type { AppEnv } from "../../types";
import { listMembers } from "../../member/usecase";

export function registerListMembersRoute(app: Hono<AppEnv>) {
  // GET /api/v1/workspaces/:workspaceId/members
  app.get("/:workspaceId/members", async (c) => {
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
}
