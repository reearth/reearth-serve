import { Hono } from "hono";
import { describeRoute } from "hono-openapi";
import type { AppEnv } from "../types";
import { meResponseSchema } from "../../shared/openapi";
import { jsonError, jsonResponse } from "../openapi";

export const meRoutes = new Hono<AppEnv>();

meRoutes.get("/",
  describeRoute({
    tags: ["Auth"],
    summary: "Get current user info",
    responses: {
      200: jsonResponse("User info and workspaces", meResponseSchema),
      401: jsonError("Authentication required"),
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

    // Fetch workspaces in parallel — sequential N+1 multiplied D1 round-trip
    // latency by the membership count, which got expensive for users in many
    // workspaces.
    const workspaceResults = await Promise.all(
      memberEntries.map(async (m) => {
        const ws = await workspaceStore.find(m.workspaceId);
        return ws ? { ...ws, role: m.role } : null;
      }),
    );
    const workspaces = workspaceResults.filter((w): w is NonNullable<typeof w> => w !== null);

    return c.json({
      user: { sub: user.sub, email: user.email, name: user.name },
      workspaces,
    });
  },
);
