/**
 * The repository layer over the `SqlClient` port (ADR-012 §3).
 *
 * Nothing here is Cloudflare-specific: the dialect is SQLite and the transport
 * is whatever `SqlClient` is handed in — D1 on Cloudflare
 * (`adapters/cloudflare/sql.ts`), `node:sqlite` on the Node runtime
 * (`adapters/memory/sqlite-node.ts`). That is why these files live in
 * `adapters/sql/` rather than under a provider directory.
 */
import type { AssetMetadata, AssetVersion } from "../../core/asset/model";
import type { MetadataStore, StorageUsage, StorageUsageStore, VersionStore } from "../../core/asset/repository";
import type { ListResult } from "../../core/asset/repository";
import type { Job } from "../../core/job/model";
import type { JobStore } from "../../core/job/repository";
import type { Project } from "../../core/project/model";
import type { ProjectStore } from "../../core/project/repository";
import type { Workspace } from "../../core/workspace/model";
import type { WorkspaceStore } from "../../core/workspace/repository";
import type { Member } from "../../core/member/model";
import type { MemberStore } from "../../core/member/repository";
import type { SqlClient, SqlValue } from "../../core/sql/port";
import { rowToModel, modelToRow, encodeCursor, decodeCursor, queryAll, queryFirst } from "./helpers";

// Meta keys: fields stored in the JSON `meta` column instead of dedicated columns.
const ASSET_META_KEYS = ["contentEncoding", "originalSize", "archiveFormat", "fileCount", "extractedSize", "jobId"];
const VERSION_META_KEYS = ["contentEncoding", "originalSize", "archiveFormat", "fileCount", "extractedSize", "jobId"];
const JOB_META_KEYS = [
  "completedAt",
  "startedAt",
  "error",
  "totalFiles",
  "fileCount",
  "extractedSize",
  "retryFileCount",
  "retryExtractedSize",
];

// Cap unbounded list results so a runaway workspace/project doesn't ship the
// whole table on every request. Real pagination on these endpoints is tracked
// for a future change; for now we hard-cap to keep the API safe.
const MEMBER_LIST_LIMIT = 200;
const PROJECT_LIST_LIMIT = 200;

// Build the scope clause shared by assets/jobs listing. Returns null when no
// scope is provided — callers must treat that as an empty result so we never
// leak cross-tenant rows. Exactly one of the scope fields is honored, checked
// in priority order (sessionId → projectId → workspaceId → accessibleByUser)
// to keep behavior deterministic if a caller accidentally passes multiple.
function buildScopeClause(
  options: { sessionId?: string; projectId?: string; workspaceId?: string; accessibleByUser?: string } | undefined,
  startIdx: number,
): { clause: string; binds: SqlValue[] } | null {
  if (!options) return null;
  if (options.sessionId) {
    return { clause: `session_id = ?${startIdx}`, binds: [options.sessionId] };
  }
  if (options.projectId) {
    return { clause: `project_id = ?${startIdx}`, binds: [options.projectId] };
  }
  if (options.workspaceId) {
    // Caller is responsible for verifying the user is a member of this workspace.
    return {
      clause: `project_id IN (SELECT id FROM projects WHERE workspace_id = ?${startIdx})`,
      binds: [options.workspaceId],
    };
  }
  if (options.accessibleByUser) {
    return {
      clause:
        `project_id IN (SELECT id FROM projects WHERE workspace_id IN (SELECT workspace_id FROM members WHERE user_id = ?${startIdx}))`,
      binds: [options.accessibleByUser],
    };
  }
  return null;
}

// ---------------------------------------------------------------------------
// SqlWorkspaceStore
// ---------------------------------------------------------------------------

export class SqlWorkspaceStore implements WorkspaceStore {
  constructor(private db: SqlClient) {}

  async save(workspace: Workspace): Promise<void> {
    const row = modelToRow(workspace as unknown as Record<string, unknown>);
    await this.db.execute(
      `INSERT OR REPLACE INTO workspaces (id, name, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4)`,
      [row.id, row.name, row.created_at, row.updated_at] as SqlValue[],
    );
  }

  async find(id: string): Promise<Workspace | null> {
    const row = await queryFirst(this.db, "SELECT * FROM workspaces WHERE id = ?1", [id]);
    return row ? rowToModel<Workspace>(row) : null;
  }

  async delete(id: string): Promise<void> {
    await this.db.execute("DELETE FROM workspaces WHERE id = ?1", [id]);
  }
}

// ---------------------------------------------------------------------------
// SqlMemberStore
// ---------------------------------------------------------------------------

export class SqlMemberStore implements MemberStore {
  constructor(private db: SqlClient) {}

  async save(member: Member): Promise<void> {
    const row = modelToRow(member as unknown as Record<string, unknown>);
    await this.db.execute(
      `INSERT OR REPLACE INTO members (workspace_id, user_id, role, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5)`,
      [row.workspace_id, row.user_id, row.role, row.created_at, row.updated_at] as SqlValue[],
    );
  }

  async find(workspaceId: string, userId: string): Promise<Member | null> {
    const row = await queryFirst(
      this.db,
      "SELECT * FROM members WHERE workspace_id = ?1 AND user_id = ?2",
      [workspaceId, userId],
    );
    return row ? rowToModel<Member>(row) : null;
  }

  async list(workspaceId: string): Promise<Member[]> {
    const rows = await queryAll(
      this.db,
      "SELECT * FROM members WHERE workspace_id = ?1 ORDER BY created_at LIMIT ?2",
      [workspaceId, MEMBER_LIST_LIMIT],
    );
    return rows.map((r) => rowToModel<Member>(r));
  }

  async listByUser(userId: string): Promise<Member[]> {
    const rows = await queryAll(
      this.db,
      "SELECT * FROM members WHERE user_id = ?1 ORDER BY created_at LIMIT ?2",
      [userId, MEMBER_LIST_LIMIT],
    );
    return rows.map((r) => rowToModel<Member>(r));
  }

  async delete(workspaceId: string, userId: string): Promise<void> {
    await this.db.execute(
      "DELETE FROM members WHERE workspace_id = ?1 AND user_id = ?2",
      [workspaceId, userId],
    );
  }
}

// ---------------------------------------------------------------------------
// SqlProjectStore
// ---------------------------------------------------------------------------

export class SqlProjectStore implements ProjectStore {
  constructor(private db: SqlClient) {}

  async save(project: Project): Promise<void> {
    const row = modelToRow(project as unknown as Record<string, unknown>);
    await this.db.execute(
      `INSERT OR REPLACE INTO projects (id, name, created_at, updated_at, owner_id, workspace_id)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6)`,
      [row.id, row.name, row.created_at, row.updated_at, row.owner_id, row.workspace_id ?? null] as SqlValue[],
    );
  }

  async find(id: string): Promise<Project | null> {
    const row = await queryFirst(this.db, "SELECT * FROM projects WHERE id = ?1", [id]);
    return row ? rowToModel<Project>(row) : null;
  }

  async list(params: { ownerId?: string; workspaceId?: string }): Promise<Project[]> {
    let query: string;
    let bindValue: string;
    if (params.workspaceId) {
      query = "SELECT * FROM projects WHERE workspace_id = ?1 ORDER BY created_at DESC LIMIT ?2";
      bindValue = params.workspaceId;
    } else if (params.ownerId) {
      query = "SELECT * FROM projects WHERE owner_id = ?1 ORDER BY created_at DESC LIMIT ?2";
      bindValue = params.ownerId;
    } else {
      return [];
    }
    const rows = await queryAll(this.db, query, [bindValue, PROJECT_LIST_LIMIT]);
    return rows.map((r) => rowToModel<Project>(r));
  }

  async delete(id: string, _ownerId: string): Promise<void> {
    await this.db.execute("DELETE FROM projects WHERE id = ?1", [id]);
  }
}

// ---------------------------------------------------------------------------
// SqlJobStore
// ---------------------------------------------------------------------------

/** The row tuple written by `INSERT OR REPLACE INTO jobs`, shared with the batch writer. */
export const JOB_UPSERT_SQL =
  `INSERT OR REPLACE INTO jobs
         (id, asset_id, type, status, created_at, updated_at, retry_count, session_id, project_id, version_id, meta)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)`;

export function jobUpsertArgs(job: Job): SqlValue[] {
  const row = modelToRow(job as unknown as Record<string, unknown>, JOB_META_KEYS);
  return [
    row.id, row.asset_id, row.type, row.status,
    row.created_at, row.updated_at, row.retry_count ?? 0,
    row.session_id ?? null, row.project_id ?? null, row.version_id ?? null, row.meta ?? null,
  ] as SqlValue[];
}

export class SqlJobStore implements JobStore {
  constructor(private db: SqlClient) {}

  async save(job: Job): Promise<void> {
    await this.db.execute(JOB_UPSERT_SQL, jobUpsertArgs(job));
  }

  async find(id: string): Promise<Job | null> {
    const row = await queryFirst(this.db, "SELECT * FROM jobs WHERE id = ?1", [id]);
    return row ? rowToModel<Job>(row, JOB_META_KEYS) : null;
  }

  async delete(id: string): Promise<void> {
    await this.db.execute("DELETE FROM jobs WHERE id = ?1", [id]);
  }

  async list(options?: {
    limit?: number;
    cursor?: string;
    sessionId?: string;
    projectId?: string;
    workspaceId?: string;
    accessibleByUser?: string;
  }): Promise<ListResult<Job>> {
    const limit = options?.limit ?? 20;
    const scope = buildScopeClause(options, 1);
    if (!scope) return { items: [], cursor: undefined };

    const { clause, binds } = scope;
    let bindIdx = binds.length + 1;

    let cursorClause = "";
    if (options?.cursor) {
      const decoded = decodeCursor(options.cursor);
      if (decoded) {
        cursorClause = ` AND (created_at < ?${bindIdx} OR (created_at = ?${bindIdx} AND id < ?${bindIdx + 1}))`;
        binds.push(decoded.createdAt, decoded.id);
        bindIdx += 2;
      }
    }

    const sql = `SELECT * FROM jobs WHERE ${clause}${cursorClause} ORDER BY created_at DESC, id DESC LIMIT ?${bindIdx}`;
    binds.push(limit + 1);

    const rows = await queryAll(this.db, sql, binds);
    const hasMore = rows.length > limit;
    const items = rows.slice(0, limit).map((r) => rowToModel<Job>(r, JOB_META_KEYS));
    const cursor = hasMore && items.length > 0
      ? encodeCursor(items[items.length - 1].createdAt, items[items.length - 1].id)
      : undefined;

    return { items, cursor };
  }

  async listRetriable(stuckThresholdMs: number, maxRetries: number, limit: number = 50): Promise<Job[]> {
    const stuckBefore = Date.now() - stuckThresholdMs;
    // `retry_count <= ?1` (not <) admits jobs at the budget boundary so the
    // handler can mark them permanently failed; the handler then stores
    // maxRetries + 1 to take them out of this pool for good. The progress
    // clause re-admits any job whose fileCount/extractedSize moved past the
    // markers captured at its last re-enqueue — the handler resets the budget
    // for those (a death after progress is not the same failure repeating).
    //
    // `pending` is gated by the stuck threshold like `running`: a pending job
    // whose launch keeps failing on container capacity is actively retried by
    // the queue with backoff, and each failed attempt touches updated_at
    // (extraction/handler.ts). Picking pending jobs up immediately would
    // duplicate that work and burn the cron's retry budget while the queue is
    // still on it. `failed` stays immediate — the container reported a real
    // failure and there is no queue message in flight anymore.
    const rows = await queryAll(
      this.db,
      `SELECT * FROM jobs
         WHERE type = 'archive-extraction'
           AND (retry_count <= ?1
                OR COALESCE(json_extract(meta, '$.fileCount'), 0) >
                   COALESCE(json_extract(meta, '$.retryFileCount'), 0)
                OR COALESCE(json_extract(meta, '$.extractedSize'), 0) >
                   COALESCE(json_extract(meta, '$.retryExtractedSize'), 0))
           AND (status = 'failed'
                OR (status IN ('pending', 'running') AND updated_at < ?2))
         ORDER BY updated_at ASC
         LIMIT ?3`,
      [maxRetries, stuckBefore, limit],
    );
    return rows.map((r) => rowToModel<Job>(r, JOB_META_KEYS));
  }

  async listStuckAssets(limit: number): Promise<Job[]> {
    // `extracting` captures the running-phase drift; `pending` catches the
    // rarer case where the first (running) mirror write was lost too.
    const rows = await queryAll(
      this.db,
      `SELECT j.* FROM jobs j
         JOIN assets a ON a.id = j.asset_id
         WHERE j.status = 'completed'
           AND a.status IN ('pending', 'extracting')
         ORDER BY j.updated_at ASC
         LIMIT ?1`,
      [limit],
    );
    return rows.map((r) => rowToModel<Job>(r, JOB_META_KEYS));
  }
}

// ---------------------------------------------------------------------------
// SqlMetadataStore
// ---------------------------------------------------------------------------

/** The `INSERT OR REPLACE INTO assets` statement, shared with the batch writer. */
export const ASSET_UPSERT_SQL =
  `INSERT OR REPLACE INTO assets
         (id, filename, content_type, size, created_at, expires_at,
          type, status, session_id, project_id, meta,
          active_version_id, description, user_meta)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14)`;

export function assetUpsertArgs(asset: AssetMetadata): SqlValue[] {
  const { userMeta, currentVersion: _cv, versionCount: _vc, ...rest } =
    asset as AssetMetadata & Record<string, unknown>;
  const row = modelToRow(rest as Record<string, unknown>, ASSET_META_KEYS);
  return [
    row.id, row.filename, row.content_type, row.size,
    row.created_at, row.expires_at,
    row.type ?? null, row.status ?? null,
    row.session_id ?? null, row.project_id ?? null, row.meta ?? null,
    row.active_version_id ?? null, row.description ?? null,
    userMeta ? JSON.stringify(userMeta) : null,
  ] as SqlValue[];
}

export class SqlMetadataStore implements MetadataStore {
  constructor(private db: SqlClient) {}

  async save(asset: AssetMetadata, _ttlSeconds: number): Promise<void> {
    await this.db.execute(ASSET_UPSERT_SQL, assetUpsertArgs(asset));
  }

  async find(id: string): Promise<AssetMetadata | null> {
    const row = await queryFirst(this.db, "SELECT * FROM assets WHERE id = ?1", [id]);
    if (!row) return null;
    return parseAssetRow(row);
  }

  async update(id: string, patch: { activeVersionId?: string | null; expiresAt?: number; description?: string; userMeta?: Record<string, unknown> }): Promise<void> {
    const sets: string[] = [];
    const binds: SqlValue[] = [];
    let idx = 1;

    if (patch.activeVersionId !== undefined) {
      sets.push(`active_version_id = ?${idx++}`);
      binds.push(patch.activeVersionId ?? null);
    }
    if (patch.expiresAt !== undefined) {
      sets.push(`expires_at = ?${idx++}`);
      binds.push(patch.expiresAt);
    }
    if (patch.description !== undefined) {
      sets.push(`description = ?${idx++}`);
      binds.push(patch.description);
    }
    if (patch.userMeta !== undefined) {
      sets.push(`user_meta = ?${idx++}`);
      binds.push(patch.userMeta ? JSON.stringify(patch.userMeta) : null);
    }

    if (sets.length === 0) return;

    const sql = `UPDATE assets SET ${sets.join(", ")} WHERE id = ?${idx}`;
    binds.push(id);
    await this.db.execute(sql, binds);
  }

  async delete(id: string): Promise<void> {
    await this.db.execute("DELETE FROM assets WHERE id = ?1", [id]);
  }

  async list(options?: {
    limit?: number;
    cursor?: string;
    sessionId?: string;
    projectId?: string;
    workspaceId?: string;
    accessibleByUser?: string;
  }): Promise<ListResult<AssetMetadata>> {
    const limit = options?.limit ?? 20;
    const scope = buildScopeClause(options, 1);
    if (!scope) return { items: [], cursor: undefined };

    const { clause, binds } = scope;
    let bindIdx = binds.length + 1;

    let cursorClause = "";
    if (options?.cursor) {
      const decoded = decodeCursor(options.cursor);
      if (decoded) {
        cursorClause = ` AND (created_at < ?${bindIdx} OR (created_at = ?${bindIdx} AND id < ?${bindIdx + 1}))`;
        binds.push(decoded.createdAt, decoded.id);
        bindIdx += 2;
      }
    }

    const sql = `SELECT * FROM assets WHERE ${clause}${cursorClause} ORDER BY created_at DESC, id DESC LIMIT ?${bindIdx}`;
    binds.push(limit + 1);

    const rows = await queryAll(this.db, sql, binds);
    const hasMore = rows.length > limit;
    const items = rows.slice(0, limit).map((r) => parseAssetRow(r));
    const cursor = hasMore && items.length > 0
      ? encodeCursor(items[items.length - 1].createdAt, items[items.length - 1].id)
      : undefined;

    return { items, cursor };
  }

  async listExpired(now: number, limit: number): Promise<AssetMetadata[]> {
    const rows = await queryAll(
      this.db,
      "SELECT * FROM assets WHERE expires_at > 0 AND expires_at < ?1 LIMIT ?2",
      [now, limit],
    );
    return rows.map((r) => parseAssetRow(r));
  }
}

function parseAssetRow(row: Record<string, unknown>): AssetMetadata {
  const userMetaStr = row.user_meta as string | null;
  const model = rowToModel<AssetMetadata>(row, ASSET_META_KEYS);
  if (userMetaStr) {
    try { model.userMeta = JSON.parse(userMetaStr); } catch { /* ignore */ }
  }
  return model;
}

// ---------------------------------------------------------------------------
// SqlVersionStore (ADR-005)
// ---------------------------------------------------------------------------

// Assign the per-asset version number inside the INSERT via a subquery.
// Two concurrent uploaders would otherwise race between SELECT MAX and
// INSERT OR REPLACE, and the late writer would silently delete the
// early writer's row while its R2 object lingered as an orphan.
export const VERSION_INSERT_SQL =
  `INSERT INTO asset_versions
         (id, asset_id, version, filename, content_type, size, created_at,
          type, status, meta, user_meta)
         VALUES (?1, ?2,
                 (SELECT COALESCE(MAX(version), 0) + 1 FROM asset_versions WHERE asset_id = ?2),
                 ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)
         RETURNING version`;

export function versionInsertArgs(version: AssetVersion): SqlValue[] {
  const { userMeta, ...rest } = version as AssetVersion & Record<string, unknown>;
  const row = modelToRow(rest as Record<string, unknown>, VERSION_META_KEYS);
  return [
    row.id, row.asset_id, row.filename, row.content_type,
    row.size, row.created_at,
    row.type ?? null, row.status ?? null, row.meta ?? null,
    userMeta ? JSON.stringify(userMeta) : null,
  ] as SqlValue[];
}

/** Read the version number assigned by `VERSION_INSERT_SQL`'s RETURNING clause. */
export function assignedVersion(rows: Record<string, unknown>[]): number {
  const value = rows[0]?.version;
  if (typeof value !== "number") {
    throw new Error("versions.save: no version returned from INSERT RETURNING");
  }
  return value;
}

export class SqlVersionStore implements VersionStore {
  constructor(private db: SqlClient) {}

  async save(version: AssetVersion): Promise<AssetVersion> {
    const { rows } = await this.db.execute(VERSION_INSERT_SQL, versionInsertArgs(version));
    return { ...version, version: assignedVersion(rows) };
  }

  async find(id: string): Promise<AssetVersion | null> {
    const row = await queryFirst(this.db, "SELECT * FROM asset_versions WHERE id = ?1", [id]);
    if (!row) return null;
    return parseVersionRow(row);
  }

  async findByAssetId(assetId: string, options?: { limit?: number; cursor?: string }): Promise<ListResult<AssetVersion>> {
    const limit = options?.limit ?? 20;
    const binds: SqlValue[] = [assetId];
    let bindIdx = 2;
    let cursorCondition = "";

    if (options?.cursor) {
      const decoded = decodeCursor(options.cursor);
      if (decoded) {
        cursorCondition = ` AND (created_at < ?${bindIdx} OR (created_at = ?${bindIdx} AND id < ?${bindIdx + 1}))`;
        binds.push(decoded.createdAt, decoded.id);
        bindIdx += 2;
      }
    }

    const sql = `SELECT * FROM asset_versions WHERE asset_id = ?1${cursorCondition} ORDER BY version DESC LIMIT ?${bindIdx}`;
    binds.push(limit + 1);

    const rows = await queryAll(this.db, sql, binds);
    const hasMore = rows.length > limit;
    const items = rows.slice(0, limit).map((r) => parseVersionRow(r));
    const cursor = hasMore && items.length > 0
      ? encodeCursor(items[items.length - 1].createdAt, items[items.length - 1].id)
      : undefined;

    return { items, cursor };
  }

  async findLatest(assetId: string): Promise<AssetVersion | null> {
    const row = await queryFirst(
      this.db,
      "SELECT * FROM asset_versions WHERE asset_id = ?1 ORDER BY version DESC LIMIT 1",
      [assetId],
    );
    if (!row) return null;
    return parseVersionRow(row);
  }

  async findByAssetAndNumber(assetId: string, version: number): Promise<AssetVersion | null> {
    const row = await queryFirst(
      this.db,
      "SELECT * FROM asset_versions WHERE asset_id = ?1 AND version = ?2",
      [assetId, version],
    );
    if (!row) return null;
    return parseVersionRow(row);
  }

  async update(id: string, patch: Partial<Pick<AssetVersion, 'status' | 'userMeta'>>): Promise<void> {
    const sets: string[] = [];
    const binds: SqlValue[] = [];
    let idx = 1;

    if (patch.status !== undefined) {
      sets.push(`status = ?${idx++}`);
      binds.push(patch.status);
    }
    if (patch.userMeta !== undefined) {
      sets.push(`user_meta = ?${idx++}`);
      binds.push(patch.userMeta ? JSON.stringify(patch.userMeta) : null);
    }

    if (sets.length === 0) return;

    const sql = `UPDATE asset_versions SET ${sets.join(", ")} WHERE id = ?${idx}`;
    binds.push(id);
    await this.db.execute(sql, binds);
  }

  async delete(id: string): Promise<void> {
    await this.db.execute("DELETE FROM asset_versions WHERE id = ?1", [id]);
  }

  async deleteByAssetId(assetId: string): Promise<{ totalSize: number; count: number }> {
    // First sum up sizes for storage accounting
    const row = await queryFirst(
      this.db,
      "SELECT COALESCE(SUM(size), 0) as total_size, COUNT(*) as count FROM asset_versions WHERE asset_id = ?1",
      [assetId],
    );
    const totalSize = row?.total_size as number ?? 0;
    const count = row?.count as number ?? 0;

    await this.db.execute("DELETE FROM asset_versions WHERE asset_id = ?1", [assetId]);
    return { totalSize, count };
  }

  async count(assetId: string): Promise<number> {
    const row = await queryFirst(
      this.db,
      "SELECT COUNT(*) as cnt FROM asset_versions WHERE asset_id = ?1",
      [assetId],
    );
    return row?.cnt as number ?? 0;
  }
}

function parseVersionRow(row: Record<string, unknown>): AssetVersion {
  const userMetaStr = row.user_meta as string | null;
  const model = rowToModel<AssetVersion>(row, VERSION_META_KEYS);
  if (userMetaStr) {
    try { model.userMeta = JSON.parse(userMetaStr); } catch { /* ignore */ }
  }
  return model;
}

// ---------------------------------------------------------------------------
// SqlCleanupPendingStore (SCA-02)
// ---------------------------------------------------------------------------

import type { CleanupPendingStore, PendingCleanup } from "../../core/cleanup/repository";

export class SqlCleanupPendingStore implements CleanupPendingStore {
  constructor(private db: SqlClient) {}

  async add(prefix: string): Promise<void> {
    await this.db.execute(
      "INSERT OR REPLACE INTO cleanup_pending (prefix, created_at) VALUES (?1, ?2)",
      [prefix, Date.now()],
    );
  }

  async list(limit: number): Promise<PendingCleanup[]> {
    const rows = await queryAll(
      this.db,
      "SELECT prefix, created_at FROM cleanup_pending ORDER BY created_at ASC LIMIT ?1",
      [limit],
    );
    return rows.map((row) => ({ prefix: row.prefix as string, createdAt: row.created_at as number }));
  }

  async remove(prefix: string): Promise<void> {
    await this.db.execute("DELETE FROM cleanup_pending WHERE prefix = ?1", [prefix]);
  }
}

// ---------------------------------------------------------------------------
// SqlStorageUsageStore (ADR-004)
// ---------------------------------------------------------------------------

/** The storage-usage upsert, shared with the batch writer. */
export const USAGE_INCREMENT_SQL =
  `INSERT INTO storage_usage (scope, total_size, asset_count, updated_at)
         VALUES (?1, ?2, ?3, ?4)
         ON CONFLICT(scope) DO UPDATE SET
           total_size = total_size + ?2,
           asset_count = asset_count + 1,
           updated_at = ?4`;

export function usageIncrementArgs(scope: string, sizeBytes: number, now = Date.now()): SqlValue[] {
  return [scope, sizeBytes, 1, now];
}

export class SqlStorageUsageStore implements StorageUsageStore {
  constructor(private db: SqlClient) {}

  async get(scope: string): Promise<StorageUsage | null> {
    const row = await queryFirst(this.db, "SELECT * FROM storage_usage WHERE scope = ?1", [scope]);
    if (!row) return null;
    return rowToModel<StorageUsage>(row);
  }

  async increment(scope: string, sizeBytes: number): Promise<void> {
    await this.db.execute(USAGE_INCREMENT_SQL, usageIncrementArgs(scope, sizeBytes));
  }

  async decrement(scope: string, sizeBytes: number): Promise<void> {
    await this.db.execute(
      `UPDATE storage_usage
         SET total_size = MAX(0, total_size - ?2),
             asset_count = MAX(0, asset_count - 1),
             updated_at = ?3
         WHERE scope = ?1`,
      [scope, sizeBytes, Date.now()],
    );
  }

  async recalculate(scope: string, totalSize: number, assetCount: number): Promise<void> {
    await this.db.execute(
      `INSERT OR REPLACE INTO storage_usage (scope, total_size, asset_count, updated_at)
         VALUES (?1, ?2, ?3, ?4)`,
      [scope, totalSize, assetCount, Date.now()],
    );
  }
}
