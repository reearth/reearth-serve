import type { Hono } from "hono";
import type { AppEnv } from "../../types";
import { deleteWorkspace } from "../usecase";

export function registerDeleteRoute(app: Hono<AppEnv>) {
  // DELETE /api/v1/workspaces/:id — delete workspace (owner only)
  app.delete("/:id", async (c) => {
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
}
