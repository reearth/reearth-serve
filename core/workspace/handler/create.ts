import type { Hono } from "hono";
import { describeRoute } from "hono-openapi";
import { validator as zValidator } from "hono-openapi";
import type { AppEnv } from "../../types";
import { createWorkspace } from "../usecase";
import { requireTenancyAdmin } from "../../tenancy/middleware";
import { workspaceResponseSchema, createWorkspaceBodySchema } from "../../../shared/openapi";
import { jsonError, jsonResponse } from "../../openapi";

export function registerCreateRoute(app: Hono<AppEnv>) {
  app.post("/",
    describeRoute({
      tags: ["Workspaces"],
      summary: "Create a workspace",
      responses: {
        201: jsonResponse("Workspace created", workspaceResponseSchema),
        400: jsonError("Bad request"),
        401: jsonError("Authentication required"),
        405: jsonError("Workspaces are managed by an external directory"),
      },
    }),
    zValidator("json", createWorkspaceBodySchema),
    async (c) => {
      const admin = requireTenancyAdmin(c);
      if (admin instanceof Response) return admin;

      const user = c.get("user");
      if (!user) {
        return c.json({ error: "Authentication required" }, 401);
      }

      const body = c.req.valid("json");
      const workspace = await createWorkspace(admin.workspaces, admin.members, body.name, user.id);
      return c.json({ workspace }, 201);
    },
  );
}
