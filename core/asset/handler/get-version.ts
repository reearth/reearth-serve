import type { Hono } from "hono";
import { describeRoute } from "hono-openapi";
import { validator as zValidator } from "hono-openapi";
import type { AppEnv } from "../../types";
import { getAssetMetadata, getVersion } from "../usecase";
import { canAccessAsset } from "../access";
import { accessCtx } from "./shared";
import { versionResponseSchema, versionParamSchema } from "../../../shared/openapi";
import { jsonError, jsonResponse } from "../../openapi";

export function registerGetVersionRoute(app: Hono<AppEnv>) {
  app.get("/:id/versions/:versionId",
    describeRoute({
      tags: ["Versions"],
      summary: "Get version metadata",
      responses: {
        200: jsonResponse("Version metadata", versionResponseSchema),
        404: jsonError("Not found"),
      },
    }),
    zValidator("param", versionParamSchema),
    async (c) => {
      const metadata = c.get("metadata");
      const versions = c.get("versions");
      const { id, versionId } = c.req.valid("param");

      const asset = await getAssetMetadata(metadata, id);
      if (!asset || !await canAccessAsset(asset, accessCtx(c))) {
        return c.json({ error: "Asset not found" }, 404);
      }

      const version = await getVersion(versions, versionId);
      if (!version || version.assetId !== id) {
        return c.json({ error: "Version not found" }, 404);
      }

      return c.json({ version });
    },
  );
}
