/**
 * `IntegrityBackfillStore` over the SQL port (ADR-017 P4). The selection is
 * served by the partial indexes of migration 0010.
 */
import type { BackfillTarget, IntegrityBackfillStore } from "../../core/integrity/repository";
import type { Job } from "../../core/job/model";
import type { SqlClient, SqlStatement } from "../../core/sql/port";
import { queryAll, queryFirst } from "./helpers";
import { JOB_UPSERT_SQL, jobUpsertArgs } from "./stores";

const BACKFILL_JOB_TYPE = "integrity-backfill";

// Each arm is limited on its own so SQLite can stop early in the partial
// index; the outer LIMIT takes assets first. The `sha256 IS NULL AND integrity
// IS NULL` terms are the index predicate and must stay spelled that way for
// the index to be used.
export const LIST_UNHASHED_SQL =
  `SELECT * FROM (
     SELECT a.id AS asset_id, NULL AS version_id, a.filename AS filename,
            a.project_id AS project_id, a.session_id AS session_id
       FROM assets a
      WHERE a.sha256 IS NULL AND a.integrity IS NULL AND a.blob_key IS NULL
        AND NOT EXISTS (SELECT 1 FROM jobs j
                         WHERE j.asset_id = a.id AND j.version_id IS NULL AND j.type = ?2)
      ORDER BY a.created_at ASC
      LIMIT ?1)
   UNION ALL
   SELECT * FROM (
     SELECT v.asset_id AS asset_id, v.id AS version_id, v.filename AS filename,
            a.project_id AS project_id, a.session_id AS session_id
       FROM asset_versions v
       JOIN assets a ON a.id = v.asset_id
      WHERE v.sha256 IS NULL AND v.integrity IS NULL AND v.blob_key IS NULL
        AND NOT EXISTS (SELECT 1 FROM jobs j WHERE j.version_id = v.id AND j.type = ?2)
      ORDER BY v.created_at ASC
      LIMIT ?1)
   LIMIT ?1`;

const COUNT_OPEN_SQL =
  `SELECT COUNT(*) AS n FROM jobs
    WHERE type = ?1 AND status IN ('pending', 'running', 'failed') AND COALESCE(retry_count, 0) <= ?2`;

// The write lands only on a row that still has no hash and still names the
// object that was hashed. A row that was deleted, replaced, or hashed by
// something else meanwhile is left alone. `verified` is never undone by later
// upserts (ASSET_UPSERT_SQL keeps a verified row's hash).
const ASSET_RECORD_SQL =
  `UPDATE assets SET sha256 = ?2, integrity = 'verified'
    WHERE id = ?1 AND filename = ?3
      AND sha256 IS NULL AND integrity IS NULL AND blob_key IS NULL`;

const VERSION_RECORD_SQL =
  `UPDATE asset_versions SET sha256 = ?2, integrity = 'verified'
    WHERE id = ?1 AND asset_id = ?4 AND filename = ?3
      AND sha256 IS NULL AND integrity IS NULL AND blob_key IS NULL`;

export class SqlIntegrityBackfillStore implements IntegrityBackfillStore {
  constructor(private db: SqlClient) {}

  async listUnhashed(limit: number): Promise<BackfillTarget[]> {
    if (limit <= 0) return [];
    const rows = await queryAll(this.db, LIST_UNHASHED_SQL, [limit, BACKFILL_JOB_TYPE]);
    return rows.map((r) => ({
      assetId: String(r.asset_id),
      ...(r.version_id != null && { versionId: String(r.version_id) }),
      filename: String(r.filename),
      ...(r.project_id != null && { projectId: String(r.project_id) }),
      ...(r.session_id != null && { sessionId: String(r.session_id) }),
    }));
  }

  async countOpen(maxRetries: number): Promise<number> {
    const row = await queryFirst(this.db, COUNT_OPEN_SQL, [BACKFILL_JOB_TYPE, maxRetries]);
    return Number(row?.n ?? 0);
  }

  async complete({ target, sha256, job }: { target: BackfillTarget; sha256: string; job: Job }): Promise<boolean> {
    const record: SqlStatement = target.versionId
      ? { sql: VERSION_RECORD_SQL, args: [target.versionId, sha256, target.filename, target.assetId] }
      : { sql: ASSET_RECORD_SQL, args: [target.assetId, sha256, target.filename] };
    const results = await this.db.batch([record, { sql: JOB_UPSERT_SQL, args: jobUpsertArgs(job) }]);
    return results[0].rowsAffected > 0;
  }
}
