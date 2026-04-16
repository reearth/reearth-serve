import type { Hono } from "hono";
import { describeRoute } from "hono-openapi";
import { resolver, validator as zValidator } from "hono-openapi";
import type { AppEnv } from "../../types";
import { completeUploadSession } from "../usecase";
import { canAccessProject } from "../access";
import { accessCtx } from "./shared";
import { uploadResultResponseSchema, errorResponseSchema, idParamSchema, completeUploadBodySchema } from "../../../shared/openapi";

export function registerCompleteUploadSessionRoute(app: Hono<AppEnv>) {
  app.post("/uploads/:id/complete",
    describeRoute({
      tags: ["Assets"],
      summary: "Complete upload session",
      description: "Confirm upload and create asset. For multipart uploads, send parts with ETags in JSON body.",
      responses: {
        201: { description: "Upload completed", content: { "application/json": { schema: resolver(uploadResultResponseSchema) } } },
        404: { description: "Upload session not found", content: { "application/json": { schema: resolver(errorResponseSchema) } } },
      },
    }),
    zValidator("param", idParamSchema),
    async (c) => {
    const sessions = c.get("uploadSessions");
    const metadata = c.get("metadata");
    const storage = c.get("storage");
    const presignedUrls = c.get("presignedUrls");
    const ttlSeconds = c.get("ttlSeconds");
    const baseUrl = c.get("baseUrl");
    const { id } = c.req.valid("param");

    // Re-verify that the completer still has access to the project the session
    // was created for. createUploadSession stamped the projectId after a
    // membership check; revisiting here closes the window where access could
    // have been revoked before completion.
    const session = await sessions.find(id);
    if (!session) {
      return c.json({ error: "Upload session not found or file not yet uploaded" }, 404);
    }
    if (session.projectId) {
      const allowed = await canAccessProject(accessCtx(c), session.projectId, "upload");
      if (!allowed) {
        return c.json({ error: "Upload session not found or file not yet uploaded" }, 404);
      }
    }

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
  });
}
