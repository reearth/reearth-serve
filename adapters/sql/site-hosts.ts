/**
 * `SiteHostStore` over the `SqlClient` port (ADR-013 B2, ADR-012 §3).
 *
 * Its own file rather than another class in `stores.ts`: that file is already
 * the four asset/job/project stores and is close to the size where this repo
 * splits. Nothing here is Cloudflare-specific — the dialect is SQLite and the
 * transport is D1 or `node:sqlite` depending on who constructs it.
 */
import type { SiteHost, SiteHostPatch, SiteHostStore } from "../../core/site/repository";
import type { SqlClient, SqlValue } from "../../core/sql/port";
import type { Row } from "../../core/sql/port";
import { queryAll, queryFirst } from "./helpers";

const COLUMNS =
  "hostname, asset_id, project_id, kind, verified_at, disabled_at, previews, released_at, " +
  "created_at, created_by, verification_token, certificate_status";

export class SqlSiteHostStore implements SiteHostStore {
  constructor(private db: SqlClient) {}

  async find(hostname: string): Promise<SiteHost | null> {
    const row = await queryFirst(this.db, `SELECT ${COLUMNS} FROM site_hosts WHERE hostname = ?1`, [hostname]);
    return row ? parse(row) : null;
  }

  async listByAsset(assetId: string): Promise<SiteHost[]> {
    const rows = await queryAll(
      this.db,
      `SELECT ${COLUMNS} FROM site_hosts WHERE asset_id = ?1 AND released_at IS NULL ORDER BY created_at ASC`,
      [assetId],
    );
    return rows.map(parse);
  }

  async listByProject(projectId: string): Promise<SiteHost[]> {
    const rows = await queryAll(
      this.db,
      `SELECT ${COLUMNS} FROM site_hosts WHERE project_id = ?1 AND released_at IS NULL ORDER BY created_at ASC`,
      [projectId],
    );
    return rows.map(parse);
  }

  async insert(host: SiteHost): Promise<boolean> {
    // OR IGNORE, not OR REPLACE: the primary key is the uniqueness rule that
    // stops two projects from holding one name, released rows included. A
    // caller that loses the race is told the name is taken.
    const result = await this.db.execute(
      `INSERT OR IGNORE INTO site_hosts (${COLUMNS})
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12)`,
      [
        host.hostname, host.assetId, host.projectId, host.kind,
        host.verifiedAt, host.disabledAt, host.previews ? 1 : 0,
        host.releasedAt, host.createdAt, host.createdBy,
        host.verificationToken, host.certificateStatus,
      ] as SqlValue[],
    );
    return result.rowsAffected > 0;
  }

  async update(hostname: string, patch: SiteHostPatch): Promise<void> {
    const sets: string[] = [];
    const binds: SqlValue[] = [hostname];

    if (patch.disabledAt !== undefined) {
      binds.push(patch.disabledAt);
      sets.push(`disabled_at = ?${binds.length}`);
    }
    if (patch.previews !== undefined) {
      binds.push(patch.previews ? 1 : 0);
      sets.push(`previews = ?${binds.length}`);
    }
    if (patch.verifiedAt !== undefined) {
      binds.push(patch.verifiedAt);
      sets.push(`verified_at = ?${binds.length}`);
    }
    if (patch.certificateStatus !== undefined) {
      binds.push(patch.certificateStatus);
      sets.push(`certificate_status = ?${binds.length}`);
    }
    if (sets.length === 0) return;

    // `released_at IS NULL`: a name that was released between the caller's read
    // and this write must stay released rather than come back enabled.
    await this.db.execute(
      `UPDATE site_hosts SET ${sets.join(", ")} WHERE hostname = ?1 AND released_at IS NULL`,
      binds,
    );
  }

  async remove(hostname: string): Promise<void> {
    await this.db.execute("DELETE FROM site_hosts WHERE hostname = ?1", [hostname]);
  }

  async release(hostname: string, releasedAt: number): Promise<void> {
    await this.db.execute(
      "UPDATE site_hosts SET released_at = ?2, asset_id = NULL WHERE hostname = ?1 AND released_at IS NULL",
      [hostname, releasedAt],
    );
  }

  async releaseByAsset(assetId: string, releasedAt: number): Promise<string[]> {
    // One statement so a concurrent claim cannot slip between the read and the
    // write; RETURNING gives back the hostnames whose cache entries must go.
    const rows = await queryAll(
      this.db,
      `UPDATE site_hosts SET released_at = ?2, asset_id = NULL
         WHERE asset_id = ?1 AND released_at IS NULL
         RETURNING hostname`,
      [assetId, releasedAt],
    );
    return rows.map((row) => row.hostname as string);
  }

  async countActiveByProject(projectId: string): Promise<number> {
    const row = await queryFirst(
      this.db,
      "SELECT COUNT(*) AS cnt FROM site_hosts WHERE project_id = ?1 AND released_at IS NULL",
      [projectId],
    );
    return (row?.cnt as number) ?? 0;
  }

  async purgeReleasedBefore(before: number, limit: number): Promise<string[]> {
    const rows = await queryAll(
      this.db,
      `DELETE FROM site_hosts
         WHERE hostname IN (
           SELECT hostname FROM site_hosts
             WHERE released_at IS NOT NULL AND released_at < ?1
             ORDER BY released_at ASC LIMIT ?2
         )
         RETURNING hostname`,
      [before, limit],
    );
    return rows.map((row) => row.hostname as string);
  }
}

function parse(row: Row): SiteHost {
  return {
    hostname: row.hostname as string,
    assetId: (row.asset_id as string | null) ?? null,
    projectId: row.project_id as string,
    kind: row.kind as SiteHost["kind"],
    verifiedAt: (row.verified_at as number | null) ?? null,
    disabledAt: (row.disabled_at as number | null) ?? null,
    // SQLite has no boolean type; the column is 0/1.
    previews: Number(row.previews ?? 0) !== 0,
    releasedAt: (row.released_at as number | null) ?? null,
    createdAt: row.created_at as number,
    createdBy: (row.created_by as string | null) ?? null,
    verificationToken: (row.verification_token as string | null) ?? null,
    certificateStatus: (row.certificate_status as string | null) ?? null,
  };
}
