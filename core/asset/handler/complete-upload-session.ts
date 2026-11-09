import type { Hono } from "hono";
import { describeRoute } from "hono-openapi";
import { validator as zValidator } from "hono-openapi";
import type { AppEnv } from "../../types";
import { toUploadResponse } from "../response";
import { completeUploadSession } from "../usecase";
import { accessCtx, authorizeProject } from "../../auth/access";
import { usageScopes } from "./shared";
import { assetUploadResultExamples, completeUploadExamples } from "../../openapi-examples";
import { completeUploadBodySchema, uploadResultResponseSchema, idParamSchema } from "../../../shared/openapi";
import { jsonError, jsonResponse, schemaRef } from "../../openapi";
import { ChecksumMismatchError } from "../../asset/integrity";


export function registerCompleteUploadSessionRoute(app: Hono<AppEnv>) {
  app.post("/uploads/:id/complete",
    describeRoute({
      tags: ["Assets"],
      summary: "Complete upload session",
      description: "Confirm upload and create asset. For multipart uploads, send parts with ETags in JSON body.",
      requestBody: {
        required: false,
        description: "Only read when Content-Type is application/json. Required for multipart sessions.",
        // This route parses its body by hand (no validator), so it points at the
        // named component directly; core/openapi.ts emits it from the registry.
        content: { "application/json": { schema: schemaRef(completeUploadBodySchema), examples: completeUploadExamples } },
      },
      responses: {
        201: jsonResponse("Upload completed", uploadResultResponseSchema, assetUploadResultExamples),
        404: jsonError("Upload session not found"),
        422: jsonError("Declared SHA-256 does not match the uploaded bytes; nothing was stored"),
      },
    }),
    zValidator("param", idParamSchema),
    async (c) => {
    const sessions = c.get("uploadSessions");
    const writes = c.get("writes");
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
      const access = await authorizeProject(accessCtx(c), session.projectId, "create_asset");
      if (!access.ok) {
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

    const sessionId = c.get("sessionId");
    const extractionQueue = c.get("extractionQueue");
    const thumbnailQueue = c.get("thumbnailQueue");
    // Resolved up front so the counters ride along in the asset's batch.
    const scopes = await usageScopes(c, session.projectId);
    let result;
    try {
      result = await completeUploadSession(sessions, writes, c.get("metadata"), storage, presignedUrls, id, ttlSeconds, baseUrl, parts, { sessionId, extractionQueue, verificationQueue: c.get("verificationQueue"), thumbnailQueue, usageScopes: scopes, siteHostSuffix: c.get("siteHostSuffix"), blobRefs: c.get("blobRefs") });
    } catch (e) {
      if (e instanceof ChecksumMismatchError) {
        return c.json({ error: "Declared SHA-256 does not match the uploaded bytes; nothing was stored" }, 422);
      }
      throw e;
    }
    if (!result) {
      return c.json({ error: "Upload session not found or file not yet uploaded" }, 404);
    }

    return c.json(toUploadResponse(result), 201);
  });
}
