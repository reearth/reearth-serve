import type { Hono } from "hono";
import { describeRoute } from "hono-openapi";
import { validator as zValidator } from "hono-openapi";
import type { AppEnv } from "../../types";
import { getWorkspace } from "../usecase";
import { accessCtx, authorizeWorkspace, deniedResponse } from "../../auth/access";
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
