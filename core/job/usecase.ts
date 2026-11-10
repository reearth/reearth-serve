import type { JobStore } from "./repository";

/**
 * Refresh a pending job's `updated_at` after a failed launch, so the cleanup
 * cron can tell "waiting for capacity, the queue is on it" from "orphaned".
 * Without it the cron re-enqueues the still-pending job every tick and each
 * pass burns one of its retries. The cron only takes over once the queue gives
 * up (max_retries → DLQ) and the touches stop.
 */
export async function touchPendingJob(jobs: JobStore, jobId: string): Promise<void> {
  try {
    const job = await jobs.find(jobId);
    if (job && job.status === "pending") {
      job.updatedAt = Date.now();
      await jobs.save(job);
    }
  } catch (e) {
    console.error(`Failed to touch pending job ${jobId}:`, e);
  }
}
