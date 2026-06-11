import { Hono } from "hono";
import type { Context } from "hono";
import { describeRoute } from "hono-openapi";
import { resolver, validator as zValidator } from "hono-openapi";
import type { AppEnv } from "../types";
import { canAccessJob, canAccessProject, type AccessContext } from "../asset/access";
import {
  jobResponseSchema, jobListResponseSchema, errorResponseSchema,
  idParamSchema, scopedListQuerySchema,
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
    description: "Anonymous callers see their own session's jobs. Authenticated callers see jobs in projects they have access to; narrow with ?projectId or ?workspaceId.",
    responses: {
      200: { description: "Job list", content: { "application/json": { schema: resolver(jobListResponseSchema) } } },
      404: { description: "Scope not accessible", content: { "application/json": { schema: resolver(errorResponseSchema) } } },
    },
  }),
  zValidator("query", scopedListQuerySchema),
  async (c) => {
    const jobs = c.get("jobs");
    const user = c.get("user");
    const sessionId = c.get("sessionId");
    const { limit: limitStr, cursor, workspaceId, projectId } = c.req.valid("query");
    const limit = Math.min(parseInt(limitStr || "20", 10), 100);

    if (!user) {
      if (!sessionId) return c.json({ jobs: [], cursor: undefined });
      const result = await jobs.list({ limit, cursor, sessionId });
      return c.json({ jobs: result.items, cursor: result.cursor });
    }

    if (projectId) {
      if (!await canAccessProject(accessCtx(c), projectId, "read")) {
        return c.json({ error: "Project not found" }, 404);
      }
      const result = await jobs.list({ limit, cursor, projectId });
      return c.json({ jobs: result.items, cursor: result.cursor });
    }

    if (workspaceId) {
      const members = c.get("members");
      const member = await members.find(workspaceId, user.sub);
      if (!member) return c.json({ error: "Workspace not found" }, 404);
      const result = await jobs.list({ limit, cursor, workspaceId });
      return c.json({ jobs: result.items, cursor: result.cursor });
    }

    const result = await jobs.list({ limit, cursor, accessibleByUser: user.sub });
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

  // Demo-mode assets expire `ttlSeconds` after upload, but extraction of a
  // large archive can outlive that window — the cleanup cron would delete
  // the asset mid-extraction and the container would abort at its next
  // existence check. While the job is making progress (the container posts
  // status every CHECKPOINT_EVERY entries), keep pushing the expiry forward;
  // completion also restarts the window so the extracted asset is actually
  // usable for a full TTL.
  const extendDemoExpiry = (asset: { expiresAt: number }, ttl: number) => {
    if (asset.expiresAt > 0) {
      asset.expiresAt = Math.max(asset.expiresAt, Date.now() + ttl * 1000);
    }
  };

  // Update asset status to reflect job progress
  if (body.status === "running") {
    const metadata = c.get("metadata");
    const asset = await metadata.find(job.assetId);
    if (asset) {
      asset.status = "extracting";
      const ttl = c.get("ttlSeconds");
      extendDemoExpiry(asset, ttl);
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
      extendDemoExpiry(asset, ttl);
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
