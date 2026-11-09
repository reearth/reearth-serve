import type { Hono } from "hono";
import { describeRoute } from "hono-openapi";
import { validator as zValidator } from "hono-openapi";
import type { AppEnv } from "../../types";
import { toVersionResponse } from "../response";
import { getAssetMetadata, uploadVersion } from "../usecase";
import { accessCtx, authorizeAsset, deniedResponse } from "../../auth/access";
import { blobContext, denyAnonymousUpload, parseDirectUploadHeaders, usageScopes } from "./shared";
import { versionUploadResultResponseSchema, idParamSchema } from "../../../shared/openapi";
import { uploadErrorResponse } from "./errors";
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
        409: jsonError("The asset's first upload is still being verified against its declared SHA-256 (`code: upload_under_verification`), or the stored copy this upload matched was deleted while it was in progress (`code: blob_unavailable`); upload again later"),
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

      const parsed = parseDirectUploadHeaders(c);
      if (!parsed.ok) return c.json({ error: parsed.error }, 400);
      const { filename, size, sha256, body } = parsed;

      const contentEncoding = c.req.header("Content-Encoding") || undefined;
      const originalSizeHeader = c.req.header("X-Original-Size");
      const originalSize = originalSizeHeader ? parseInt(originalSizeHeader, 10) : undefined;
      const skipExtraction = c.req.header("X-Skip-Extraction") === "true";
      const extractionQueue = c.get("extractionQueue");
      const thumbnailQueue = c.get("thumbnailQueue");

      // Resolved up front so the counters ride along in the version's batch.
      const scopes = await usageScopes(c, asset.projectId);
      const blob = await blobContext(c, asset.projectId, sha256);

      const result = await uploadVersion(
        metadata, writes, storage, id,
        { name: filename, type: c.req.header("Content-Type") || "application/octet-stream", body, size, contentEncoding, originalSize, sha256 },
        baseUrl,
        { extractionQueue, thumbnailQueue, skipExtraction, usageScopes: scopes, siteHostSuffix: c.get("siteHostSuffix"), blob },
      ).catch((e: unknown) => {
        const known = uploadErrorResponse(e);
        if (known) return known;
        if (e instanceof Error && e.message.includes("exceeds storage capacity")) return "over-capacity" as const;
        throw e;
      });
      if (typeof result === "object" && result && "status" in result) return c.json(result.body, result.status);
      if (result === "over-capacity") {
        return c.json({ error: "Upload exceeds storage capacity" }, 413);
      }

      if (!result) {
        return c.json({ error: "Asset not found" }, 404);
      }

      return c.json(
        { version: toVersionResponse(result.version), url: result.url, ...(result.siteUrl && { siteUrl: result.siteUrl }) },
        201,
      );
    },
  );
}
