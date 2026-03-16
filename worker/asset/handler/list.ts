import type { Hono } from "hono";
import { describeRoute } from "hono-openapi";
import { resolver, validator as zValidator } from "hono-openapi";
import type { AppEnv } from "../../types";
import { assetListResponseSchema, paginationQuerySchema } from "../../../shared/openapi";

export function registerListRoute(app: Hono<AppEnv>) {
  app.get("/",
    describeRoute({
      tags: ["Assets"],
      summary: "List assets",
      responses: {
        200: { description: "Asset list", content: { "application/json": { schema: resolver(assetListResponseSchema) } } },
      },
    }),
    zValidator("query", paginationQuerySchema),
    async (c) => {
      const metadata = c.get("metadata");
      const sessionId = c.get("sessionId");
      const user = c.get("user");
      const { limit: limitStr, cursor } = c.req.valid("query");
      const limit = parseInt(limitStr || "20", 10);

      const result = await metadata.list({
        limit: Math.min(limit, 100),
        cursor,
        ...(!user && sessionId ? { sessionId } : {}),
      });
      return c.json({ assets: result.items, cursor: result.cursor });
    },
  );
}
