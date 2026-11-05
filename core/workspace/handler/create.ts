import type { Hono } from "hono";
import { describeRoute } from "hono-openapi";
import { resolver, validator as zValidator } from "hono-openapi";
import type { AppEnv } from "../../types";
import { createWorkspace } from "../usecase";
import { requireTenancyAdmin } from "../../tenancy/middleware";
import { workspaceResponseSchema, errorResponseSchema, createWorkspaceBodySchema } from "../../../shared/openapi";

export function registerCreateRoute(app: Hono<AppEnv>) {
  app.post("/",
    describeRoute({
      tags: ["Workspaces"],
      summary: "Create a workspace",
      responses: {
        201: { description: "Workspace created", content: { "application/json": { schema: resolver(workspaceResponseSchema) } } },
        400: { description: "Bad request", content: { "application/json": { schema: resolver(errorResponseSchema) } } },
        401: { description: "Authentication required", content: { "application/json": { schema: resolver(errorResponseSchema) } } },
        405: { description: "Workspaces are managed by an external directory", content: { "application/json": { schema: resolver(errorResponseSchema) } } },
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
