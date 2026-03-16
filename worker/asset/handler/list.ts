import type { Hono } from "hono";
import type { AppEnv } from "../../types";

export function registerListRoute(app: Hono<AppEnv>) {
  // GET /api/v1/assets — list assets
  // Query params: ?limit=20&cursor=xxx
  app.get("/", async (c) => {
    const metadata = c.get("metadata");
    const sessionId = c.get("sessionId");
    const user = c.get("user");
    const limit = parseInt(c.req.query("limit") || "20", 10);
    const cursor = c.req.query("cursor") || undefined;

    const result = await metadata.list({
      limit: Math.min(limit, 100),
      cursor,
      ...(!user && sessionId ? { sessionId } : {}),
    });
    return c.json({ assets: result.items, cursor: result.cursor });
  });
}
