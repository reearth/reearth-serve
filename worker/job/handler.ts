import { Hono } from "hono";
import type { Context } from "hono";
import { describeRoute } from "hono-openapi";
import { resolver, validator as zValidator } from "hono-openapi";
import type { AppEnv } from "../types";
import { canAccessJob, type AccessContext } from "../asset/access";
import {
  jobResponseSchema, jobListResponseSchema, errorResponseSchema,
  idParamSchema, paginationQuerySchema,
} from "../../shared/openapi";
import { jobSchema } from "../../shared/api";

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

jobRoutes.get("/",
  describeRoute({
    tags: ["Jobs"],
    summary: "List jobs",
    responses: {
      200: { description: "Job list", content: { "application/json": { schema: resolver(jobListResponseSchema) } } },
    },
  }),
  zValidator("query", paginationQuerySchema),
  async (c) => {
    const jobs = c.get("jobs");
    const user = c.get("user");
    const sessionId = c.get("sessionId");
    const { limit: limitStr, cursor } = c.req.valid("query");
    const limit = parseInt(limitStr || "20", 10);

    const result = await jobs.list({
      limit: Math.min(limit, 100),
      cursor,
      ...(!user && sessionId ? { sessionId } : {}),
    });
    return c.json({ jobs: result.items, cursor: result.cursor });
  },
);

jobRoutes.get("/:id",
  describeRoute({
    tags: ["Jobs"],
    summary: "Get job progress",
    responses: {
      200: { description: "Job details", content: { "application/json": { schema: resolver(jobSchema) } } },
      404: { description: "Job not found", content: { "application/json": { schema: resolver(errorResponseSchema) } } },
    },
  }),
  zValidator("param", idParamSchema),
  async (c) => {
    const jobs = c.get("jobs");
    const { id } = c.req.valid("param");
    const job = await jobs.find(id);
    if (!job || !await canAccessJob(job, accessCtx(c))) {
      return c.json({ error: "Job not found" }, 404);
    }
    return c.json(job);
  },
);

jobRoutes.post("/:id/retry",
  describeRoute({
    tags: ["Jobs"],
    summary: "Retry a stalled job",
    responses: {
      200: { description: "Job restarted", content: { "application/json": { schema: resolver(jobSchema) } } },
      400: { description: "Job already completed", content: { "application/json": { schema: resolver(errorResponseSchema) } } },
      404: { description: "Job not found", content: { "application/json": { schema: resolver(errorResponseSchema) } } },
    },
  }),
  zValidator("param", idParamSchema),
  async (c) => {
    const jobs = c.get("jobs");
    const { id } = c.req.valid("param");
    const job = await jobs.find(id);
    if (!job || !await canAccessJob(job, accessCtx(c), "retry")) {
      return c.json({ error: "Job not found" }, 404);
    }
    if (job.status === "completed") {
      return c.json({ error: "Job already completed" }, 400);
    }

    job.status = "pending";
    job.updatedAt = Date.now();
    await jobs.save(job);

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
  },
);

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
