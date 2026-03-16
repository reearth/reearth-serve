import type { Hono } from "hono";
import type { AppEnv } from "../../types";
import { completeUploadSession } from "../usecase";

export function registerCompleteUploadSessionRoute(app: Hono<AppEnv>) {
  // POST /api/v1/assets/uploads/:id/complete — confirm upload and create asset
  app.post("/uploads/:id/complete", async (c) => {
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

    const jobs = c.get("jobs");
    const sessionId = c.get("sessionId");
    const extractionQueue = c.get("extractionQueue");
    const result = await completeUploadSession(sessions, metadata, storage, presignedUrls, jobs, id, ttlSeconds, baseUrl, parts, { sessionId, extractionQueue });
    if (!result) {
      return c.json({ error: "Upload session not found or file not yet uploaded" }, 404);
    }

    return c.json(result, 201);
  });
}
