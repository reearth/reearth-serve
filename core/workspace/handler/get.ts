import type { Hono } from "hono";
import { describeRoute } from "hono-openapi";
import { resolver, validator as zValidator } from "hono-openapi";
import type { AppEnv } from "../../types";
import { getWorkspace } from "../usecase";
import { accessCtx, authorizeWorkspace, deniedResponse } from "../../auth/access";
import { workspaceResponseSchema, errorResponseSchema, idParamSchema } from "../../../shared/openapi";

export function registerGetRoute(app: Hono<AppEnv>) {
  app.get("/:id",
    describeRoute({
      tags: ["Workspaces"],
      summary: "Get workspace",
      responses: {
        200: { description: "Workspace details", content: { "application/json": { schema: resolver(workspaceResponseSchema) } } },
        401: { description: "Authentication required", content: { "application/json": { schema: resolver(errorResponseSchema) } } },
        404: { description: "Workspace not found", content: { "application/json": { schema: resolver(errorResponseSchema) } } },
      },
    }),
    zValidator("param", idParamSchema),
    async (c) => {
      const user = c.get("user");
      if (!user) {
        return c.json({ error: "Authentication required" }, 401);
      }

      const { id } = c.req.valid("param");
      const access = await authorizeWorkspace(accessCtx(c), id, "read");
      if (!access.ok) return deniedResponse(c, access, { notFound: "Workspace not found" });

      const workspace = await getWorkspace(c.get("workspaces"), id);
      if (!workspace) {
        return c.json({ error: "Workspace not found" }, 404);
      }

      return c.json({ workspace });
    },
  );
}
