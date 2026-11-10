import type { Hono } from "hono";
import { describeRoute } from "hono-openapi";
import { validator as zValidator } from "hono-openapi";
import type { AppEnv } from "../../types";
import { createUploadSession } from "../usecase";
import { createUploadSessionExamples, uploadSessionExamples } from "../../openapi-examples";
import { denyAnonymousUpload, resolveUploadProject } from "./shared";
import { blobScopeFor } from "../../blob/usecase";
import {
  uploadSessionResponseSchema, createUploadSessionBodySchema,
} from "../../../shared/openapi";
import { jsonError, jsonResponse, projectIdHeaderParam, schemaRef } from "../../openapi";

export function registerCreateUploadSessionRoute(app: Hono<AppEnv>) {
  app.post("/uploads",
    zValidator("json", createUploadSessionBodySchema),
    // After the validator on purpose: hono-openapi merges route docs in
    // middleware order, so the validator's generated requestBody would
    // otherwise replace the examples below. describeRoute only calls next().
    describeRoute({
      tags: ["Assets"],
      summary: "Create upload session with presigned URL",
      description: "Step 1 of a presigned upload. Without `partCount` (or with 1) the response is a single presigned PUT URL; with `partCount` > 1 it is one URL per part (multipart). An optional `contentEncoding` states the encoding the client will upload (`gzip`: it gzips the file itself; `identity`: as is); the server stores exactly that and the response's `contentEncoding` echoes it. Omitted, the server decides by file name and size and says so in the response. An optional `sha256` declares the hash of the bytes to be stored (after gzip when the response says `contentEncoding: gzip`; a client that declares a hash should state `contentEncoding` so it never has to predict the server): on a single PUT it is signed into the URL, the client must send every header in the response's `headers` (including `x-amz-checksum-sha256`), and the store rejects a body that does not match; on multipart it is recorded and the version stays `integrity: pending` until verified. Every session issues upload URLs and expects the whole file, whatever the workspace already stores; the key the URLs name never depends on it. Upload the bytes straight to storage, then call `POST /api/v1/assets/uploads/{id}/complete`.",
      parameters: [projectIdHeaderParam],
      requestBody: {
        required: true,
        content: { "application/json": { schema: schemaRef(createUploadSessionBodySchema), examples: createUploadSessionExamples } },
      },
      responses: {
        201: jsonResponse("Upload session created", uploadSessionResponseSchema, uploadSessionExamples),
        400: jsonError("Bad request (invalid body, or X-Project-Id missing for an authenticated caller)"),
        401: jsonError("Anonymous upload disabled, or invalid token / session ID"),
        404: jsonError("Project not found"),
        501: jsonError("Presigned uploads not available"),
      },
    }),
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

      const sha256 = body.sha256?.toLowerCase();
      const blobScope = sha256 ? await blobScopeFor(c.get("projects"), projectResult.projectId, sessionId) : null;
      const result = await createUploadSession(sessions, presignedUrls, {
        filename: body.filename,
        contentType: body.contentType || "application/octet-stream",
        size: body.size,
        partCount: body.partCount,
        sha256: body.sha256,
        contentEncoding: body.contentEncoding,
      }, ttlSeconds, {
        sessionId, projectId: projectResult.projectId, blobScope,
        ...(body.skipExtraction && { skipExtraction: true }),
      });
      return c.json(result, 201);
    },
  );
}
