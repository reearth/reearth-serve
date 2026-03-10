import { Hono } from "hono";
import type { AppEnv } from "../types";
import { uploadAsset, getAssetMetadata, deleteAsset, createUploadSession, completeUploadSession } from "./usecase";

export const assetRoutes = new Hono<AppEnv>();

// POST /assets/uploads — create upload session with presigned URL(s)
assetRoutes.post("/uploads", async (c) => {
  const presignedUrls = c.get("presignedUrls");
  if (!presignedUrls) {
    return c.json({ error: "Presigned URL uploads not available. Use POST /assets for direct upload." }, 501);
  }

  const body = await c.req.json<{ filename?: string; contentType?: string; size?: number; partCount?: number }>();
  if (!body.filename || !body.size) {
    return c.json({ error: "Missing required fields: filename, size" }, 400);
  }

  const sessions = c.get("uploadSessions");
  const ttlSeconds = c.get("ttlSeconds");

  const result = await createUploadSession(sessions, presignedUrls, {
    filename: body.filename,
    contentType: body.contentType || "application/octet-stream",
    size: body.size,
    partCount: body.partCount,
  }, ttlSeconds);

  return c.json(result, 201);
});

// POST /assets/uploads/:id/complete — confirm upload and create asset
assetRoutes.post("/uploads/:id/complete", async (c) => {
  const sessions = c.get("uploadSessions");
  const metadata = c.get("metadata");
  const storage = c.get("storage");
  const presignedUrls = c.get("presignedUrls");
  const ttlSeconds = c.get("ttlSeconds");
  const baseUrl = c.get("baseUrl");
  const id = c.req.param("id");

  // For multipart uploads, client sends parts with ETags
  let parts: { partNumber: number; etag: string }[] | undefined;
  const contentType = c.req.header("Content-Type") || "";
  if (contentType.includes("application/json")) {
    const body = await c.req.json<{ parts?: { partNumber: number; etag: string }[] }>();
    parts = body.parts;
  }

  const result = await completeUploadSession(sessions, metadata, storage, presignedUrls, id, ttlSeconds, baseUrl, parts);
  if (!result) {
    return c.json({ error: "Upload session not found or file not yet uploaded" }, 404);
  }

  return c.json(result, 201);
});

// POST /assets — upload a file (direct, for local dev / small files)
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
