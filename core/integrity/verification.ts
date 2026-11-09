/**
 * Hash verification of presigned uploads (ADR-017 §2, phase P1b).
 *
 * A presigned upload is stored without a whole-object SHA-256 the store
 * vouches for: multipart uploads never have one, and a single PUT has one only
 * when the store kept the signed checksum. Such an upload is recorded
 * `integrity: "pending"` — servable, hash unconfirmed — and gets an
 * `integrity-verification` job. The job streams the object once and hands the
 * hash to {@link applyVerificationResult}, which settles the row:
 *
 * - nothing declared, or the declared hash matches → `verified`, with the
 *   computed hash recorded;
 * - the declared hash differs → the upload is deleted (rows, bytes, extracted
 *   output, usage counters) and the job is closed `failed`. The mismatch is
 *   final: it is not retried.
 * - the object could not be read → the job fails transiently and the cleanup
 *   cron re-runs it within the usual retry budget. The row stays `pending`.
 *
 * Only first uploads arrive through upload sessions, so the job always
 * settles an asset row; a version is uploaded through the Worker and verified
 * in line (P1a). While a declared first upload is pending, the asset takes no
 * new versions (`UploadUnderVerificationError`), so a rejected first upload
 * never has versions to take down with it.
 *
 * Where the hash is computed is the `ContainerLauncher`'s business: the
 * archive-extractor image in `MODE=verify` on Cloudflare (it reports through
 * `POST /api/internal/jobs/:id/status`), in process on Node.
 */
import type { AssetMetadata } from "../asset/model";
import { ChecksumMismatchError, isSha256Hex } from "../asset/integrity";
import { deleteAsset } from "../asset/usecase/delete";
import { generateId, storageKey, usageScopesFor } from "../asset/usecase/shared";
import type { MetadataStore } from "../asset/repository";
import { retryDelaySeconds } from "../extraction/backoff";
import { JOB_MAX_RETRIES, type Job } from "../job/model";
import { touchPendingJob } from "../job/usecase";
import type { QueueMessage } from "../queue/port";
import type { ContextDeps, Deps } from "../types";

export const VERIFICATION_JOB_TYPE = "integrity-verification" as const;

/**
 * One verification run. It travels on the extraction queue (the same
 * container image runs it), told apart by `kind`.
 */
export interface VerificationMessage {
  kind: typeof VERIFICATION_JOB_TYPE;
  jobId: string;
  assetId: string;
  objectKey: string;
}

export function isVerificationMessage(body: unknown): body is VerificationMessage {
  return typeof body === "object" && body !== null && (body as { kind?: unknown }).kind === VERIFICATION_JOB_TYPE;
}

/** What a verifier reports — the container over HTTP, or the in-process verifier. */
export type VerificationReport =
  | { status: "running" }
  | { status: "completed"; sha256: string }
  | { status: "failed"; error: string };

export type VerificationOutcome =
  /** Progress recorded. */
  | "running"
  /** The row is `verified`. */
  | "verified"
  /** The declared hash did not match; the upload is gone. */
  | "rejected"
  /** The read failed; the job will be run again. */
  | "retry"
  /** Nothing left to decide (asset gone, already settled, or a late report). */
  | "settled";

/** What settling a verification touches. Satisfied by `Deps` and by a route's context. */
export type VerificationDeps = Pick<
  ContextDeps,
  "jobs" | "metadata" | "writes" | "storage" | "pendingCleanup" | "projects" | "siteHosts" | "cache" | "customHostnames" | "siteHostSuffix"
>;

/** The job a pending first upload gets, linked by asset (its `jobId` stays the extraction's). */
export function newVerificationJob(asset: AssetMetadata, now: number): Job {
  return {
    id: generateId(),
    assetId: asset.id,
    type: VERIFICATION_JOB_TYPE,
    status: "pending",
    createdAt: now,
    updatedAt: now,
    ...(asset.sessionId && { sessionId: asset.sessionId }),
    ...(asset.projectId && { projectId: asset.projectId }),
  };
}

export function verificationMessage(job: Pick<Job, "id">, asset: Pick<AssetMetadata, "id" | "filename">): VerificationMessage {
  return { kind: VERIFICATION_JOB_TYPE, jobId: job.id, assetId: asset.id, objectKey: storageKey(asset.id, asset.filename) };
}

/** The message that re-runs `job`, or null when its asset is gone or already settled. */
export async function verificationMessageForJob(job: Job, metadata: MetadataStore): Promise<VerificationMessage | null> {
  const asset = await metadata.find(job.assetId);
  if (!asset || asset.integrity !== "pending") return null;
  return verificationMessage(job, asset);
}

/** A job the cron will not pick up again: completed, or failed past its budget. */
export function isClosed(job: Pick<Job, "status" | "retryCount">): boolean {
  return job.status === "completed" || (job.status === "failed" && (job.retryCount ?? 0) > JOB_MAX_RETRIES);
}

/** `job`, closed `failed` so no retry path picks it up again. */
export function closedAsFailed(job: Job, error: string, now: number): Job {
  return { ...job, status: "failed", retryCount: JOB_MAX_RETRIES + 1, error, updatedAt: now, completedAt: now };
}

/**
 * Settle a verification job from a verifier's report. Idempotent: a report
 * for a closed job, or for an asset that is gone or no longer pending, only
 * closes the job.
 */
export async function applyVerificationResult(
  deps: VerificationDeps,
  job: Job,
  report: VerificationReport,
  now = Date.now(),
): Promise<VerificationOutcome> {
  if (isClosed(job)) return "settled";

  const asset = await deps.metadata.find(job.assetId);
  if (!asset || asset.integrity !== "pending") {
    await closeWithoutVerdict(deps, job, asset, now);
    return "settled";
  }

  if (report.status === "running") {
    await deps.jobs.save({ ...job, status: "running", updatedAt: now, startedAt: job.startedAt ?? now });
    return "running";
  }

  if (report.status === "failed" || !isSha256Hex(report.sha256)) {
    // Transient by construction: the verifier only reports what it computed,
    // the comparison is made here. `failed` with budget left is what the
    // cron's retry pass re-runs; the row stays `pending` and servable.
    const error = report.status === "failed" ? report.error : `verifier reported a malformed SHA-256: ${report.sha256}`;
    await deps.jobs.save({ ...job, status: "failed", error, updatedAt: now, completedAt: now });
    return "retry";
  }

  const computed = report.sha256.toLowerCase();
  if (!asset.sha256 || asset.sha256 === computed) {
    await deps.writes.saveJob({
      job: { ...job, status: "completed", updatedAt: now, completedAt: now, startedAt: job.startedAt ?? now },
      asset: { ...asset, sha256: computed, integrity: "verified" },
    });
    return "verified";
  }

  await rejectUpload(deps, job, asset, computed, now);
  return "rejected";
}

/**
 * Close a job that has nothing left to verify: its asset is gone (deleted by
 * its owner, expired, or rejected by an earlier run) or already settled.
 */
async function closeWithoutVerdict(deps: Pick<VerificationDeps, "jobs">, job: Job, asset: AssetMetadata | null, now: number): Promise<void> {
  if (!asset) await deps.jobs.save(closedAsFailed(job, "asset no longer exists", now));
  else await deps.jobs.save({ ...job, status: "completed", updatedAt: now, completedAt: now });
}

/**
 * The declared hash did not match: delete the upload and close its jobs.
 *
 * The asset goes first. A crash after the delete leaves a job whose asset is
 * gone, which the next report or the cron closes; a crash before it leaves
 * the job open, and its re-run reaches the same verdict. The other order
 * could close the job and leave the bytes it rejected in place.
 */
async function rejectUpload(deps: VerificationDeps, job: Job, asset: AssetMetadata, computed: string, now: number): Promise<void> {
  const declared = asset.sha256!;
  const usageScopes = await usageScopesFor(deps.projects, asset.projectId);
  await deleteAsset(deps.writes, deps.storage, asset, {
    usageScopes,
    pendingCleanup: deps.pendingCleanup,
    siteHosts: { hosts: deps.siteHosts, cache: deps.cache, suffix: deps.siteHostSuffix, provisioner: deps.customHostnames },
    now,
  });

  // The archive's extraction job, if any, must not be relaunched into a prefix
  // that no longer exists. A running extractor stops at its next existence
  // check; its final status report then re-queues the prefix for cleanup
  // (core/job/handler.ts), which catches what it wrote after this delete.
  if (asset.jobId && asset.jobId !== job.id) {
    const extraction = await deps.jobs.find(asset.jobId);
    if (extraction && extraction.status !== "completed") {
      await deps.jobs.save(closedAsFailed(extraction, "upload rejected: SHA-256 mismatch", now));
    }
  }

  await deps.jobs.save(closedAsFailed(job, new ChecksumMismatchError(declared, computed).message, now));
  console.warn(`integrity: asset ${asset.id} rejected, declared ${declared} but stored bytes hash to ${computed}`);
}

// Delay applied to every message when no verifier can be launched at all.
const MISCONFIGURED_RETRY_DELAY_SECONDS = 300;

/**
 * Queue consumer for verification runs. A verifier that returns the hash
 * (in process) is settled here; one that starts a container settles later,
 * from the container's report. A launch or read failure retries with the
 * extractor's backoff.
 */
export async function handleVerificationQueue(messages: QueueMessage<VerificationMessage>[], deps: Deps): Promise<void> {
  if (!deps.containers.integrityVerifierAvailable) {
    console.error("Cannot verify uploads: no integrity verifier is configured");
    for (const message of messages) message.retry({ delaySeconds: MISCONFIGURED_RETRY_DELAY_SECONDS });
    return;
  }

  for (const message of messages) {
    const { jobId, assetId, objectKey } = message.body;
    try {
      const job = await deps.jobs.find(jobId);
      if (!job || job.type !== VERIFICATION_JOB_TYPE || isClosed(job)) {
        message.ack();
        continue;
      }
      // Do not start a 250 GiB read for an asset that is gone or settled.
      const asset = await deps.metadata.find(assetId);
      if (!asset || asset.integrity !== "pending") {
        await closeWithoutVerdict(deps, job, asset, Date.now());
        message.ack();
        continue;
      }

      const outcome = await deps.containers.verifyIntegrity({ jobId, assetId, objectKey });
      if ("sha256" in outcome) {
        await applyVerificationResult(deps, job, { status: "completed", sha256: outcome.sha256 });
      }
      message.ack();
    } catch (e) {
      console.error(`Failed to verify job ${jobId} (attempt ${message.attempts}):`, e);
      await touchPendingJob(deps.jobs, jobId);
      message.retry({ delaySeconds: retryDelaySeconds(message.attempts) });
    }
  }
}
