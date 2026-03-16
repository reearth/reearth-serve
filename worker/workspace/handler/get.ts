import type { Hono } from "hono";
import { describeRoute } from "hono-openapi";
import { resolver, validator as zValidator } from "hono-openapi";
import type { AppEnv } from "../../types";
import { getWorkspace } from "../usecase";
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

      const workspaces = c.get("workspaces");
      const members = c.get("members");
      const { id } = c.req.valid("param");

      const member = await members.find(id, user.sub);
      if (!member) {
        return c.json({ error: "Workspace not found" }, 404);
      }

      const workspace = await getWorkspace(workspaces, id);
      if (!workspace) {
        return c.json({ error: "Workspace not found" }, 404);
      }

      return c.json({ workspace });
    },
  );
}
