import type { Hono } from "hono";
import { describeRoute } from "hono-openapi";
import type { AppEnv } from "../../types";
import { uploadAsset } from "../usecase";
import { denyAnonymousUpload, resolveUploadProject, usageScopes } from "./shared";
import { assetUploadResultExamples } from "../../openapi-examples";
import { uploadResultResponseSchema } from "../../../shared/openapi";
import { isSafeFilename } from "../../../shared/api";
import { contentEncodingHeaderParam, contentLengthHeaderParam, filenameHeaderParam, jsonError, jsonResponse, originalSizeHeaderParam, projectIdHeaderParam, skipExtractionHeaderParam } from "../../openapi";

export function registerUploadRoute(app: Hono<AppEnv>) {
  app.post("/",
    describeRoute({
      tags: ["Assets"],
      summary: "Upload a file (direct streaming)",
      description: "Upload a file using streaming body. Set filename via X-Filename header.",
      parameters: [
        filenameHeaderParam,
        contentLengthHeaderParam,
        contentEncodingHeaderParam,
        originalSizeHeaderParam,
        skipExtractionHeaderParam,
        projectIdHeaderParam,
      ],
      requestBody: {
        required: true,
        description: "Raw file bytes. Any Content-Type is accepted and stored as the asset's content type (default application/octet-stream).",
        content: { "*/*": { schema: { type: "string", format: "binary" } } },
      },
      responses: {
        201: jsonResponse("Upload result", uploadResultResponseSchema, assetUploadResultExamples),
        400: jsonError("Bad request (missing/invalid headers, or X-Project-Id missing for an authenticated caller)"),
        401: jsonError("Anonymous upload disabled, or invalid token / session ID"),
        404: jsonError("Project not found"),
        413: jsonError("Upload exceeds storage capacity"),
      },
    }),
    async (c) => {
    const denied = denyAnonymousUpload(c);
    if (denied) return denied;

    const writes = c.get("writes");
    const storage = c.get("storage");
    const ttlSeconds = c.get("ttlSeconds");
    const baseUrl = c.get("baseUrl");

    const filename = c.req.header("X-Filename");
    const contentLength = c.req.header("Content-Length");
    if (!filename || !contentLength) {
      return c.json({ error: "Missing required headers: X-Filename, Content-Length" }, 400);
    }

    if (!isSafeFilename(filename)) {
      return c.json({ error: "Invalid X-Filename" }, 400);
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

    const sessionId = c.get("sessionId");
    const extractionQueue = c.get("extractionQueue");
    const thumbnailQueue = c.get("thumbnailQueue");

    const projectResult = await resolveUploadProject(c);
    if (!projectResult.ok) {
      return c.json({ error: projectResult.error }, projectResult.status);
    }
    const projectId = projectResult.projectId;

    // Resolved up front so the counters ride along in the upload's batch.
    const scopes = await usageScopes(c, projectId);

    try {
      const result = await uploadAsset(
        writes,
        storage,
        { name: filename, type: contentType, body, size, contentEncoding, originalSize },
        ttlSeconds,
        baseUrl,
        { sessionId, projectId, extractionQueue, thumbnailQueue, skipExtraction, usageScopes: scopes },
      );

      return c.json(result, 201);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (msg.includes("exceeds storage capacity")) {
        return c.json({ error: "Upload exceeds storage capacity" }, 413);
      }
      // "declared Content-Length" is what a FileStorage adapter says when the
      // body does not match the header; "FixedLengthStream" is R2's own
      // wording, kept so the Cloudflare path keeps returning 400 as before.
      if (
        msg.includes("declared Content-Length") ||
        msg.includes("exceeds") ||
        msg.includes("FixedLengthStream")
      ) {
        return c.json({ error: "Request body exceeds declared Content-Length" }, 400);
      }
      throw e;
    }
  });
}
