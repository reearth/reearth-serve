import type { Hono } from "hono";
import type { AppEnv } from "../../types";
import { createUploadSession } from "../usecase";

export function registerCreateUploadSessionRoute(app: Hono<AppEnv>) {
  // POST /api/v1/assets/uploads — create upload session with presigned URL(s)
  app.post("/uploads", async (c) => {
    const presignedUrls = c.get("presignedUrls");
    if (!presignedUrls) {
      return c.json({ error: "Presigned URL uploads not available. Use POST /api/v1/assets for direct upload." }, 501);
    }

    const body = await c.req.json<{ filename?: string; contentType?: string; size?: number; partCount?: number; skipExtraction?: boolean }>();
    if (!body.filename || !body.size) {
      return c.json({ error: "Missing required fields: filename, size" }, 400);
    }

    const sessions = c.get("uploadSessions");
    const ttlSeconds = c.get("ttlSeconds");
    const sessionId = c.get("sessionId");

    const result = await createUploadSession(sessions, presignedUrls, {
      filename: body.filename,
      contentType: body.contentType || "application/octet-stream",
      size: body.size,
      partCount: body.partCount,
    }, ttlSeconds, { sessionId, skipExtraction: body.skipExtraction });

    return c.json(result, 201);
  });
}
