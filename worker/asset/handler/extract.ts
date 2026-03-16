import type { Hono } from "hono";
import { describeRoute } from "hono-openapi";
import { resolver, validator as zValidator } from "hono-openapi";
import type { AppEnv } from "../../types";
import { getAssetMetadata } from "../usecase";
import { canAccessAsset } from "../access";
import { accessCtx } from "./shared";
import { jobResponseSchema, errorResponseSchema, idParamSchema } from "../../../shared/openapi";

export function registerExtractRoute(app: Hono<AppEnv>) {
  app.post("/:id/extract",
    describeRoute({
      tags: ["Assets"],
      summary: "Start archive extraction",
      responses: {
        200: { description: "Existing extraction job", content: { "application/json": { schema: resolver(jobResponseSchema) } } },
        201: { description: "Extraction job created", content: { "application/json": { schema: resolver(jobResponseSchema) } } },
        400: { description: "Bad request", content: { "application/json": { schema: resolver(errorResponseSchema) } } },
        404: { description: "Asset not found", content: { "application/json": { schema: resolver(errorResponseSchema) } } },
      },
    }),
    zValidator("param", idParamSchema),
    async (c) => {
      const metadata = c.get("metadata");
      const jobs = c.get("jobs");
      const extractionQueue = c.get("extractionQueue");
      const { id } = c.req.valid("param");

    const asset = await getAssetMetadata(metadata, id);
    if (!asset || !await canAccessAsset(asset, accessCtx(c), "extract")) {
      return c.json({ error: "Asset not found" }, 404);
    }

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
    await jobs.save(job);

    // Update asset status
    asset.status = "pending";
    asset.jobId = id;
    const ttlSeconds = c.get("ttlSeconds");
    await metadata.save(asset, ttlSeconds);

    // Enqueue
    if (extractionQueue) {
      const key = `assets/${id}/${asset.filename}`;
      await extractionQueue.send({
        assetId: id,
        archiveKey: key,
        archiveFilename: asset.filename,
        archiveFormat: asset.archiveFormat,
      });
    }

    return c.json({ job }, 201);
  });
}
