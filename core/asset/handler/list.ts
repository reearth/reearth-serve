import type { Hono } from "hono";
import { describeRoute } from "hono-openapi";
import { resolver, validator as zValidator } from "hono-openapi";
import type { AppEnv } from "../../types";
import { canAccessProject } from "../access";
import { accessCtx } from "./shared";
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
        if (!await canAccessProject(accessCtx(c), projectId, "read")) {
          return c.json({ error: "Project not found" }, 404);
        }
        const result = await metadata.list({ limit, cursor, projectId });
        return c.json({ assets: result.items, cursor: result.cursor });
      }

      if (workspaceId) {
        const members = c.get("members");
        const member = await members.find(workspaceId, user.sub);
        if (!member) return c.json({ error: "Workspace not found" }, 404);
        const result = await metadata.list({ limit, cursor, workspaceId });
        return c.json({ assets: result.items, cursor: result.cursor });
      }

      const result = await metadata.list({ limit, cursor, accessibleByUser: user.sub });
      return c.json({ assets: result.items, cursor: result.cursor });
    },
  );
}
