import { Hono } from "hono";
import type { AppEnv } from "../types";
import { uploadAsset, getAssetMetadata, deleteAsset, createUploadSession, completeUploadSession } from "./usecase";

export const assetRoutes = new Hono<AppEnv>();

// POST /api/v1/assets/uploads — create upload session with presigned URL(s)
assetRoutes.post("/uploads", async (c) => {
  const presignedUrls = c.get("presignedUrls");
  if (!presignedUrls) {
    return c.json({ error: "Presigned URL uploads not available. Use POST /api/v1/assets for direct upload." }, 501);
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

// POST /api/v1/assets/uploads/:id/complete — confirm upload and create asset
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

  const jobs = c.get("jobs");
  const sessionId = c.get("sessionId");
  const extractionQueue = c.get("extractionQueue");
  const result = await completeUploadSession(sessions, metadata, storage, presignedUrls, jobs, id, ttlSeconds, baseUrl, parts, { sessionId, extractionQueue });
  if (!result) {
    return c.json({ error: "Upload session not found or file not yet uploaded" }, 404);
  }

  return c.json(result, 201);
});

// POST /api/v1/assets — upload a file (direct, streaming)
// Headers: Content-Type (file type), X-Filename (filename), Content-Length (size)
// Optional: Content-Encoding: gzip, X-Original-Size (uncompressed size)
assetRoutes.post("/", async (c) => {
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
      { sessionId, extractionQueue },
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

// GET /api/v1/assets/:id/files — list files in asset (NDJSON stream)
// Query params: ?prefix=path/prefix
assetRoutes.get("/:id/files", async (c) => {
  const metadata = c.get("metadata");
  const storage = c.get("storage");
  const id = c.req.param("id");
  const prefix = c.req.query("prefix") || "";

  const asset = await getAssetMetadata(metadata, id);
  if (!asset) {
    return c.json({ error: "Asset not found" }, 404);
  }

  const ndjsonHeaders = {
    "Content-Type": "application/x-ndjson",
    "Transfer-Encoding": "chunked",
  };
  const encoder = new TextEncoder();

  // Non-archive asset: emit single entry
  if (asset.type !== "archive") {
    if (!prefix || asset.filename.startsWith(prefix)) {
      // Get ETag from storage for hash
      const storageKey = `assets/${id}/${asset.filename}`;
      const head = await storage.head(storageKey);
      const hash = head?.etag ? `md5:${head.etag.replace(/"/g, "")}` : undefined;
      const entry = { path: asset.filename, size: asset.size, contentType: asset.contentType, ...(hash && { hash }) };
      const body = new ReadableStream({
        start(controller) {
          controller.enqueue(encoder.encode(JSON.stringify(entry) + "\n"));
          controller.close();
        },
      });
      return new Response(body, { status: 200, headers: ndjsonHeaders });
    }
    // No match
    return new Response("", { status: 200, headers: ndjsonHeaders });
  }

  // Archive: stream manifest from R2, filtering by prefix
  const manifestKey = `assets/${id}/_archive/_manifest.jsonl`;
  const manifestFile = await storage.get(manifestKey);
  if (!manifestFile) {
    return new Response("", { status: 200, headers: ndjsonHeaders });
  }

  // Stream-transform: read manifest line by line, filter by prefix, forward
  const body = manifestFile.body
    .pipeThrough(new TextDecoderStream())
    .pipeThrough(filterNdjsonByPrefix(prefix))
    .pipeThrough(new TextEncoderStream());

  return new Response(body, { status: 200, headers: ndjsonHeaders });
});

function filterNdjsonByPrefix(prefix: string): TransformStream<string, string> {
  let buffer = "";
  return new TransformStream({
    transform(chunk, controller) {
      buffer += chunk;
      const lines = buffer.split("\n");
      buffer = lines.pop()!; // keep incomplete last line
      for (const line of lines) {
        if (!line) continue;
        if (!prefix) {
          controller.enqueue(line + "\n");
          continue;
        }
        try {
          const entry = JSON.parse(line) as { path: string };
          if (entry.path.startsWith(prefix)) {
            controller.enqueue(line + "\n");
          }
        } catch {
          // skip malformed lines
        }
      }
    },
    flush(controller) {
      if (!buffer) return;
      if (!prefix) {
        controller.enqueue(buffer + "\n");
        return;
      }
      try {
        const entry = JSON.parse(buffer) as { path: string };
        if (entry.path.startsWith(prefix)) {
          controller.enqueue(buffer + "\n");
        }
      } catch {
        // skip
      }
    },
  });
}

// GET /api/v1/assets — list assets
// Query params: ?limit=20&cursor=xxx
assetRoutes.get("/", async (c) => {
  const metadata = c.get("metadata");
  const limit = parseInt(c.req.query("limit") || "20", 10);
  const cursor = c.req.query("cursor") || undefined;

  const result = await metadata.list({ limit: Math.min(limit, 100), cursor });
  return c.json({ assets: result.items, cursor: result.cursor });
});

// GET /api/v1/assets/:id — get metadata
assetRoutes.get("/:id", async (c) => {
  const metadata = c.get("metadata");
  const id = c.req.param("id");

  const asset = await getAssetMetadata(metadata, id);
  if (!asset) {
    return c.json({ error: "Asset not found" }, 404);
  }

  return c.json({ asset });
});

// DELETE /api/v1/assets/:id — delete asset
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
