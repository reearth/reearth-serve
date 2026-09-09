import type { Hono } from "hono";
import { describeRoute } from "hono-openapi";
import { resolver, validator as zValidator } from "hono-openapi";
import type { AppEnv } from "../../types";
import { createUploadSession } from "../usecase";
import { denyAnonymousUpload, resolveUploadProject } from "./shared";
import {
  uploadSessionResponseSchema, errorResponseSchema,
  createUploadSessionBodySchema,
} from "../../../shared/openapi";

export function registerCreateUploadSessionRoute(app: Hono<AppEnv>) {
  app.post("/uploads",
    describeRoute({
      tags: ["Assets"],
      summary: "Create upload session with presigned URL",
      responses: {
        201: { description: "Upload session created", content: { "application/json": { schema: resolver(uploadSessionResponseSchema) } } },
        400: { description: "Bad request", content: { "application/json": { schema: resolver(errorResponseSchema) } } },
        501: { description: "Presigned uploads not available", content: { "application/json": { schema: resolver(errorResponseSchema) } } },
      },
    }),
    zValidator("json", createUploadSessionBodySchema),
    async (c) => {
      const denied = denyAnonymousUpload(c);
      if (denied) return denied;

      const presignedUrls = c.get("presignedUrls");
      if (!presignedUrls) {
        return c.json({ error: "Presigned URL uploads not available. Use POST /api/v1/assets for direct upload." }, 501);
      }

      const body = c.req.valid("json");

      const sessions = c.get("uploadSessions");
      const ttlSeconds = c.get("ttlSeconds");
      const sessionId = c.get("sessionId");

      const projectResult = await resolveUploadProject(c);
      if (!projectResult.ok) {
        return c.json({ error: projectResult.error }, projectResult.status);
      }

      const result = await createUploadSession(sessions, presignedUrls, {
        filename: body.filename,
        contentType: body.contentType || "application/octet-stream",
        size: body.size,
        partCount: body.partCount,
      }, ttlSeconds, { sessionId, projectId: projectResult.projectId });

      return c.json(result, 201);
    },
  );
}
