import type { Hono } from "hono";
import type { AppEnv } from "../../types";
import { getWorkspace } from "../usecase";

export function registerGetRoute(app: Hono<AppEnv>) {
  // GET /api/v1/workspaces/:id — get workspace
  app.get("/:id", async (c) => {
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
}
