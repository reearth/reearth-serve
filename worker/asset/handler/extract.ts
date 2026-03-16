import type { Hono } from "hono";
import type { AppEnv } from "../../types";
import { getAssetMetadata } from "../usecase";
import { canAccessAsset } from "../access";
import { accessCtx } from "./shared";

export function registerExtractRoute(app: Hono<AppEnv>) {
  // POST /api/v1/assets/:id/extract — start archive extraction
  app.post("/:id/extract", async (c) => {
    const metadata = c.get("metadata");
    const jobs = c.get("jobs");
    const extractionQueue = c.get("extractionQueue");
    const id = c.req.param("id");

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
