import type { AtomicWrites, BlobAttach } from "../../core/asset/repository";
import type { SqlClient, SqlStatement } from "../../core/sql/port";
import {
  ASSET_UPSERT_SQL, assetUpsertArgs,
  JOB_UPSERT_SQL, jobUpsertArgs,
  VERSION_INSERT_SQL, versionInsertArgs, assignedVersion,
  VERSION_EXTRACTION_UPDATE_SQL, versionExtractionUpdateArgs,
  USAGE_INCREMENT_SQL, usageIncrementArgs,
  CLEANUP_PENDING_ADD_SQL,
} from "./stores";
import { parseSiteHost, SITE_HOSTS_RELEASE_BY_ASSET_SQL } from "./site-hosts";
import {
  blobAdoptStatements, blobAttachExistingStatements, blobAttachStatement, blobReleaseForAssetStatements,
  blobReleaseForVersionStatements, blobRetireStatement,
} from "./blob-refs";

// Runs before the version and asset rows are deleted in the same batch: it
// reads their sizes, and the EXISTS guard skips it once the asset is gone.
const USAGE_DECREMENT_FOR_ASSET_SQL =
  `UPDATE storage_usage
     SET total_size = MAX(0, total_size - ?2
           - (SELECT COALESCE(SUM(size), 0) FROM asset_versions WHERE asset_id = ?3)),
         asset_count = MAX(0, asset_count - 1),
         updated_at = ?4
     WHERE scope = ?1 AND EXISTS (SELECT 1 FROM assets WHERE id = ?3)`;

// The version's share, guarded like the asset's: once the row is gone a
// repeated delete changes nothing.
const USAGE_DECREMENT_FOR_VERSION_SQL =
  `UPDATE storage_usage
     SET total_size = MAX(0, total_size - ?2),
         asset_count = MAX(0, asset_count - 1),
         updated_at = ?4
     WHERE scope = ?1 AND EXISTS (SELECT 1 FROM asset_versions WHERE id = ?3)`;

/**
 * `AtomicWrites` over the SQL port: every composite write is one `batch()`,
 * which is atomic on D1 and one round trip on a Hrana server (ADR-012 §3).
 *
 * The statements are exactly the ones the individual stores issue — the SQL
 * lives in `stores.ts` and is shared, so the two paths cannot drift.
 */
export class SqlAtomicWrites implements AtomicWrites {
  constructor(private db: SqlClient) {}

  async createAsset({ asset, job, verificationJob, usageScopes, blob }: Parameters<AtomicWrites["createAsset"]>[0]): Promise<void> {
    const statements: SqlStatement[] = [];
    // The job row first: the asset's `jobId` points at it.
    if (job) statements.push({ sql: JOB_UPSERT_SQL, args: jobUpsertArgs(job) });
    if (verificationJob) statements.push({ sql: JOB_UPSERT_SQL, args: jobUpsertArgs(verificationJob) });
    statements.push({ sql: ASSET_UPSERT_SQL, args: assetUpsertArgs(asset) });
    statements.push(...usageStatements(usageScopes, asset.size));
    if (blob) statements.push(...blobStatements(blob));
    await this.db.batch(statements);
  }

  async createVersion({ version, job, usageScopes, blob }: Parameters<AtomicWrites["createVersion"]>[0]) {
    const statements: SqlStatement[] = [];
    if (job) statements.push({ sql: JOB_UPSERT_SQL, args: jobUpsertArgs(job) });
    const versionIndex = statements.length;
    statements.push({ sql: VERSION_INSERT_SQL, args: versionInsertArgs(version) });
    statements.push(...usageStatements(usageScopes, version.size));
    if (blob) statements.push(...blobStatements(blob));

    const results = await this.db.batch(statements);
    return { ...version, version: assignedVersion(results[versionIndex].rows) };
  }

  async deleteAsset({ asset, usageScopes, cleanupPrefix, releasedAt }: Parameters<AtomicWrites["deleteAsset"]>[0]) {
    const now = Date.now();
    const statements: SqlStatement[] = (usageScopes ?? []).map((scope) => ({
      sql: USAGE_DECREMENT_FOR_ASSET_SQL,
      args: [scope, asset.size, asset.id, now],
    }));
    // Blob references are released while the rows that hold them still exist.
    statements.push(...blobReleaseForAssetStatements(asset.id, now));
    const releaseIndex = statements.length;
    statements.push(
      { sql: SITE_HOSTS_RELEASE_BY_ASSET_SQL, args: [asset.id, releasedAt ?? now] },
      { sql: "DELETE FROM asset_versions WHERE asset_id = ?1", args: [asset.id] },
      { sql: "DELETE FROM assets WHERE id = ?1", args: [asset.id] },
      { sql: CLEANUP_PENDING_ADD_SQL, args: [cleanupPrefix, now] },
    );
    const results = await this.db.batch(statements);
    return { releasedSiteHosts: results[releaseIndex].rows.map(parseSiteHost) };
  }

  async deleteVersion({ version, usageScopes }: Parameters<AtomicWrites["deleteVersion"]>[0]): Promise<boolean> {
    const now = Date.now();
    const statements: SqlStatement[] = [
      ...(usageScopes ?? []).map((scope) => ({
        sql: USAGE_DECREMENT_FOR_VERSION_SQL,
        args: [scope, version.size, version.id, now],
      })),
      ...blobReleaseForVersionStatements(version.id, now),
      { sql: "DELETE FROM asset_versions WHERE id = ?1", args: [version.id] },
    ];
    const results = await this.db.batch(statements);
    return results[results.length - 1].rowsAffected > 0;
  }

  async saveJob({ job, asset, version, adopt }: Parameters<AtomicWrites["saveJob"]>[0]): Promise<void> {
    const statements: SqlStatement[] = [{ sql: JOB_UPSERT_SQL, args: jobUpsertArgs(job) }];
    if (asset) statements.push({ sql: ASSET_UPSERT_SQL, args: assetUpsertArgs(asset) });
    // After the upsert, so the guard sees the hash this write records.
    if (asset && adopt) statements.push(...blobAdoptStatements(asset.id, adopt.ref, adopt.since, adopt.retire, Date.now()));
    if (version) statements.push({ sql: VERSION_EXTRACTION_UPDATE_SQL, args: versionExtractionUpdateArgs(version) });
    await this.db.batch(statements);
  }
}

// A blob the upload wrote (or a claim it completes) is attached
// unconditionally; one it found already stored only while that blob still
// qualifies, failing the batch otherwise (ADR-017 §4). A classic object the
// row no longer needs is retired in the same batch.
function blobStatements(blob: BlobAttach): SqlStatement[] {
  const now = Date.now();
  return [
    ...(blob.existing
      ? blobAttachExistingStatements(blob.ref, blob.existing.since, now)
      : [blobAttachStatement(blob.ref, blob.state, now)]),
    ...(blob.retire ? [blobRetireStatement(blob.retire, now)] : []),
  ];
}

function usageStatements(scopes: string[] | undefined, sizeBytes: number): SqlStatement[] {
  const now = Date.now();
  return (scopes ?? []).map((scope) => ({
    sql: USAGE_INCREMENT_SQL,
    args: usageIncrementArgs(scope, sizeBytes, now),
  }));
}
