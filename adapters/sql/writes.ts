import type { AtomicWrites } from "../../core/asset/repository";
import type { SqlClient, SqlStatement } from "../../core/sql/port";
import {
  ASSET_UPSERT_SQL, assetUpsertArgs,
  JOB_UPSERT_SQL, jobUpsertArgs,
  VERSION_INSERT_SQL, versionInsertArgs, assignedVersion,
  USAGE_INCREMENT_SQL, usageIncrementArgs,
  CLEANUP_PENDING_ADD_SQL,
} from "./stores";

// Runs before the version and asset rows are deleted in the same batch: it
// reads their sizes, and the EXISTS guard skips it once the asset is gone.
const USAGE_DECREMENT_FOR_ASSET_SQL =
  `UPDATE storage_usage
     SET total_size = MAX(0, total_size - ?2
           - (SELECT COALESCE(SUM(size), 0) FROM asset_versions WHERE asset_id = ?3)),
         asset_count = MAX(0, asset_count - 1),
         updated_at = ?4
     WHERE scope = ?1 AND EXISTS (SELECT 1 FROM assets WHERE id = ?3)`;

/**
 * `AtomicWrites` over the SQL port: every composite write is one `batch()`,
 * which is atomic on D1 and one round trip on a Hrana server (ADR-012 §3).
 *
 * The statements are exactly the ones the individual stores issue — the SQL
 * lives in `stores.ts` and is shared, so the two paths cannot drift.
 */
export class SqlAtomicWrites implements AtomicWrites {
  constructor(private db: SqlClient) {}

  async createAsset({ asset, job, usageScopes }: Parameters<AtomicWrites["createAsset"]>[0]): Promise<void> {
    const statements: SqlStatement[] = [];
    // The job row first: the asset's `jobId` points at it.
    if (job) statements.push({ sql: JOB_UPSERT_SQL, args: jobUpsertArgs(job) });
    statements.push({ sql: ASSET_UPSERT_SQL, args: assetUpsertArgs(asset) });
    statements.push(...usageStatements(usageScopes, asset.size));
    await this.db.batch(statements);
  }

  async createVersion({ version, job, usageScopes }: Parameters<AtomicWrites["createVersion"]>[0]) {
    const statements: SqlStatement[] = [];
    if (job) statements.push({ sql: JOB_UPSERT_SQL, args: jobUpsertArgs(job) });
    const versionIndex = statements.length;
    statements.push({ sql: VERSION_INSERT_SQL, args: versionInsertArgs(version) });
    statements.push(...usageStatements(usageScopes, version.size));

    const results = await this.db.batch(statements);
    return { ...version, version: assignedVersion(results[versionIndex].rows) };
  }

  async deleteAsset({ asset, usageScopes, cleanupPrefix }: Parameters<AtomicWrites["deleteAsset"]>[0]): Promise<void> {
    const now = Date.now();
    const statements: SqlStatement[] = (usageScopes ?? []).map((scope) => ({
      sql: USAGE_DECREMENT_FOR_ASSET_SQL,
      args: [scope, asset.size, asset.id, now],
    }));
    statements.push(
      { sql: "DELETE FROM asset_versions WHERE asset_id = ?1", args: [asset.id] },
      { sql: "DELETE FROM assets WHERE id = ?1", args: [asset.id] },
      { sql: CLEANUP_PENDING_ADD_SQL, args: [cleanupPrefix, now] },
    );
    await this.db.batch(statements);
  }

  async saveJob({ job, asset }: Parameters<AtomicWrites["saveJob"]>[0]): Promise<void> {
    const statements: SqlStatement[] = [{ sql: JOB_UPSERT_SQL, args: jobUpsertArgs(job) }];
    if (asset) statements.push({ sql: ASSET_UPSERT_SQL, args: assetUpsertArgs(asset) });
    await this.db.batch(statements);
  }
}

function usageStatements(scopes: string[] | undefined, sizeBytes: number): SqlStatement[] {
  const now = Date.now();
  return (scopes ?? []).map((scope) => ({
    sql: USAGE_INCREMENT_SQL,
    args: usageIncrementArgs(scope, sizeBytes, now),
  }));
}
