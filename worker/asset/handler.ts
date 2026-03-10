import { Hono } from "hono";
import type { AppEnv } from "../types";
import { uploadAsset, getAssetMetadata, deleteAsset } from "./usecase";

export const assetRoutes = new Hono<AppEnv>();

// POST /assets — upload a file
assetRoutes.post("/", async (c) => {
  const metadata = c.get("metadata");
  const storage = c.get("storage");
  const ttlSeconds = c.get("ttlSeconds");
  const baseUrl = c.get("baseUrl");

  const formData = await c.req.raw.formData();
  const file = formData.get("file");

  if (!file || !(file instanceof File)) {
    return c.json({ error: "Missing 'file' field in multipart form data" }, 400);
  }

  const body = await file.arrayBuffer();
  const result = await uploadAsset(
    metadata,
    storage,
    { name: file.name, type: file.type, body },
    ttlSeconds,
    baseUrl,
  );

  return c.json(result, 201);
});

// GET /assets/:id — get metadata
assetRoutes.get("/:id", async (c) => {
  const metadata = c.get("metadata");
  const id = c.req.param("id");

  const asset = await getAssetMetadata(metadata, id);
  if (!asset) {
    return c.json({ error: "Asset not found" }, 404);
  }

  return c.json({ asset });
});

// DELETE /assets/:id — delete asset
assetRoutes.delete("/:id", async (c) => {
  const metadata = c.get("metadata");
  const storage = c.get("storage");
  const id = c.req.param("id");

  const deleted = await deleteAsset(metadata, storage, id);
  if (!deleted) {
    return c.json({ error: "Asset not found" }, 404);
  }

  return c.body(null, 204);
});
