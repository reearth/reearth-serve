import type { Hono } from "hono";
import { describeRoute } from "hono-openapi";
import { validator as zValidator } from "hono-openapi";
import type { AppEnv } from "../../types";
import { getWorkspace } from "../usecase";
import { workspaceResponseSchema, idParamSchema } from "../../../shared/openapi";
import { jsonError, jsonResponse } from "../../openapi";

export function registerGetRoute(app: Hono<AppEnv>) {
  app.get("/:id",
    describeRoute({
      tags: ["Workspaces"],
      summary: "Get workspace",
      responses: {
        200: jsonResponse("Workspace details", workspaceResponseSchema),
        401: jsonError("Authentication required"),
        404: jsonError("Workspace not found"),
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
