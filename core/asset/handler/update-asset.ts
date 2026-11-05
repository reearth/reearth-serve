import type { Hono } from "hono";
import { describeRoute } from "hono-openapi";
import { resolver, validator as zValidator } from "hono-openapi";
import type { AppEnv } from "../../types";
import { getAssetMetadata, updateAsset, enrichAssetWithVersion } from "../usecase";
import { accessCtx, authorizeAsset, deniedResponse } from "../../auth/access";
import { assetResponseSchema, errorResponseSchema, idParamSchema, updateAssetBodySchema } from "../../../shared/openapi";

export function registerUpdateAssetRoute(app: Hono<AppEnv>) {
  app.patch("/:id",
    describeRoute({
      tags: ["Assets"],
      summary: "Update asset metadata",
      description: "Update mutable asset fields: description, userMeta, activeVersionId, expiresAt.",
      responses: {
        200: { description: "Updated asset", content: { "application/json": { schema: resolver(assetResponseSchema) } } },
        404: { description: "Asset not found", content: { "application/json": { schema: resolver(errorResponseSchema) } } },
      },
    }),
    zValidator("param", idParamSchema),
    zValidator("json", updateAssetBodySchema),
    async (c) => {
      const metadata = c.get("metadata");
      const versions = c.get("versions");
      const { id } = c.req.valid("param");

      const access = await authorizeAsset(accessCtx(c), await getAssetMetadata(metadata, id), "update_asset");
      if (!access.ok) return deniedResponse(c, access, { notFound: "Asset not found" });
      const existing = access.value;

      const body = c.req.valid("json");
      const updated = await updateAsset(metadata, versions, id, body);
      if (!updated) {
        return c.json({ error: "Asset not found or invalid activeVersionId" }, 404);
      }

      const enriched = await enrichAssetWithVersion(metadata, versions, id);
      return c.json({ asset: enriched ?? updated });
    },
  );
}
