import type { Hono } from "hono";
import { describeRoute } from "hono-openapi";
import { validator as zValidator } from "hono-openapi";
import type { AppEnv } from "../../types";
import { toAssetResponse } from "../response";
import { getAssetMetadata, updateAsset, enrichAssetWithVersion } from "../usecase";
import { accessCtx, authorizeAsset, deniedResponse } from "../../auth/access";
import { assetResponseSchema, idParamSchema, setActiveVersionBodySchema } from "../../../shared/openapi";
import { jsonError, jsonResponse } from "../../openapi";

export function registerSetActiveVersionRoute(app: Hono<AppEnv>) {
  app.put("/:id/active-version",
    describeRoute({
      tags: ["Versions"],
      summary: "Set active version",
      description: "Set the active version for an asset. Pass { versionId: null } to reset to latest.",
      responses: {
        200: jsonResponse("Asset with the new active version", assetResponseSchema),
        404: jsonError("Not found"),
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
      return c.json({ asset: toAssetResponse(enriched ?? updated) });
    },
  );
}
