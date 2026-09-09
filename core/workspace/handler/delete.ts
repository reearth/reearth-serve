import type { Hono } from "hono";
import { describeRoute } from "hono-openapi";
import { resolver, validator as zValidator } from "hono-openapi";
import type { AppEnv } from "../../types";
import { deleteWorkspace } from "../usecase";
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
      const authorizer = c.get("authorizer");
      const { id } = c.req.valid("param");

      const member = await members.find(id, user.sub);
      if (!member) {
        return c.json({ error: "Workspace not found" }, 404);
      }

      const allowed = await authorizer.check({
        principal: { id: user.sub, roles: [member.role] },
        resource: { kind: "workspace", id },
        action: "delete",
      });
      if (!allowed) {
        return c.json({ error: "Forbidden" }, 403);
      }

      const deleted = await deleteWorkspace(workspaces, members, id);
      if (!deleted) {
        return c.json({ error: "Workspace not found" }, 404);
      }

      return c.body(null, 204);
    },
  );
}
