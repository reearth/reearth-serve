import type { Job } from "../job/model";

/**
 * A row the SHA-256 backfill (ADR-017 P4) is to hash: an asset row (its first
 * upload) or a version row, stored before ADR-017 and still without a hash.
 * `filename` is what the row's object key is built from; `projectId` and
 * `sessionId` are the asset's, so the backfill job is listed and authorized
 * like the asset's other jobs.
 */
export interface BackfillTarget {
  assetId: string;
  versionId?: string;
  filename: string;
  projectId?: string;
  sessionId?: string;
}

/**
 * The ledger side of the backfill. Selection and the final write are their
 * own statements because both carry conditions the generic stores do not
 * express: "no hash and no backfill job yet", and "still no hash and still the
 * same object".
 */
export interface IntegrityBackfillStore {
  /**
   * Up to `limit` rows with no `sha256`, no `integrity`, no blob key, and no
   * `integrity-backfill` job of any status. A row gets one job, ever: the job
   * row is the "in flight" marker while it runs and the "do not retry" marker
   * once it is closed (object missing, retries spent). Asset rows come first,
   * oldest first.
   */
  listUnhashed(limit: number): Promise<BackfillTarget[]>;
  /** Backfill jobs not yet closed: not completed, and with retry budget left. */
  countOpen(maxRetries: number): Promise<number>;
  /**
   * Record `sha256` as `verified` on the target row, only while it still has
   * no hash and still names the same object (same filename, no blob key), and
   * save `job` in the same batch. Returns whether the row was written; the job
   * is saved either way.
   */
  complete(input: { target: BackfillTarget; sha256: string; job: Job }): Promise<boolean>;
}
