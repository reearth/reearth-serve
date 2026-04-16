import type { Hono } from "hono";
import { describeRoute } from "hono-openapi";
import { resolver } from "hono-openapi";
import type { AppEnv } from "../../types";
import { uploadAsset } from "../usecase";
import { resolveUploadProject } from "./shared";
import { uploadResultResponseSchema, errorResponseSchema } from "../../../shared/openapi";

export function registerUploadRoute(app: Hono<AppEnv>) {
  app.post("/",
    describeRoute({
      tags: ["Assets"],
      summary: "Upload a file (direct streaming)",
      description: "Upload a file using streaming body. Set filename via X-Filename header.",
      parameters: [
        { name: "X-Filename", in: "header", required: true, schema: { type: "string" }, description: "Filename of the uploaded file" },
        { name: "Content-Length", in: "header", required: true, schema: { type: "integer" }, description: "File size in bytes" },
        { name: "Content-Encoding", in: "header", required: false, schema: { type: "string", enum: ["gzip"] }, description: "Set to 'gzip' for pre-compressed uploads" },
        { name: "X-Original-Size", in: "header", required: false, schema: { type: "integer" }, description: "Original uncompressed size (when Content-Encoding: gzip)" },
        { name: "X-Skip-Extraction", in: "header", required: false, schema: { type: "string", enum: ["true"] }, description: "Skip archive extraction" },
      ],
      requestBody: {
        content: { "application/octet-stream": { schema: { type: "string", format: "binary" } } },
      },
      responses: {
        201: { description: "Upload result", content: { "application/json": { schema: resolver(uploadResultResponseSchema) } } },
        400: { description: "Bad request", content: { "application/json": { schema: resolver(errorResponseSchema) } } },
      },
    }),
    async (c) => {
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

    const projectResult = await resolveUploadProject(c);
    if (!projectResult.ok) {
      return c.json({ error: projectResult.error }, projectResult.status);
    }
    const projectId = projectResult.projectId;

    try {
      const result = await uploadAsset(
        metadata,
        storage,
        jobs,
        { name: filename, type: contentType, body, size, contentEncoding, originalSize },
        ttlSeconds,
        baseUrl,
        { sessionId, projectId, extractionQueue, skipExtraction },
      );

      // Update storage usage counters for project assets
      if (result.asset.projectId) {
        const storageUsage = c.get("storageUsage");
        const projects = c.get("projects");
        await storageUsage.increment(`project:${result.asset.projectId}`, result.asset.size);
        const project = await projects.find(result.asset.projectId);
        if (project?.workspaceId) {
          await storageUsage.increment(`workspace:${project.workspaceId}`, result.asset.size);
        }
      }

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
