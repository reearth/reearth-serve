import type { Hono } from "hono";
import type { AppEnv } from "../../types";
import { getAssetMetadata } from "../usecase";
import { canAccessAsset } from "../access";
import { accessCtx } from "./shared";

export function registerGetRoute(app: Hono<AppEnv>) {
  // GET /api/v1/assets/:id — get metadata
  app.get("/:id", async (c) => {
    const metadata = c.get("metadata");
    const id = c.req.param("id");

    const asset = await getAssetMetadata(metadata, id);
    if (!asset || !await canAccessAsset(asset, accessCtx(c))) {
      return c.json({ error: "Asset not found" }, 404);
    }

    return c.json({ asset });
  });
}
