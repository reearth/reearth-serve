import type { Hono } from "hono";
import type { AppEnv } from "../../types";
import { createWorkspace } from "../usecase";

export function registerCreateRoute(app: Hono<AppEnv>) {
  // POST /api/v1/workspaces — create a workspace
  app.post("/", async (c) => {
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
}
