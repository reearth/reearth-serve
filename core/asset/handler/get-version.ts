import type { Hono } from "hono";
import { describeRoute } from "hono-openapi";
import { resolver, validator as zValidator } from "hono-openapi";
import type { AppEnv } from "../../types";
import { getAssetMetadata, getVersion } from "../usecase";
import { accessCtx, authorizeAsset, deniedResponse } from "../../auth/access";
import { versionResponseSchema, errorResponseSchema, versionParamSchema } from "../../../shared/openapi";

export function registerGetVersionRoute(app: Hono<AppEnv>) {
  app.get("/:id/versions/:versionId",
    describeRoute({
      tags: ["Versions"],
      summary: "Get version metadata",
      responses: {
        200: { description: "Version metadata", content: { "application/json": { schema: resolver(versionResponseSchema) } } },
        404: { description: "Not found", content: { "application/json": { schema: resolver(errorResponseSchema) } } },
      },
    }),
    zValidator("param", versionParamSchema),
    async (c) => {
      const metadata = c.get("metadata");
      const versions = c.get("versions");
      const { id, versionId } = c.req.valid("param");

      const access = await authorizeAsset(accessCtx(c), await getAssetMetadata(metadata, id), "read_asset");
      if (!access.ok) return deniedResponse(c, access, { notFound: "Asset not found" });
      const asset = access.value;

      const version = await getVersion(versions, versionId);
      if (!version || version.assetId !== id) {
        return c.json({ error: "Version not found" }, 404);
      }

      return c.json({ version });
    },
  );
}
