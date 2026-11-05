import type { Hono } from "hono";
import { describeRoute } from "hono-openapi";
import { resolver, validator as zValidator } from "hono-openapi";
import type { AppEnv } from "../../types";
import { accessCtx, authorizeProject, authorizeWorkspace, deniedResponse } from "../../auth/access";
import { assetListResponseSchema, errorResponseSchema, scopedListQuerySchema } from "../../../shared/openapi";

export function registerListRoute(app: Hono<AppEnv>) {
  app.get("/",
    describeRoute({
      tags: ["Assets"],
      summary: "List assets",
      description: "Anonymous callers see their own session's demo assets. Authenticated callers see assets in projects they have access to; narrow with ?projectId or ?workspaceId.",
      responses: {
        200: { description: "Asset list", content: { "application/json": { schema: resolver(assetListResponseSchema) } } },
        404: { description: "Scope not accessible", content: { "application/json": { schema: resolver(errorResponseSchema) } } },
      },
    }),
    zValidator("query", scopedListQuerySchema),
    async (c) => {
      const metadata = c.get("metadata");
      const sessionId = c.get("sessionId");
      const user = c.get("user");
      const { limit: limitStr, cursor, workspaceId, projectId } = c.req.valid("query");
      const limit = Math.min(parseInt(limitStr || "20", 10), 100);

      if (!user) {
        if (!sessionId) return c.json({ assets: [], cursor: undefined });
        const result = await metadata.list({ limit, cursor, sessionId });
        return c.json({ assets: result.items, cursor: result.cursor });
      }

      if (projectId) {
        const access = await authorizeProject(accessCtx(c), projectId, "read_asset");
        if (!access.ok) return deniedResponse(c, access, { notFound: "Project not found" });
        const result = await metadata.list({ limit, cursor, projectId });
        return c.json({ assets: result.items, cursor: result.cursor });
      }

      if (workspaceId) {
        const access = await authorizeWorkspace(accessCtx(c), workspaceId, "read");
        if (!access.ok) return deniedResponse(c, access, { notFound: "Workspace not found" });
        const result = await metadata.list({ limit, cursor, workspaceId });
        return c.json({ assets: result.items, cursor: result.cursor });
      }

      const result = await metadata.list({ limit, cursor, accessibleByUser: user.id });
      return c.json({ assets: result.items, cursor: result.cursor });
    },
  );
}
