import type { Hono } from "hono";
import { describeRoute } from "hono-openapi";
import { validator as zValidator } from "hono-openapi";
import type { AppEnv } from "../../types";
import { deleteWorkspace } from "../usecase";
import { accessCtx, authorizeWorkspace, deniedResponse } from "../../auth/access";
import { requireTenancyAdmin } from "../../tenancy/middleware";
import { idParamSchema } from "../../../shared/openapi";
import { jsonError } from "../../openapi";

export function registerDeleteRoute(app: Hono<AppEnv>) {
  app.delete("/:id",
    describeRoute({
      tags: ["Workspaces"],
      summary: "Delete workspace",
      responses: {
        204: { description: "Workspace deleted" },
        401: jsonError("Authentication required"),
        403: jsonError("Forbidden"),
        404: jsonError("Workspace not found"),
        405: jsonError("Workspaces are managed by an external directory"),
        409: jsonError("Workspace still has projects"),
      },
    }),
    zValidator("param", idParamSchema),
    async (c) => {
      const admin = requireTenancyAdmin(c);
      if (admin instanceof Response) return admin;

      const user = c.get("user");
      if (!user) {
        return c.json({ error: "Authentication required" }, 401);
      }

      const { id } = c.req.valid("param");
      const access = await authorizeWorkspace(accessCtx(c), id, "delete");
      if (!access.ok) return deniedResponse(c, access, { notFound: "Workspace not found", forbiddenAs: 403 });

      const result = await deleteWorkspace(admin.workspaces, admin.members, c.get("projects"), id);
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
