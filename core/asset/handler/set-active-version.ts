import type { Hono } from "hono";
import { describeRoute } from "hono-openapi";
import { resolver, validator as zValidator } from "hono-openapi";
import type { AppEnv } from "../../types";
import { getAssetMetadata, updateAsset, enrichAssetWithVersion } from "../usecase";
import { accessCtx, authorizeAsset, deniedResponse } from "../../auth/access";
import { assetResponseSchema, errorResponseSchema, idParamSchema, setActiveVersionBodySchema } from "../../../shared/openapi";

export function registerSetActiveVersionRoute(app: Hono<AppEnv>) {
  app.put("/:id/active-version",
    describeRoute({
      tags: ["Versions"],
      summary: "Set active version",
      description: "Set the active version for an asset. Pass { versionId: null } to reset to latest.",
      responses: {
        200: { description: "Updated asset", content: { "application/json": { schema: resolver(assetResponseSchema) } } },
        404: { description: "Not found", content: { "application/json": { schema: resolver(errorResponseSchema) } } },
      },
    }),
    zValidator("param", idParamSchema),
    zValidator("json", setActiveVersionBodySchema),
    async (c) => {
      const metadata = c.get("metadata");
      const versions = c.get("versions");
      const { id } = c.req.valid("param");

      const access = await authorizeAsset(accessCtx(c), await getAssetMetadata(metadata, id), "update_asset");
      if (!access.ok) return deniedResponse(c, access, { notFound: "Asset not found" });
      const asset = access.value;

      const { versionId } = c.req.valid("json");
      const updated = await updateAsset(metadata, versions, id, { activeVersionId: versionId });
      if (!updated) {
        return c.json({ error: "Asset or version not found" }, 404);
      }

      const enriched = await enrichAssetWithVersion(metadata, versions, id);
      return c.json({ asset: enriched ?? updated });
    },
  );
}
