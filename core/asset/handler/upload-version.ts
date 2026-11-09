import type { Hono } from "hono";
import { describeRoute } from "hono-openapi";
import { validator as zValidator } from "hono-openapi";
import type { AppEnv } from "../../types";
import { getAssetMetadata, uploadVersion } from "../usecase";
import { accessCtx, authorizeAsset, deniedResponse } from "../../auth/access";
import { denyAnonymousUpload, usageScopes } from "./shared";
import { versionUploadResultResponseSchema, idParamSchema } from "../../../shared/openapi";
import { isSafeFilename } from "../../../shared/api";
import { ChecksumMismatchError, CONTENT_SHA256_HEADER, parseSha256Header, UPLOAD_UNDER_VERIFICATION_MESSAGE, UploadUnderVerificationError } from "../../asset/integrity";
import { contentEncodingHeaderParam, contentLengthHeaderParam, contentSha256HeaderParam, filenameHeaderParam, jsonError, jsonResponse, originalSizeHeaderParam, skipExtractionHeaderParam } from "../../openapi";

export function registerUploadVersionRoute(app: Hono<AppEnv>) {
  app.post("/:id",
    describeRoute({
      tags: ["Versions"],
      summary: "Upload new version to existing asset",
      description: "Upload a new version via streaming body. Same headers as asset upload.",
      parameters: [
        filenameHeaderParam,
        contentLengthHeaderParam,
        contentEncodingHeaderParam,
        originalSizeHeaderParam,
        skipExtractionHeaderParam,
        contentSha256HeaderParam,
      ],
      requestBody: {
        required: true,
        description: "Raw file bytes. Any Content-Type is accepted and stored as the asset's content type (default application/octet-stream).",
        content: { "*/*": { schema: { type: "string", format: "binary" } } },
      },
      responses: {
        201: jsonResponse("Version created", versionUploadResultResponseSchema),
        400: jsonError("Bad request"),
        401: jsonError("Anonymous upload disabled, or invalid token / session ID"),
        404: jsonError("Asset not found"),
        413: jsonError("Upload exceeds storage capacity"),
        409: jsonError(UPLOAD_UNDER_VERIFICATION_MESSAGE),
        422: jsonError("Declared SHA-256 does not match the uploaded bytes; nothing was stored"),
      },
    }),
    zValidator("param", idParamSchema),
    async (c) => {
      const denied = denyAnonymousUpload(c);
      if (denied) return denied;

      const metadata = c.get("metadata");
      const writes = c.get("writes");
      const storage = c.get("storage");
      const baseUrl = c.get("baseUrl");
      const { id } = c.req.valid("param");

      const access = await authorizeAsset(accessCtx(c), await getAssetMetadata(metadata, id), "create_asset");
      if (!access.ok) return deniedResponse(c, access, { notFound: "Asset not found" });
      const asset = access.value;

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

      const sha256 = parseSha256Header(c.req.header(CONTENT_SHA256_HEADER));
      if (sha256 === "invalid") {
        return c.json({ error: `Invalid ${CONTENT_SHA256_HEADER}: expected 64 hex characters` }, 400);
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
      const thumbnailQueue = c.get("thumbnailQueue");

      // Resolved up front so the counters ride along in the version's batch.
      const scopes = await usageScopes(c, asset.projectId);

      const result = await uploadVersion(
        metadata, writes, storage, id,
        { name: filename, type: c.req.header("Content-Type") || "application/octet-stream", body, size, contentEncoding, originalSize, sha256 },
        baseUrl,
        { extractionQueue, thumbnailQueue, skipExtraction, usageScopes: scopes, siteHostSuffix: c.get("siteHostSuffix") },
      ).catch((e: unknown) => {
        if (e instanceof ChecksumMismatchError) return "checksum-mismatch" as const;
        if (e instanceof UploadUnderVerificationError) return "under-verification" as const;
        if (e instanceof Error && e.message.includes("exceeds storage capacity")) return "over-capacity" as const;
        throw e;
      });
      if (result === "checksum-mismatch") {
        return c.json({ error: "Declared SHA-256 does not match the uploaded bytes; nothing was stored" }, 422);
      }
      if (result === "under-verification") {
        return c.json({ error: UPLOAD_UNDER_VERIFICATION_MESSAGE }, 409);
      }
      if (result === "over-capacity") {
        return c.json({ error: "Upload exceeds storage capacity" }, 413);
      }

      if (!result) {
        return c.json({ error: "Asset not found" }, 404);
      }

      return c.json(
        { version: result.version, url: result.url, ...(result.siteUrl && { siteUrl: result.siteUrl }) },
        201,
      );
    },
  );
}
