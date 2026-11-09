import { Hono } from "hono";
import { describeRoute } from "hono-openapi";
import { validator as zValidator } from "hono-openapi";
import type { AppEnv } from "../types";
import { accessCtx, authorizeJob, authorizeProject, authorizeWorkspace, deniedResponse } from "../auth/access";
import {
  jobResponseSchema, jobListResponseSchema, idParamSchema, scopedListQuerySchema,
} from "../../shared/openapi";
import { jobSchema } from "../../shared/api";
import { hostingOnExtractionComplete } from "../site/hosting";
import { extractionMessageForJob } from "../extraction/handler";
import {
  applyVerificationResult, VERIFICATION_JOB_TYPE, verificationMessageForJob, type VerificationDeps,
} from "../integrity/verification";
import { isSha256Hex } from "../asset/integrity";
import type { Context } from "hono";
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
      400: jsonError("Job already completed, or nothing left to verify"),
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

    if (job.type === VERIFICATION_JOB_TYPE) {
      // A rejected upload is gone and a verified one is settled: either way
      // there is nothing to run again.
      const message = await verificationMessageForJob(job, c.get("metadata"));
      if (!message) return c.json({ error: "Nothing left to verify" }, 400);
      job.status = "pending";
      job.updatedAt = Date.now();
      await jobs.save(job);
      await c.get("verificationQueue")?.send(message);
      return c.json(job);
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
    sha256?: string;
  }>();

  // Hash verification (ADR-017 §2): the container reports the hash it
  // computed, and the comparison with the declared one is made here.
  if (job.type === VERIFICATION_JOB_TYPE) {
    if (body.status === "completed" && !(body.sha256 && isSha256Hex(body.sha256))) {
      return c.json({ error: "completed verification requires a 64-hex sha256" }, 400);
    }
    const report = body.status === "completed"
      ? { status: "completed" as const, sha256: body.sha256! }
      : body.status === "failed"
        ? { status: "failed" as const, error: body.error || "verification failed" }
        : { status: "running" as const };
    const outcome = await applyVerificationResult(verificationDeps(c), job, report);
    return c.json({ ok: true, outcome });
  }

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
  let mirrorReadFailed = false;
  const readFailed = (e: unknown) => {
    console.warn(`job ${job.id}: mirror read failed, saving job only:`, e);
    mirrorReadFailed = true;
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

  // `_headers` / `_redirects` (ADR-013 C3). The archive's control files only
  // exist once extraction has written them, so this is the moment to read and
  // parse them. The asset-row case joins the atomic write below; the version
  // case follows it, since `saveJob` carries a job and an asset and nothing
  // else.
  const placement = body.status === "completed"
    ? await hostingOnExtractionComplete(c.get("storage"), job, asset)
    : null;
  if (placement?.on === "asset" && asset) asset.hosting = placement.hosting;

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

  if (placement?.on === "version") {
    await c.get("versions").update(placement.versionId, { hosting: placement.hosting });
  }

  // The asset (or version) was deleted while the extractor was running — by
  // its owner, by expiry, or because hash verification rejected the upload.
  // The delete cleared the prefix, but the extractor kept writing until its
  // next existence check, and wrote its log on the way out. Its final report
  // comes after all of that, so queueing the prefix now catches every key.
  const terminal = body.status === "completed" || body.status === "failed";
  if (terminal && !mirrorReadFailed && !mirror) {
    await c.get("pendingCleanup").add(extractionPrefix(job));
  }

  return c.json({ ok: true });
});

/** The prefix an extraction job writes under (container/archive-extractor keyRoot). */
function extractionPrefix(job: { assetId: string; versionId?: string }): string {
  return job.versionId ? `assets/${job.assetId}/v/${job.versionId}/` : `assets/${job.assetId}/`;
}

function verificationDeps(c: Context<AppEnv>): VerificationDeps {
  return {
    jobs: c.get("jobs"),
    metadata: c.get("metadata"),
    writes: c.get("writes"),
    storage: c.get("storage"),
    pendingCleanup: c.get("pendingCleanup"),
    projects: c.get("projects"),
    siteHosts: c.get("siteHosts"),
    cache: c.get("cache"),
    customHostnames: c.get("customHostnames"),
    siteHostSuffix: c.get("siteHostSuffix"),
  };
}
