import type { Hono } from "hono";
import { describeRoute } from "hono-openapi";
import { resolver, validator as zValidator } from "hono-openapi";
import type { AppEnv } from "../../types";
import { enrichAssetWithVersion } from "../usecase";
import { canAccessAsset } from "../access";
import { accessCtx } from "./shared";
import { assetResponseSchema, errorResponseSchema, idParamSchema } from "../../../shared/openapi";

export function registerGetRoute(app: Hono<AppEnv>) {
  app.get("/:id",
    describeRoute({
      tags: ["Assets"],
      summary: "Get asset metadata",
      responses: {
        200: { description: "Asset metadata", content: { "application/json": { schema: resolver(assetResponseSchema) } } },
        404: { description: "Asset not found", content: { "application/json": { schema: resolver(errorResponseSchema) } } },
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
