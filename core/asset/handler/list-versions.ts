import type { Hono } from "hono";
import { describeRoute } from "hono-openapi";
import { validator as zValidator } from "hono-openapi";
import type { AppEnv } from "../../types";
import { getAssetMetadata, listVersions } from "../usecase";
import { accessCtx, authorizeAsset, deniedResponse } from "../../auth/access";
import { versionListResponseSchema, idParamSchema, paginationQuerySchema } from "../../../shared/openapi";
import { jsonError, jsonResponse } from "../../openapi";

export function registerListVersionsRoute(app: Hono<AppEnv>) {
  app.get("/:id/versions",
    describeRoute({
      tags: ["Versions"],
      summary: "List versions of an asset",
      responses: {
        200: jsonResponse("Version list", versionListResponseSchema),
        404: jsonError("Asset not found"),
      },
    }),
    zValidator("param", idParamSchema),
    zValidator("query", paginationQuerySchema),
    async (c) => {
      const metadata = c.get("metadata");
      const versions = c.get("versions");
      const { id } = c.req.valid("param");
      const { limit: limitStr, cursor } = c.req.valid("query");

      const access = await authorizeAsset(accessCtx(c), await getAssetMetadata(metadata, id), "read_asset");
      if (!access.ok) return deniedResponse(c, access, { notFound: "Asset not found" });
      const asset = access.value;

      const limit = parseInt(limitStr || "20", 10);
      const result = await listVersions(versions, id, { limit: Math.min(limit, 100), cursor });
      return c.json({ versions: result.items, cursor: result.cursor });
    },
  );
}
