import type { Hono } from "hono";
import type { AppEnv } from "../../types";
import { uploadAsset } from "../usecase";

export function registerUploadRoute(app: Hono<AppEnv>) {
  // POST /api/v1/assets — upload a file (direct, streaming)
  // Headers: Content-Type (file type), X-Filename (filename), Content-Length (size)
  // Optional: Content-Encoding: gzip, X-Original-Size (uncompressed size)
  app.post("/", async (c) => {
    const metadata = c.get("metadata");
    const storage = c.get("storage");
    const ttlSeconds = c.get("ttlSeconds");
    const baseUrl = c.get("baseUrl");

    const filename = c.req.header("X-Filename");
    const contentLength = c.req.header("Content-Length");
    if (!filename || !contentLength) {
      return c.json({ error: "Missing required headers: X-Filename, Content-Length" }, 400);
    }

    const size = parseInt(contentLength, 10);
    if (isNaN(size) || size <= 0) {
      return c.json({ error: "Invalid Content-Length" }, 400);
    }

    const body = c.req.raw.body;
    if (!body) {
      return c.json({ error: "Missing request body" }, 400);
    }

    const contentType = c.req.header("Content-Type") || "application/octet-stream";
    const contentEncoding = c.req.header("Content-Encoding") || undefined;
    const originalSizeHeader = c.req.header("X-Original-Size");
    const originalSize = originalSizeHeader ? parseInt(originalSizeHeader, 10) : undefined;
    const skipExtraction = c.req.header("X-Skip-Extraction") === "true";

    const jobs = c.get("jobs");
    const sessionId = c.get("sessionId");
    const extractionQueue = c.get("extractionQueue");

    try {
      const result = await uploadAsset(
        metadata,
        storage,
        jobs,
        { name: filename, type: contentType, body, size, contentEncoding, originalSize },
        ttlSeconds,
        baseUrl,
        { sessionId, extractionQueue, skipExtraction },
      );
      return c.json(result, 201);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (msg.includes("exceeds") || msg.includes("FixedLengthStream")) {
        return c.json({ error: "Request body exceeds declared Content-Length" }, 400);
      }
      throw e;
    }
  });
}
