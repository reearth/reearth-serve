import { Hono } from "hono";
import { describeRoute } from "hono-openapi";
import { validator as zValidator } from "hono-openapi";
import type { AppEnv } from "../types";
import { accessCtx, authorizeJob, authorizeProject, authorizeWorkspace, deniedResponse } from "../auth/access";
import {
  jobResponseSchema, jobListResponseSchema, idParamSchema, scopedListQuerySchema,
} from "../../shared/openapi";
import { jobSchema } from "../../shared/api";
import { extractionMessageForJob } from "../extraction/handler";
import { jsonError, jsonResponse } from "../openapi";

// --- Public API routes (mounted at /api/v1/jobs) ---

export const jobRoutes = new Hono<AppEnv>();

jobRoutes.get("/",
  describeRoute({
    tags: ["Jobs"],
    summary: "List jobs",
    description: "Anonymous callers see their own session's jobs. Authenticated callers see jobs in projects they have access to; narrow with ?projectId or ?workspaceId.",
    responses: {
      200: jsonResponse("Job list", jobListResponseSchema),
      404: jsonError("Scope not accessible"),
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
      const result = await jobs.list({ limit, cursor, scope: { kind: "session", sessionId } });
      return c.json({ jobs: result.items, cursor: result.cursor });
    }

    if (projectId) {
      const access = await authorizeProject(accessCtx(c), projectId, "read_job");
      if (!access.ok) return deniedResponse(c, access, { notFound: "Project not found" });
      const result = await jobs.list({ limit, cursor, scope: { kind: "project", projectId } });
      return c.json({ jobs: result.items, cursor: result.cursor });
    }

    if (workspaceId) {
      const access = await authorizeWorkspace(accessCtx(c), workspaceId, "read");
      if (!access.ok) return deniedResponse(c, access, { notFound: "Workspace not found" });
      const result = await jobs.list({ limit, cursor, scope: { kind: "workspace", workspaceId } });
      return c.json({ jobs: result.items, cursor: result.cursor });
    }

    const workspaceIds = (await c.get("tenancy").members.listForCaller()).map((m) => m.workspaceId);
    const result = await jobs.list({ limit, cursor, scope: { kind: "visible", workspaceIds, ownerId: user.id } });
    return c.json({ jobs: result.items, cursor: result.cursor });
  },
);

jobRoutes.get("/:id",
  describeRoute({
    tags: ["Jobs"],
    summary: "Get job progress",
    responses: {
      200: jsonResponse("Job details", jobSchema),
      404: jsonError("Job not found"),
    },
  }),
  zValidator("param", idParamSchema),
  async (c) => {
    const jobs = c.get("jobs");
    const { id } = c.req.valid("param");
    const access = await authorizeJob(accessCtx(c), await jobs.find(id), "read_job");
    if (!access.ok) return deniedResponse(c, access, { notFound: "Job not found" });
    return c.json(access.value);
  },
);

jobRoutes.post("/:id/retry",
  describeRoute({
    tags: ["Jobs"],
    summary: "Retry a stalled job",
    responses: {
      200: jsonResponse("Job restarted", jobSchema),
      400: jsonError("Job already completed"),
      404: jsonError("Job not found"),
    },
  }),
  zValidator("param", idParamSchema),
  async (c) => {
    const jobs = c.get("jobs");
    const { id } = c.req.valid("param");
    const access = await authorizeJob(accessCtx(c), await jobs.find(id), "retry_job");
    if (!access.ok) return deniedResponse(c, access, { notFound: "Job not found" });
    const job = access.value;
    if (job.status === "completed") {
      return c.json({ error: "Job already completed" }, 400);
    }

    job.status = "pending";
    job.updatedAt = Date.now();
    await jobs.save(job);

    const extractionQueue = c.get("extractionQueue");
    if (extractionQueue) {
      const message = await extractionMessageForJob(job, c.get("metadata"), c.get("versions"));
      if (message) await extractionQueue.send(message);
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
  // The container omits zero counters so a failure report cannot wipe real
  // progress; a completed job with nothing reported extracted nothing.
  if (body.status === "completed") {
    job.fileCount ??= 0;
    job.extractedSize ??= 0;
  }

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

  // Mirror the job status onto its version for a version's job, onto the
  // asset otherwise (ADR-005). The rows go out in one atomic write (ADR-012
  // §3), because a job marked completed while its asset still says
  // "extracting" is exactly the drift the cleanup cron has to reconcile.
  //
  // The job row is the one that must land: the container drops its checkpoint
  // once "completed" is acknowledged, while a stale asset mirror is healed by
  // `reconcileStuckAssets`. So a failed read or batch falls back to writing
  // the job alone instead of losing the status.
  const ttl = c.get("ttlSeconds");
  const readFailed = (e: unknown) => {
    console.warn(`job ${job.id}: mirror read failed, saving job only:`, e);
    return null;
  };
  const asset = await c.get("metadata").find(job.assetId).catch(readFailed);
  const version = job.versionId
    ? await c.get("versions").find(job.versionId).catch(readFailed)
    : null;
  const mirror = job.versionId ? version : asset;

  if (mirror && body.status === "running") {
    mirror.status = "extracting";
  }
  if (mirror && body.status === "completed") {
    mirror.status = "ready";
    mirror.fileCount = job.fileCount;
    mirror.extractedSize = job.extractedSize;
  }
  if (mirror && body.status === "failed") {
    mirror.status = "failed";
  }
  if (asset && body.status !== "failed") {
    extendDemoExpiry(asset, ttl);
  }

  const writes = c.get("writes");
  if (!asset && !version) {
    await writes.saveJob({ job });
  } else {
    try {
      await writes.saveJob({ job, asset: asset ?? undefined, version: version ?? undefined });
    } catch (e) {
      console.warn(`job ${job.id}: job+mirror write failed, saving job only:`, e);
      await writes.saveJob({ job });
    }
  }

  return c.json({ ok: true });
});
