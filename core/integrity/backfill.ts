/**
 * SHA-256 backfill of rows stored before ADR-017 (phase P4).
 *
 * Assets and versions uploaded before migration 0008 have `sha256` and
 * `integrity` both NULL. The cleanup cron picks a few of them each tick
 * ({@link enqueueIntegrityBackfill}), gives each an `integrity-backfill` job,
 * and sends it to the same verifier P1b uses: the archive-extractor image in
 * `MODE=verify` on Cloudflare, the in-process hash on Node. The verifier only
 * reports the hash it computed, as it does for verification;
 * {@link applyBackfillResult} records it as `verified`.
 *
 * What differs from verification is that nothing was declared, so there is
 * nothing to compare and nothing to reject. The bytes were accepted long ago,
 * and a backfill never deletes, rejects or re-labels anything:
 *
 * - the hash is written only while the row still has no hash and still names
 *   the object that was hashed (same filename, no blob key);
 * - a row whose object is missing gets nothing written; its job is closed
 *   with the reason, which is also what keeps the cron from picking the row
 *   again;
 * - a read error is retried by the cron like any job; when the retries run
 *   out the job is closed and the row stays as it was.
 *
 * The job row is the only marker. A row with a backfill job of any status is
 * never selected again, so readers see no new state: a row is either still
 * without a hash (fields omitted, as for every pre-ADR row) or `verified`.
 *
 * Backfilled rows stay at their classic keys: `blob_key` is not written.
 */
import type { AssetMetadata, AssetVersion } from "../asset/model";
import { isSha256Hex } from "../asset/integrity";
import { generateId } from "../asset/usecase/shared";
import type { FileStorage, MetadataStore, VersionStore } from "../asset/repository";
import { originalKey } from "../blob/model";
import type { SubrequestBudget } from "../cleanup/usecase";
import { retryDelaySeconds } from "../extraction/backoff";
import { JOB_MAX_RETRIES, type Job } from "../job/model";
import type { JobStore } from "../job/repository";
import { touchPendingJob } from "../job/usecase";
import type { JobQueue, QueueMessage } from "../queue/port";
import type { ContainerLauncher } from "../container/port";
import type { Deps } from "../types";
import type { BackfillTarget, IntegrityBackfillStore } from "./repository";
import { closedAsFailed, isClosed, type VerificationReport } from "./verification";

export const BACKFILL_JOB_TYPE = "integrity-backfill" as const;

/** One backfill run, on the extraction queue like verification, told apart by `kind`. */
export interface BackfillMessage {
  kind: typeof BACKFILL_JOB_TYPE;
  jobId: string;
  assetId: string;
  versionId?: string;
  objectKey: string;
}

export function isBackfillMessage(body: unknown): body is BackfillMessage {
  return typeof body === "object" && body !== null && (body as { kind?: unknown }).kind === BACKFILL_JOB_TYPE;
}

/**
 * The cron's knobs. `batchSize` bounds how many backfill jobs are open at
 * once, not only how many start per tick: the runs share the extractor's
 * `max_instances` with extraction and verification, so the backfill stays a
 * trickle however long each run takes.
 */
export interface BackfillSettings {
  enabled: boolean;
  batchSize: number;
}

export const DEFAULT_BACKFILL_BATCH_SIZE = 2;

export type BackfillOutcome =
  /** Progress recorded. */
  | "running"
  /** The row is now `verified` with the computed hash. */
  | "recorded"
  /** The read failed; the cron runs the job again. */
  | "retry"
  /** The row's object is not in the store; nothing written, the job is closed. */
  | "missing"
  /** Nothing to do: row gone, already hashed or replaced, or the job closed. */
  | "settled";

export type BackfillDeps = {
  jobs: JobStore;
  metadata: MetadataStore;
  versions: VersionStore;
  storage: FileStorage;
  integrityBackfills: IntegrityBackfillStore;
};

type Row = AssetMetadata | AssetVersion;

export function newBackfillJob(target: BackfillTarget, now: number): Job {
  return {
    id: generateId(),
    assetId: target.assetId,
    type: BACKFILL_JOB_TYPE,
    status: "pending",
    createdAt: now,
    updatedAt: now,
    ...(target.versionId && { versionId: target.versionId }),
    ...(target.projectId && { projectId: target.projectId }),
    ...(target.sessionId && { sessionId: target.sessionId }),
  };
}

function backfillMessage(job: Job, row: Row): BackfillMessage {
  return {
    kind: BACKFILL_JOB_TYPE,
    jobId: job.id,
    assetId: job.assetId,
    ...(job.versionId && { versionId: job.versionId }),
    objectKey: originalKey(row),
  };
}

/** Still a pre-ADR row: no hash, no integrity state, classic key. */
function isUnhashed(row: Row): boolean {
  return row.sha256 == null && row.integrity == null && !row.blobKey;
}

/** The row `job` hashes, or null when it is gone. */
async function findRow(deps: Pick<BackfillDeps, "metadata" | "versions">, job: Job): Promise<Row | null> {
  if (!job.versionId) return deps.metadata.find(job.assetId);
  const version = await deps.versions.find(job.versionId);
  return version && version.assetId === job.assetId ? version : null;
}

/**
 * The row `job` should still hash, or null after closing the job because
 * there is nothing left to do: the row is gone (`failed`, with the reason) or
 * already has a hash (`completed`).
 */
async function openRow(deps: BackfillDeps, job: Job, now: number): Promise<Row | null> {
  const row = await findRow(deps, job);
  if (!row) {
    await deps.jobs.save(closedAsFailed(job, `${job.versionId ? "version" : "asset"} no longer exists`, now));
    return null;
  }
  if (!isUnhashed(row)) {
    await deps.jobs.save({ ...job, status: "completed", updatedAt: now, completedAt: now });
    return null;
  }
  return row;
}

/**
 * Whether the row's object is missing from the store. A failed `head` counts
 * as present: only a store that answers "no such object" closes the job.
 */
async function objectMissing(storage: FileStorage, key: string): Promise<boolean> {
  try {
    return (await storage.head(key)) === null;
  } catch {
    return false;
  }
}

async function closeMissing(deps: BackfillDeps, job: Job, key: string, now: number): Promise<void> {
  await deps.jobs.save(closedAsFailed(job, `object ${key} is missing from the store; no hash recorded`, now));
  console.warn(`integrity backfill: ${job.versionId ? `version ${job.versionId}` : `asset ${job.assetId}`} has no object at ${key}; left without a hash`);
}

/** The message that re-runs `job`, or null when its row is gone or already hashed. */
export async function backfillMessageForJob(
  job: Job,
  metadata: MetadataStore,
  versions: VersionStore,
): Promise<BackfillMessage | null> {
  const row = await findRow({ metadata, versions }, job);
  if (!row || !isUnhashed(row)) return null;
  return backfillMessage(job, row);
}

/**
 * Settle a backfill job from the verifier's report. Idempotent: a report for
 * a closed job, or for a row that is gone or already hashed, only closes the
 * job.
 */
export async function applyBackfillResult(
  deps: BackfillDeps,
  job: Job,
  report: VerificationReport,
  now = Date.now(),
): Promise<BackfillOutcome> {
  if (isClosed(job)) return "settled";
  const row = await openRow(deps, job, now);
  if (!row) return "settled";

  if (report.status === "running") {
    await deps.jobs.save({ ...job, status: "running", updatedAt: now, startedAt: job.startedAt ?? now });
    return "running";
  }

  if (report.status === "failed" || !isSha256Hex(report.sha256)) {
    const key = originalKey(row);
    if (await objectMissing(deps.storage, key)) {
      await closeMissing(deps, job, key, now);
      return "missing";
    }
    // `failed` with budget left is what the cron's retry pass re-runs.
    const error = report.status === "failed" ? report.error : `verifier reported a malformed SHA-256: ${report.sha256}`;
    await deps.jobs.save({ ...job, status: "failed", error, updatedAt: now, completedAt: now });
    return "retry";
  }

  const recorded = await deps.integrityBackfills.complete({
    target: {
      assetId: job.assetId,
      ...(job.versionId && { versionId: job.versionId }),
      filename: row.filename,
    },
    sha256: report.sha256.toLowerCase(),
    job: { ...job, status: "completed", updatedAt: now, completedAt: now, startedAt: job.startedAt ?? now },
  });
  return recorded ? "recorded" : "settled";
}

/**
 * The cron step: top the open backfill jobs up to `settings.batchSize`, one
 * page of unhashed rows, on what is left of the tick's subrequest budget.
 *
 * Each row's job is saved before its message is sent. A failed send leaves a
 * `pending` job, which the cron's retry pass re-sends once it passes the
 * stuck threshold; the job row also keeps the next selection from picking
 * the row again, so a row is never enqueued twice.
 */
export async function enqueueIntegrityBackfill(
  deps: {
    integrityBackfills: IntegrityBackfillStore;
    jobs: JobStore;
    backfillQueue: JobQueue<BackfillMessage> | null;
    containers: Pick<ContainerLauncher, "integrityVerifierAvailable">;
  },
  budget: SubrequestBudget,
  settings: BackfillSettings,
  now = Date.now(),
): Promise<{ enqueued: string[]; budgetExhausted: boolean }> {
  const enqueued: string[] = [];
  const queue = deps.backfillQueue;
  if (!settings.enabled || settings.batchSize <= 0 || !queue || !deps.containers.integrityVerifierAvailable) {
    return { enqueued, budgetExhausted: false };
  }
  // The count, the page, and at least one job + message.
  if (!budget.canAfford(4)) return { enqueued, budgetExhausted: true };

  const open = await deps.integrityBackfills.countOpen(JOB_MAX_RETRIES);
  budget.charge();
  const slots = settings.batchSize - open;
  if (slots <= 0) return { enqueued, budgetExhausted: false };

  const targets = await deps.integrityBackfills.listUnhashed(slots);
  budget.charge();

  for (const target of targets) {
    if (!budget.canAfford(2)) return { enqueued, budgetExhausted: true };
    const job = newBackfillJob(target, now);
    await deps.jobs.save(job);
    budget.charge();
    try {
      await queue.send({
        kind: BACKFILL_JOB_TYPE,
        jobId: job.id,
        assetId: target.assetId,
        ...(target.versionId && { versionId: target.versionId }),
        objectKey: originalKey(target.versionId
          ? { id: target.versionId, assetId: target.assetId, filename: target.filename }
          : { id: target.assetId, filename: target.filename }),
      });
    } catch (e) {
      console.error(`integrity backfill: could not enqueue job ${job.id}; the cron re-sends it once stuck:`, e);
    }
    budget.charge();
    enqueued.push(job.id);
  }
  return { enqueued, budgetExhausted: false };
}

// Delay applied to every message when no verifier can be launched at all.
const MISCONFIGURED_RETRY_DELAY_SECONDS = 300;

/**
 * Queue consumer for backfill runs. Mirrors the verification consumer: a
 * verifier that returns the hash (in process) is settled here, one that
 * starts a container settles from the container's report. A row whose object
 * is missing is closed before any container is started.
 */
export async function handleBackfillQueue(messages: QueueMessage<BackfillMessage>[], deps: Deps): Promise<void> {
  if (!deps.containers.integrityVerifierAvailable) {
    console.error("Cannot backfill hashes: no integrity verifier is configured");
    for (const message of messages) message.retry({ delaySeconds: MISCONFIGURED_RETRY_DELAY_SECONDS });
    return;
  }

  for (const message of messages) {
    const { jobId } = message.body;
    try {
      const job = await deps.jobs.find(jobId);
      if (!job || job.type !== BACKFILL_JOB_TYPE || isClosed(job)) {
        message.ack();
        continue;
      }
      const now = Date.now();
      const row = await openRow(deps, job, now);
      if (!row) {
        message.ack();
        continue;
      }
      // The key comes from the row as it is now, not from the message.
      const objectKey = originalKey(row);
      if (await objectMissing(deps.storage, objectKey)) {
        await closeMissing(deps, job, objectKey, now);
        message.ack();
        continue;
      }

      const outcome = await deps.containers.verifyIntegrity({ jobId, assetId: job.assetId, objectKey });
      if ("sha256" in outcome) {
        await applyBackfillResult(deps, job, { status: "completed", sha256: outcome.sha256 });
      }
      message.ack();
    } catch (e) {
      console.error(`Failed to backfill job ${jobId} (attempt ${message.attempts}):`, e);
      await touchPendingJob(deps.jobs, jobId);
      message.retry({ delaySeconds: retryDelaySeconds(message.attempts) });
    }
  }
}
