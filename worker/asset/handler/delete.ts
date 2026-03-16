import type { Hono } from "hono";
import type { AppEnv } from "../../types";
import { getAssetMetadata, deleteAsset } from "../usecase";
import { canAccessAsset } from "../access";
import { accessCtx } from "./shared";

export function registerDeleteRoute(app: Hono<AppEnv>) {
  // DELETE /api/v1/assets/:id — delete asset
  app.delete("/:id", async (c) => {
    const metadata = c.get("metadata");
    const storage = c.get("storage");
    const id = c.req.param("id");

    // Check access before deleting
    const asset = await getAssetMetadata(metadata, id);
    if (!asset || !await canAccessAsset(asset, accessCtx(c), "delete")) {
      return c.json({ error: "Asset not found" }, 404);
    }

    const deleted = await deleteAsset(metadata, storage, id);
    if (!deleted) {
      return c.json({ error: "Asset not found" }, 404);
    }

    return c.body(null, 204);
  });
}
