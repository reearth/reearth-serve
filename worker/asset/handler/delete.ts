import type { Hono } from "hono";
import { describeRoute } from "hono-openapi";
import { resolver, validator as zValidator } from "hono-openapi";
import type { AppEnv } from "../../types";
import { getAssetMetadata, deleteAsset } from "../usecase";
import { canAccessAsset } from "../access";
import { accessCtx } from "./shared";
import { errorResponseSchema, idParamSchema } from "../../../shared/openapi";

export function registerDeleteRoute(app: Hono<AppEnv>) {
  app.delete("/:id",
    describeRoute({
      tags: ["Assets"],
      summary: "Delete asset",
      responses: {
        204: { description: "Asset deleted" },
        404: { description: "Asset not found", content: { "application/json": { schema: resolver(errorResponseSchema) } } },
      },
    }),
    zValidator("param", idParamSchema),
    async (c) => {
      const metadata = c.get("metadata");
      const storage = c.get("storage");
      const { id } = c.req.valid("param");

      const asset = await getAssetMetadata(metadata, id);
      if (!asset || !await canAccessAsset(asset, accessCtx(c), "delete")) {
        return c.json({ error: "Asset not found" }, 404);
      }

      const deleted = await deleteAsset(metadata, storage, id);
      if (!deleted) {
        return c.json({ error: "Asset not found" }, 404);
      }

      return c.body(null, 204);
    },
  );
}
