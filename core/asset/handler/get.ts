import type { Hono } from "hono";
import { describeRoute } from "hono-openapi";
import { validator as zValidator } from "hono-openapi";
import type { AppEnv } from "../../types";
import { enrichAssetWithVersion } from "../usecase";
import { canAccessAsset } from "../access";
import { accessCtx } from "./shared";
import { assetResponseSchema, idParamSchema } from "../../../shared/openapi";
import { jsonError, jsonResponse } from "../../openapi";

export function registerGetRoute(app: Hono<AppEnv>) {
  app.get("/:id",
    describeRoute({
      tags: ["Assets"],
      summary: "Get asset metadata",
      responses: {
        200: jsonResponse("Asset metadata", assetResponseSchema),
        404: jsonError("Asset not found"),
      },
    }),
    zValidator("param", idParamSchema),
    async (c) => {
      const metadata = c.get("metadata");
      const versions = c.get("versions");
      const { id } = c.req.valid("param");

      const asset = await enrichAssetWithVersion(metadata, versions, id);
      if (!asset || !await canAccessAsset(asset, accessCtx(c))) {
        return c.json({ error: "Asset not found" }, 404);
      }

      return c.json({ asset });
    },
  );
}
