import type { Hono } from "hono";
import { describeRoute } from "hono-openapi";
import { resolver, validator as zValidator } from "hono-openapi";
import type { AppEnv } from "../../types";
import { getAssetMetadata, listVersions } from "../usecase";
import { canAccessAsset } from "../access";
import { accessCtx } from "./shared";
import { versionListResponseSchema, errorResponseSchema, idParamSchema, paginationQuerySchema } from "../../../shared/openapi";

export function registerListVersionsRoute(app: Hono<AppEnv>) {
  app.get("/:id/versions",
    describeRoute({
      tags: ["Versions"],
      summary: "List versions of an asset",
      responses: {
        200: { description: "Version list", content: { "application/json": { schema: resolver(versionListResponseSchema) } } },
        404: { description: "Asset not found", content: { "application/json": { schema: resolver(errorResponseSchema) } } },
      },
    }),
    zValidator("param", idParamSchema),
    zValidator("query", paginationQuerySchema),
    async (c) => {
      const metadata = c.get("metadata");
      const versions = c.get("versions");
      const { id } = c.req.valid("param");
      const { limit: limitStr, cursor } = c.req.valid("query");

      const asset = await getAssetMetadata(metadata, id);
      if (!asset || !await canAccessAsset(asset, accessCtx(c))) {
        return c.json({ error: "Asset not found" }, 404);
      }

      const limit = parseInt(limitStr || "20", 10);
      const result = await listVersions(versions, id, { limit: Math.min(limit, 100), cursor });
      return c.json({ versions: result.items, cursor: result.cursor });
    },
  );
}
