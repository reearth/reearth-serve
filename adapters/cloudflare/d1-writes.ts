import type { AtomicWrites } from "../../core/asset/repository";
import type { SqlClient, SqlStatement } from "../../core/sql/port";
import {
  ASSET_UPSERT_SQL, assetUpsertArgs,
  JOB_UPSERT_SQL, jobUpsertArgs,
  VERSION_INSERT_SQL, versionInsertArgs, assignedVersion,
  USAGE_INCREMENT_SQL, usageIncrementArgs,
} from "./d1";

/**
 * `AtomicWrites` over the SQL port: every composite write is one `batch()`,
 * which is atomic on D1 and one round trip on a Hrana server (ADR-012 §3).
 *
 * The statements are exactly the ones the individual stores issue — the SQL
 * lives in `d1.ts` and is shared, so the two paths cannot drift.
 */
export class D1AtomicWrites implements AtomicWrites {
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
