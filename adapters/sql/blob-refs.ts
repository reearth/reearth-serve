/**
 * The blob ledger over the `SqlClient` port (ADR-017 §3, §5; migration 0009).
 *
 * `SqlBlobRefStore` holds the transitions that happen outside a row write.
 * The reference-count statements that ride inside `SqlAtomicWrites` live here
 * too, so every statement that touches `blob_refs` is in one file.
 */
import { attachThreshold, type BlobRefKey } from "../../core/blob/model";
import type { BlobRef, BlobRefStore, BlobState } from "../../core/blob/repository";
import type { Row, SqlClient, SqlStatement, SqlValue } from "../../core/sql/port";
import { queryAll, queryFirst } from "./helpers";

// ---------------------------------------------------------------------------
// Statements used by SqlAtomicWrites
// ---------------------------------------------------------------------------

/**
 * One more row references `ref.key` (an asset or version row is created with
 * it as `blob_key`, in the same batch).
 *
 * An upsert, so the count stays right whatever the row looked like: the
 * caller reserved (`ready`) or claimed (`uploading`) the key first, and the
 * claim completes here — `uploading` becomes `state`, which is `ready` when
 * the store vouched for the bytes and `verifying` when the integrity job still
 * has to. A row in any other state keeps it.
 */
export function blobAttachStatement(ref: BlobRefKey, state: "ready" | "verifying", now: number): SqlStatement {
  return {
    sql: `INSERT INTO blob_refs (key, scope, sha256, ref_count, state, created_at, updated_at)
            VALUES (?1, ?2, ?3, 1, ?4, ?5, ?5)
            ON CONFLICT(key) DO UPDATE SET
              ref_count = ref_count + 1,
              state = CASE WHEN state = 'uploading' THEN excluded.state ELSE state END,
              claim_id = NULL,
              claim_expires_at = NULL,
              zero_since = NULL,
              updated_at = excluded.updated_at`,
    args: [ref.key, ref.scope, ref.sha256, state, now],
  };
}

/**
 * One more row references a blob whose bytes the upload did not write,
 * because the blob already held them (ADR-017 §4): a direct upload that
 * discarded its body, or a presigned upload adopting the blob at completion.
 * Unlike `blobAttachStatement` this is conditional: the blob must still be
 * `ready`, and either referenced by another row or unreferenced only since
 * after the upload looked it up at `since` (`stillAttachable`,
 * core/blob/usecase.ts — such a blob's object is protected by the grace
 * period). If it does not qualify, a statement here fails and takes the whole
 * batch with it, so the row is never committed without its bytes.
 *
 * D1 has no interactive transactions and SQLite's `RAISE()` works only inside
 * triggers, so the failure is a NOT NULL violation on `blob_refs.state`:
 *
 * 1. no row for the key at all → the INSERT tries to add one with a NULL state;
 * 2. a row that does not qualify → the UPDATE sets its state to NULL.
 *
 * Either aborts the batch. A qualifying row is incremented and keeps its state.
 * The caller tells this failure from others by reading the row again
 * (`reuseFailure`, core/blob/usecase.ts), so nothing here depends on the
 * driver's error wording.
 *
 * `guard`, when given, is an extra SQL condition that must hold for anything
 * to happen at all; when it does not, both statements do nothing and the
 * batch goes on. Adoption on an existing
 * asset row uses it (`blobAdoptStatements`).
 */
export function blobAttachExistingStatements(
  ref: BlobRefKey,
  since: number,
  now: number,
  guard?: SqlGuard,
): SqlStatement[] {
  const insertGuard = guard?.(5);
  const updateGuard = guard?.(4);
  return [
    {
      sql: `INSERT INTO blob_refs (key, scope, sha256, ref_count, state, created_at, updated_at)
              SELECT ?1, ?2, ?3, 0, NULL, ?4, ?4
               WHERE NOT EXISTS (SELECT 1 FROM blob_refs WHERE key = ?1)${insertGuard ? ` AND ${insertGuard.sql}` : ""}`,
      args: [ref.key, ref.scope, ref.sha256, now, ...(insertGuard?.args ?? [])],
    },
    {
      sql: `UPDATE blob_refs
               SET ref_count = ref_count + 1,
                   state = CASE WHEN state = 'ready' AND (ref_count > 0 OR zero_since >= ?3) THEN state ELSE NULL END,
                   zero_since = NULL,
                   updated_at = ?2
             WHERE key = ?1${updateGuard ? ` AND ${updateGuard.sql}` : ""}`,
      args: [ref.key, now, attachThreshold(since), ...(updateGuard?.args ?? [])],
    },
  ];
}

/**
 * An extra condition for a statement, built for the parameter number its
 * arguments start at (each statement has its own parameters before it).
 */
type SqlGuard = (firstParam: number) => { sql: string; args: SqlValue[] };

/**
 * A classic object superseded by adoption, recorded for deletion after the
 * grace period: a `retired` row at zero references whose `zero_since` is now.
 * The grace sweep deletes it like an unreferenced blob. Its key is the
 * classic key, which no lookup of a blob ever produces, so nothing reserves
 * or attaches to it. `INSERT OR IGNORE`: a repeat changes nothing.
 */
export function blobRetireStatement(retired: BlobRefKey, now: number, guard?: SqlGuard): SqlStatement {
  const g = guard?.(5);
  return {
    sql: `INSERT OR IGNORE INTO blob_refs (key, scope, sha256, ref_count, state, zero_since, created_at, updated_at)
            SELECT ?1, ?2, ?3, 0, 'retired', ?4, ?4, ?4${g ? ` WHERE ${g.sql}` : ""}`,
    args: [retired.key, retired.scope, retired.sha256, now, ...(g?.args ?? [])],
  };
}

/**
 * Switch an existing asset row from its classic object to the scope's blob
 * with the same bytes (adoption after the integrity job confirmed the hash),
 * in the batch that settles the job. Three steps, each guarded by the same
 * condition — the asset still exists, still has no `blob_key`, and its hash is
 * the blob's — evaluated before the last step changes it:
 *
 * 1. attach to the blob (`blobAttachExistingStatements`; fails the batch if
 *    the blob no longer qualifies);
 * 2. retire the classic object (`blobRetireStatement`);
 * 3. set `blob_key`.
 *
 * A row that was deleted, or already adopted, meanwhile makes all three do
 * nothing, so a repeat cannot count a reference twice or retire bytes a row
 * still reads.
 */
export function blobAdoptStatements(assetId: string, ref: BlobRefKey, since: number, retired: BlobRefKey, now: number): SqlStatement[] {
  const stillClassic: SqlGuard = (first) => ({
    sql: `EXISTS (SELECT 1 FROM assets WHERE id = ?${first} AND blob_key IS NULL AND sha256 = ?${first + 1})`,
    args: [assetId, ref.sha256],
  });
  return [
    ...blobAttachExistingStatements(ref, since, now, stillClassic),
    blobRetireStatement(retired, now, stillClassic),
    {
      sql: "UPDATE assets SET blob_key = ?1 WHERE id = ?2 AND blob_key IS NULL AND sha256 = ?3",
      args: [ref.key, assetId, ref.sha256],
    },
  ];
}

// The keys an asset's rows hold: its own and every version's.
const ASSET_BLOB_KEYS =
  `SELECT blob_key FROM assets WHERE id = ?1 AND blob_key IS NOT NULL
   UNION ALL
   SELECT blob_key FROM asset_versions WHERE asset_id = ?1 AND blob_key IS NOT NULL`;

/**
 * Release every reference an asset's rows hold, before those rows are
 * deleted in the same batch. Computed from the rows themselves rather than
 * from a list the caller read earlier, so a version created in between is
 * counted too. A blob that reaches zero starts its grace period.
 */
export function blobReleaseForAssetStatements(assetId: string, now: number): SqlStatement[] {
  return [
    {
      sql: `UPDATE blob_refs
               SET ref_count = MAX(0, ref_count - (SELECT COUNT(*) FROM (${ASSET_BLOB_KEYS}) k WHERE k.blob_key = blob_refs.key)),
                   updated_at = ?2
             WHERE key IN (${ASSET_BLOB_KEYS})`,
      args: [assetId, now],
    },
    {
      sql: `UPDATE blob_refs SET zero_since = ?2
             WHERE ref_count = 0 AND zero_since IS NULL AND key IN (${ASSET_BLOB_KEYS})`,
      args: [assetId, now],
    },
  ];
}

/** Release the reference one version row holds, before it is deleted in the same batch. */
export function blobReleaseForVersionStatements(versionId: string, now: number): SqlStatement[] {
  const key = "(SELECT blob_key FROM asset_versions WHERE id = ?1)";
  return [
    {
      sql: `UPDATE blob_refs SET ref_count = MAX(0, ref_count - 1), updated_at = ?2 WHERE key = ${key}`,
      args: [versionId, now],
    },
    {
      sql: `UPDATE blob_refs SET zero_since = ?2 WHERE ref_count = 0 AND zero_since IS NULL AND key = ${key}`,
      args: [versionId, now],
    },
  ];
}

// ---------------------------------------------------------------------------
// SqlBlobRefStore
// ---------------------------------------------------------------------------

export class SqlBlobRefStore implements BlobRefStore {
  constructor(private db: SqlClient) {}

  async find(key: string): Promise<BlobRef | null> {
    const row = await queryFirst(this.db, "SELECT * FROM blob_refs WHERE key = ?1", [key]);
    return row ? parseBlobRef(row) : null;
  }

  async reserve(ref: BlobRefKey, now: number): Promise<boolean> {
    // Insert as `ready` with nothing referencing it and the grace clock at
    // `now`; or, on an existing `ready` row (or a lapsed claim), restart the
    // clock if nothing references it. Any other state is left alone and the
    // statement changes nothing.
    const result = await this.db.execute(
      `INSERT INTO blob_refs (key, scope, sha256, ref_count, state, zero_since, created_at, updated_at)
         VALUES (?1, ?2, ?3, 0, 'ready', ?4, ?4, ?4)
         ON CONFLICT(key) DO UPDATE SET
           state = 'ready',
           claim_id = NULL,
           claim_expires_at = NULL,
           zero_since = CASE WHEN ref_count = 0 THEN excluded.zero_since ELSE zero_since END,
           updated_at = excluded.updated_at
         WHERE state = 'ready' OR (state = 'uploading' AND claim_expires_at < excluded.updated_at)`,
      [ref.key, ref.scope, ref.sha256, now],
    );
    return result.rowsAffected > 0;
  }

  async markVerified(key: string, now: number): Promise<void> {
    await this.db.execute(
      "UPDATE blob_refs SET state = 'ready', updated_at = ?2 WHERE key = ?1 AND state = 'verifying'",
      [key, now],
    );
  }

  async markDeleting(key: string, zeroBefore: number, now: number): Promise<boolean> {
    const result = await this.db.execute(
      `UPDATE blob_refs SET state = 'deleting', updated_at = ?3
         WHERE key = ?1 AND ref_count = 0 AND state IN ('ready', 'verifying', 'retired')
           AND zero_since IS NOT NULL AND zero_since <= ?2`,
      [key, zeroBefore, now],
    );
    return result.rowsAffected > 0;
  }

  async markOrphanDeleting(ref: BlobRefKey, now: number): Promise<boolean> {
    const result = await this.db.execute(
      `INSERT OR IGNORE INTO blob_refs (key, scope, sha256, ref_count, state, created_at, updated_at)
         VALUES (?1, ?2, ?3, 0, 'deleting', ?4, ?4)`,
      [ref.key, ref.scope, ref.sha256, now],
    );
    return result.rowsAffected > 0;
  }

  async removeDeleted(key: string): Promise<void> {
    await this.db.execute("DELETE FROM blob_refs WHERE key = ?1 AND state = 'deleting' AND ref_count = 0", [key]);
  }

  async listSweepable(zeroBefore: number, limit: number): Promise<string[]> {
    const rows = await queryAll(
      this.db,
      `SELECT key FROM blob_refs
         WHERE ref_count = 0
           AND (state = 'deleting'
                OR (state IN ('ready', 'verifying', 'retired') AND zero_since IS NOT NULL AND zero_since <= ?1))
         ORDER BY zero_since ASC
         LIMIT ?2`,
      [zeroBefore, limit],
    );
    return rows.map((r) => r.key as string);
  }

  async dropExpiredClaims(now: number, limit: number): Promise<number> {
    const result = await this.db.execute(
      `DELETE FROM blob_refs WHERE key IN (
         SELECT key FROM blob_refs
          WHERE state = 'uploading' AND ref_count = 0 AND claim_expires_at < ?1
          LIMIT ?2)`,
      [now, limit],
    );
    return result.rowsAffected;
  }

  async existing(keys: string[]): Promise<Set<string>> {
    if (keys.length === 0) return new Set();
    // One JSON parameter, so D1's 100-parameter cap never limits a page.
    const rows = await queryAll(
      this.db,
      "SELECT key FROM blob_refs WHERE key IN (SELECT value FROM json_each(?1))",
      [JSON.stringify(keys)] as SqlValue[],
    );
    return new Set(rows.map((r) => r.key as string));
  }
}

function parseBlobRef(row: Row): BlobRef {
  return {
    key: row.key as string,
    scope: row.scope as string,
    sha256: row.sha256 as string,
    refCount: Number(row.ref_count ?? 0),
    state: row.state as BlobState,
    ...(row.claim_id != null && { claimId: row.claim_id as string }),
    ...(row.claim_expires_at != null && { claimExpiresAt: Number(row.claim_expires_at) }),
    ...(row.zero_since != null && { zeroSince: Number(row.zero_since) }),
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
  };
}
