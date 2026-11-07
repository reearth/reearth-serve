import type { Hono } from "hono";
import { describeRoute } from "hono-openapi";
import { validator as zValidator } from "hono-openapi";
import type { AppEnv } from "../../types";
import { getAssetMetadata } from "../usecase";
import { accessCtx, authorizeAsset, deniedResponse } from "../../auth/access";
import { denyAnonymousUpload } from "./shared";
import { jobResponseSchema, idParamSchema } from "../../../shared/openapi";
import { jsonError, jsonResponse } from "../../openapi";

export function registerExtractRoute(app: Hono<AppEnv>) {
  app.post("/:id/extract",
    describeRoute({
      tags: ["Assets"],
      summary: "Start archive extraction",
      responses: {
        200: jsonResponse("Existing extraction job", jobResponseSchema),
        201: jsonResponse("Extraction job created", jobResponseSchema),
        400: jsonError("Bad request"),
        404: jsonError("Asset not found"),
      },
    }),
    zValidator("param", idParamSchema),
    async (c) => {
      const denied = denyAnonymousUpload(c);
      if (denied) return denied;

      const metadata = c.get("metadata");
      const jobs = c.get("jobs");
      const extractionQueue = c.get("extractionQueue");
      const { id } = c.req.valid("param");

    const access = await authorizeAsset(accessCtx(c), await getAssetMetadata(metadata, id), "extract_asset");
    if (!access.ok) return deniedResponse(c, access, { notFound: "Asset not found" });
    const asset = access.value;

    if (asset.type !== "archive" || !asset.archiveFormat) {
      return c.json({ error: "Asset is not an archive" }, 400);
    }

    if (asset.status === "ready") {
      return c.json({ error: "Archive already extracted" }, 400);
    }

    // If a job already exists and is pending/running, return it
    if (asset.jobId) {
      const existingJob = await jobs.find(asset.jobId);
      if (existingJob && (existingJob.status === "pending" || existingJob.status === "running")) {
        return c.json({ job: existingJob });
      }
    }

    // Create new extraction job
    const now = Date.now();
    const sessionId = c.get("sessionId");
    const job = {
      id,
      assetId: id,
      type: "archive-extraction" as const,
      status: "pending" as const,
      createdAt: now,
      updatedAt: now,
      ...(sessionId && { sessionId }),
      ...(asset.projectId && { projectId: asset.projectId }),
    };
    // Update asset status
    asset.status = "pending";
    asset.jobId = id;
    // Job row and its asset mirror in one atomic write (ADR-012 §3).
    await c.get("writes").saveJob({ job, asset });

    // Enqueue
    if (extractionQueue) {
      const key = `assets/${id}/${asset.filename}`;
      await extractionQueue.send({
        jobId: id,
        assetId: id,
        archiveKey: key,
        archiveFilename: asset.filename,
        archiveFormat: asset.archiveFormat,
      });
    }

    return c.json({ job }, 201);
  });
}
