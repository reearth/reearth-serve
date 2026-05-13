import type { Hono } from "hono";
import { describeRoute } from "hono-openapi";
import { resolver, validator as zValidator } from "hono-openapi";
import type { AppEnv } from "../../types";
import { getAssetMetadata, uploadVersion } from "../usecase";
import { canAccessAsset } from "../access";
import { accessCtx, denyAnonymousUpload } from "./shared";
import { versionResponseSchema, errorResponseSchema, idParamSchema } from "../../../shared/openapi";

export function registerUploadVersionRoute(app: Hono<AppEnv>) {
  app.post("/:id",
    describeRoute({
      tags: ["Versions"],
      summary: "Upload new version to existing asset",
      description: "Upload a new version via streaming body. Same headers as asset upload.",
      parameters: [
        { name: "X-Filename", in: "header", required: true, schema: { type: "string" }, description: "Filename" },
        { name: "Content-Length", in: "header", required: true, schema: { type: "integer" }, description: "File size" },
        { name: "Content-Encoding", in: "header", required: false, schema: { type: "string", enum: ["gzip"] } },
        { name: "X-Original-Size", in: "header", required: false, schema: { type: "integer" } },
        { name: "X-Skip-Extraction", in: "header", required: false, schema: { type: "string", enum: ["true"] } },
      ],
      requestBody: {
        content: { "application/octet-stream": { schema: { type: "string", format: "binary" } } },
      },
      responses: {
        201: { description: "Version created", content: { "application/json": { schema: resolver(versionResponseSchema) } } },
        400: { description: "Bad request", content: { "application/json": { schema: resolver(errorResponseSchema) } } },
        404: { description: "Asset not found", content: { "application/json": { schema: resolver(errorResponseSchema) } } },
      },
    }),
    zValidator("param", idParamSchema),
    async (c) => {
      const denied = denyAnonymousUpload(c);
      if (denied) return denied;

      const metadata = c.get("metadata");
      const versions = c.get("versions");
      const storage = c.get("storage");
      const jobs = c.get("jobs");
      const baseUrl = c.get("baseUrl");
      const { id } = c.req.valid("param");

      const asset = await getAssetMetadata(metadata, id);
      if (!asset || !await canAccessAsset(asset, accessCtx(c), "create")) {
        return c.json({ error: "Asset not found" }, 404);
      }

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

      const contentEncoding = c.req.header("Content-Encoding") || undefined;
      const originalSizeHeader = c.req.header("X-Original-Size");
      const originalSize = originalSizeHeader ? parseInt(originalSizeHeader, 10) : undefined;
      const skipExtraction = c.req.header("X-Skip-Extraction") === "true";
      const extractionQueue = c.get("extractionQueue");

      const result = await uploadVersion(
        metadata, versions, storage, jobs, id,
        { name: filename, type: c.req.header("Content-Type") || "application/octet-stream", body, size, contentEncoding, originalSize },
        baseUrl,
        { extractionQueue, skipExtraction },
      );

      if (!result) {
        return c.json({ error: "Asset not found" }, 404);
      }

      // Update storage usage
      if (asset.projectId) {
        const storageUsage = c.get("storageUsage");
        const projects = c.get("projects");
        await storageUsage.increment(`project:${asset.projectId}`, result.version.size);
        const project = await projects.find(asset.projectId);
        if (project?.workspaceId) {
          await storageUsage.increment(`workspace:${project.workspaceId}`, result.version.size);
        }
      }

      return c.json({ version: result.version, url: result.url }, 201);
    },
  );
}
