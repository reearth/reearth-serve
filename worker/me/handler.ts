import { Hono } from "hono";
import { describeRoute } from "hono-openapi";
import { resolver } from "hono-openapi";
import type { AppEnv } from "../types";
import { meResponseSchema, errorResponseSchema } from "../../shared/openapi";

export const meRoutes = new Hono<AppEnv>();

meRoutes.get("/",
  describeRoute({
    tags: ["Auth"],
    summary: "Get current user info",
    responses: {
      200: { description: "User info and workspaces", content: { "application/json": { schema: resolver(meResponseSchema) } } },
      401: { description: "Authentication required", content: { "application/json": { schema: resolver(errorResponseSchema) } } },
    },
  }),
  async (c) => {
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
  },
);
