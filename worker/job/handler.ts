import { Hono } from "hono";
import type { Context } from "hono";
import type { AppEnv } from "../types";
import { canAccessJob, type AccessContext } from "../asset/access";

function accessCtx(c: Context<AppEnv>): AccessContext {
  return {
    sessionId: c.get("sessionId"),
    user: c.get("user"),
    authorizer: c.get("authorizer"),
    members: c.get("members"),
    projects: c.get("projects"),
  };
}

// --- Public API routes (mounted at /api/v1/jobs) ---

export const jobRoutes = new Hono<AppEnv>();

// GET /api/v1/jobs — List jobs
jobRoutes.get("/", async (c) => {
  const jobs = c.get("jobs");
  const user = c.get("user");
  const sessionId = c.get("sessionId");
  const limit = parseInt(c.req.query("limit") || "20", 10);
  const cursor = c.req.query("cursor") || undefined;

  const result = await jobs.list({
    limit: Math.min(limit, 100),
    cursor,
    ...(!user && sessionId ? { sessionId } : {}),
  });
  return c.json({ jobs: result.items, cursor: result.cursor });
});

// GET /api/v1/jobs/:id — Get job progress
jobRoutes.get("/:id", async (c) => {
  const jobs = c.get("jobs");
  const job = await jobs.find(c.req.param("id"));
  if (!job || !await canAccessJob(job, accessCtx(c))) {
    return c.json({ error: "Job not found" }, 404);
  }
  return c.json(job);
});

// POST /api/v1/jobs/:id/retry — Restart a stalled job
jobRoutes.post("/:id/retry", async (c) => {
  const jobs = c.get("jobs");
  const job = await jobs.find(c.req.param("id"));
  if (!job || !await canAccessJob(job, accessCtx(c), "retry")) {
    return c.json({ error: "Job not found" }, 404);
  }
  if (job.status === "completed") {
    return c.json({ error: "Job already completed" }, 400);
  }

  // Reset to pending so the container can be re-triggered
  job.status = "pending";
  job.updatedAt = Date.now();
  await jobs.save(job);

  // Enqueue for re-extraction
  const extractionQueue = c.get("extractionQueue");
  if (extractionQueue) {
    const metadata = c.get("metadata");
    const asset = await metadata.find(job.assetId);
    if (asset?.archiveFormat) {
      await extractionQueue.send({
        assetId: job.assetId,
        archiveKey: `assets/${job.assetId}/${asset.filename}`,
        archiveFilename: asset.filename,
        archiveFormat: asset.archiveFormat,
      });
    }
  }

  return c.json(job);
});

// --- Internal API routes (mounted at /api/internal/jobs) ---

export const jobInternalRoutes = new Hono<AppEnv>();

// POST /api/internal/jobs/:id/status — Container → Worker: update job status
jobInternalRoutes.post("/:id/status", async (c) => {
  const jobs = c.get("jobs");
  const job = await jobs.find(c.req.param("id"));
  if (!job) {
    return c.json({ error: "Job not found" }, 404);
  }

  const body = await c.req.json<{
    status: "running" | "completed" | "failed";
    totalFiles?: number;
    fileCount?: number;
    extractedSize?: number;
    error?: string;
  }>();

  job.status = body.status;
  job.updatedAt = Date.now();

  if (body.status === "running" && !job.startedAt) {
    job.startedAt = Date.now();
  }
  if (body.status === "completed" || body.status === "failed") {
    job.completedAt = Date.now();
  }
  if (body.totalFiles !== undefined) {
    job.totalFiles = body.totalFiles;
  }
  if (body.fileCount !== undefined) {
    job.fileCount = body.fileCount;
  }
  if (body.extractedSize !== undefined) {
    job.extractedSize = body.extractedSize;
  }
  if (body.error) {
    job.error = body.error;
  }

  await jobs.save(job);

  // Update asset status to reflect job progress
  if (body.status === "running") {
    const metadata = c.get("metadata");
    const asset = await metadata.find(job.assetId);
    if (asset) {
      asset.status = "extracting";
      const ttl = c.get("ttlSeconds");
      await metadata.save(asset, ttl);
    }
  }

  // If completed, update asset metadata
  if (body.status === "completed") {
    const metadata = c.get("metadata");
    const asset = await metadata.find(job.assetId);
    if (asset) {
      asset.status = "ready";
      asset.fileCount = body.fileCount;
      asset.extractedSize = body.extractedSize;
      const ttl = c.get("ttlSeconds");
      await metadata.save(asset, ttl);
    }
  }

  if (body.status === "failed") {
    const metadata = c.get("metadata");
    const asset = await metadata.find(job.assetId);
    if (asset) {
      asset.status = "failed";
      const ttl = c.get("ttlSeconds");
      await metadata.save(asset, ttl);
    }
  }

  return c.json({ ok: true });
});
