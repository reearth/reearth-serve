// Re-export shared API types
export type { Job } from "../../shared/api";
import type { Job } from "../../shared/api";

// Worker-only types

export type JobType = Job["type"];

/**
 * Re-runs the cleanup cron grants a job. A job stored with
 * `retryCount > JOB_MAX_RETRIES` is out of the retry pool for good.
 */
export const JOB_MAX_RETRIES = 5;

/**
 * What a job's failure means (ADR-018 §6). It follows from the job's type, so
 * it is derived rather than stored: every row of one type has the same class.
 *
 * - `missing-feature` — something is absent until the job succeeds (today's
 *   archive extraction: the files are not listed or served without it). Retry;
 *   a final failure marks the asset or version `failed`.
 * - `rejected-version` — the job decides whether the upload is kept (hash
 *   verification, ADR-017 §2). Only transient read errors are retried; a
 *   mismatch is final and deletes the upload. A job that runs out of retries
 *   leaves the upload `pending`, never `failed`, and touches no `status`.
 */
export type JobFailureClass = "missing-feature" | "rejected-version";

const FAILURE_CLASS: Record<JobType, JobFailureClass> = {
  "archive-extraction": "missing-feature",
  "integrity-verification": "rejected-version",
};

export function jobFailureClass(job: Pick<Job, "type">): JobFailureClass {
  return FAILURE_CLASS[job.type];
}

export interface FileEntry {
  path: string;
  size: number;
  contentType: string;
  contentEncoding?: string;
}
