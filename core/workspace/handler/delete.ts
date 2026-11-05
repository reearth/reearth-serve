import type { Hono } from "hono";
import { describeRoute } from "hono-openapi";
import { resolver, validator as zValidator } from "hono-openapi";
import type { AppEnv } from "../../types";
import { deleteWorkspace } from "../usecase";
import { accessCtx, authorizeWorkspace, deniedResponse } from "../../auth/access";
import { errorResponseSchema, idParamSchema } from "../../../shared/openapi";

export function registerDeleteRoute(app: Hono<AppEnv>) {
  app.delete("/:id",
    describeRoute({
      tags: ["Workspaces"],
      summary: "Delete workspace",
      responses: {
        204: { description: "Workspace deleted" },
        401: { description: "Authentication required", content: { "application/json": { schema: resolver(errorResponseSchema) } } },
        403: { description: "Forbidden", content: { "application/json": { schema: resolver(errorResponseSchema) } } },
        404: { description: "Workspace not found", content: { "application/json": { schema: resolver(errorResponseSchema) } } },
        409: { description: "Workspace still has projects", content: { "application/json": { schema: resolver(errorResponseSchema) } } },
      },
    }),
    zValidator("param", idParamSchema),
    async (c) => {
      const user = c.get("user");
      if (!user) {
        return c.json({ error: "Authentication required" }, 401);
      }

      const { id } = c.req.valid("param");
      const access = await authorizeWorkspace(accessCtx(c), id, "delete");
      if (!access.ok) return deniedResponse(c, access, { notFound: "Workspace not found", forbiddenAs: 403 });

      const result = await deleteWorkspace(c.get("workspaces"), c.get("members"), c.get("projects"), id);
      if (result === "not_found") {
        return c.json({ error: "Workspace not found" }, 404);
      }
      if (result === "has_projects") {
        return c.json({ error: "Workspace still has projects" }, 409);
      }

      return c.body(null, 204);
    },
  );
}
