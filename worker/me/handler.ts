import { Hono } from "hono";
import type { AppEnv } from "../types";

export const meRoutes = new Hono<AppEnv>();

// GET /api/v1/me — current user info + workspace list
meRoutes.get("/", async (c) => {
  const user = c.get("user");
  if (!user) {
    return c.json({ error: "Authentication required" }, 401);
  }

  const members = c.get("members");
  const workspaceStore = c.get("workspaces");

  const memberEntries = await members.listByUser(user.sub);

  const workspaces = [];
  for (const m of memberEntries) {
    const ws = await workspaceStore.find(m.workspaceId);
    if (ws) {
      workspaces.push({ ...ws, role: m.role });
    }
  }

  return c.json({
    user: { sub: user.sub, email: user.email, name: user.name },
    workspaces,
  });
});
