import type { AssetMetadata, AssetVersion } from "../asset/model";
import type { MetadataStore, VersionStore } from "../asset/repository";
import type { ListResult } from "../asset/repository";
import type { Job } from "../job/model";
import type { JobStore } from "../job/repository";
import type { Project } from "../project/model";
import type { ProjectStore } from "../project/repository";
import type { Workspace } from "../workspace/model";
import type { WorkspaceStore } from "../workspace/repository";
import type { Member } from "../member/model";
import type { MemberStore } from "../member/repository";
import { rowToModel, modelToRow, encodeCursor, decodeCursor } from "./d1-helpers";

// Meta keys: fields stored in the JSON `meta` column instead of dedicated columns.
const ASSET_META_KEYS = ["contentEncoding", "originalSize", "archiveFormat", "fileCount", "extractedSize", "jobId"];
const VERSION_META_KEYS = ["contentEncoding", "originalSize", "archiveFormat", "fileCount", "extractedSize", "jobId"];
const JOB_META_KEYS = ["completedAt", "startedAt", "error", "totalFiles", "fileCount", "extractedSize"];

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
): { clause: string; binds: unknown[] } | null {
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
// D1WorkspaceStore
// ---------------------------------------------------------------------------

export class D1WorkspaceStore implements WorkspaceStore {
  constructor(private db: D1Database) {}

  async save(workspace: Workspace): Promise<void> {
    const row = modelToRow(workspace as unknown as Record<string, unknown>);
    await this.db
      .prepare(
        `INSERT OR REPLACE INTO workspaces (id, name, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4)`,
      )
      .bind(row.id, row.name, row.created_at, row.updated_at)
      .run();
  }

  async find(id: string): Promise<Workspace | null> {
    const row = await this.db
      .prepare("SELECT * FROM workspaces WHERE id = ?1")
      .bind(id)
      .first();
    return row ? rowToModel<Workspace>(row as Record<string, unknown>) : null;
  }

  async delete(id: string): Promise<void> {
    await this.db.prepare("DELETE FROM workspaces WHERE id = ?1").bind(id).run();
  }
}

// ---------------------------------------------------------------------------
// D1MemberStore
// ---------------------------------------------------------------------------

export class D1MemberStore implements MemberStore {
  constructor(private db: D1Database) {}

  async save(member: Member): Promise<void> {
    const row = modelToRow(member as unknown as Record<string, unknown>);
    await this.db
      .prepare(
        `INSERT OR REPLACE INTO members (workspace_id, user_id, role, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5)`,
      )
      .bind(row.workspace_id, row.user_id, row.role, row.created_at, row.updated_at)
      .run();
  }

  async find(workspaceId: string, userId: string): Promise<Member | null> {
    const row = await this.db
      .prepare("SELECT * FROM members WHERE workspace_id = ?1 AND user_id = ?2")
      .bind(workspaceId, userId)
      .first();
    return row ? rowToModel<Member>(row as Record<string, unknown>) : null;
  }

  async list(workspaceId: string): Promise<Member[]> {
    const { results } = await this.db
      .prepare("SELECT * FROM members WHERE workspace_id = ?1 ORDER BY created_at LIMIT ?2")
      .bind(workspaceId, MEMBER_LIST_LIMIT)
      .all();
    return results.map((r) => rowToModel<Member>(r as Record<string, unknown>));
  }

  async listByUser(userId: string): Promise<Member[]> {
    const { results } = await this.db
      .prepare("SELECT * FROM members WHERE user_id = ?1 ORDER BY created_at LIMIT ?2")
      .bind(userId, MEMBER_LIST_LIMIT)
      .all();
    return results.map((r) => rowToModel<Member>(r as Record<string, unknown>));
  }

  async delete(workspaceId: string, userId: string): Promise<void> {
    await this.db
      .prepare("DELETE FROM members WHERE workspace_id = ?1 AND user_id = ?2")
      .bind(workspaceId, userId)
      .run();
  }
}

// ---------------------------------------------------------------------------
// D1ProjectStore
// ---------------------------------------------------------------------------

export class D1ProjectStore implements ProjectStore {
  constructor(private db: D1Database) {}

  async save(project: Project): Promise<void> {
    const row = modelToRow(project as unknown as Record<string, unknown>);
    await this.db
      .prepare(
        `INSERT OR REPLACE INTO projects (id, name, created_at, updated_at, owner_id, workspace_id)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6)`,
      )
      .bind(row.id, row.name, row.created_at, row.updated_at, row.owner_id, row.workspace_id ?? null)
      .run();
  }

  async find(id: string): Promise<Project | null> {
    const row = await this.db
      .prepare("SELECT * FROM projects WHERE id = ?1")
      .bind(id)
      .first();
    return row ? rowToModel<Project>(row as Record<string, unknown>) : null;
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
    const { results } = await this.db.prepare(query).bind(bindValue, PROJECT_LIST_LIMIT).all();
    return results.map((r) => rowToModel<Project>(r as Record<string, unknown>));
  }

  async delete(id: string, _ownerId: string): Promise<void> {
    await this.db.prepare("DELETE FROM projects WHERE id = ?1").bind(id).run();
  }
}

// ---------------------------------------------------------------------------
// D1JobStore
// ---------------------------------------------------------------------------

export class D1JobStore implements JobStore {
  constructor(private db: D1Database) {}

  async save(job: Job): Promise<void> {
    const row = modelToRow(job as unknown as Record<string, unknown>, JOB_META_KEYS);
    await this.db
      .prepare(
        `INSERT OR REPLACE INTO jobs
         (id, asset_id, type, status, created_at, updated_at, retry_count, session_id, project_id, version_id, meta)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)`,
      )
      .bind(
        row.id, row.asset_id, row.type, row.status,
        row.created_at, row.updated_at, row.retry_count ?? 0,
        row.session_id ?? null, row.project_id ?? null, row.version_id ?? null, row.meta ?? null,
      )
      .run();
  }

  async find(id: string): Promise<Job | null> {
    const row = await this.db
      .prepare("SELECT * FROM jobs WHERE id = ?1")
      .bind(id)
      .first();
    return row ? rowToModel<Job>(row as Record<string, unknown>, JOB_META_KEYS) : null;
  }

  async delete(id: string): Promise<void> {
    await this.db.prepare("DELETE FROM jobs WHERE id = ?1").bind(id).run();
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

    const { results } = await this.db.prepare(sql).bind(...binds).all();
    const hasMore = results.length > limit;
    const items = results.slice(0, limit).map((r) => rowToModel<Job>(r as Record<string, unknown>, JOB_META_KEYS));
    const cursor = hasMore && items.length > 0
      ? encodeCursor(items[items.length - 1].createdAt, items[items.length - 1].id)
      : undefined;

    return { items, cursor };
  }

  async listRetriable(stuckThresholdMs: number, maxRetries: number, limit: number = 50): Promise<Job[]> {
    const stuckBefore = Date.now() - stuckThresholdMs;
    const { results } = await this.db
      .prepare(
        `SELECT * FROM jobs
         WHERE type = 'archive-extraction'
           AND retry_count < ?1
           AND (status IN ('pending', 'failed')
                OR (status = 'running' AND updated_at < ?2))
         ORDER BY updated_at ASC
         LIMIT ?3`,
      )
      .bind(maxRetries, stuckBefore, limit)
      .all();
    return results.map((r) => rowToModel<Job>(r as Record<string, unknown>, JOB_META_KEYS));
  }
}

// ---------------------------------------------------------------------------
// D1MetadataStore
// ---------------------------------------------------------------------------

export class D1MetadataStore implements MetadataStore {
  constructor(private db: D1Database) {}

  async save(asset: AssetMetadata, _ttlSeconds: number): Promise<void> {
    const { userMeta, currentVersion, versionCount, ...rest } = asset as AssetMetadata & Record<string, unknown>;
    const row = modelToRow(rest as Record<string, unknown>, ASSET_META_KEYS);
    await this.db
      .prepare(
        `INSERT OR REPLACE INTO assets
         (id, filename, content_type, size, created_at, expires_at,
          type, status, session_id, project_id, meta,
          active_version_id, description, user_meta)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14)`,
      )
      .bind(
        row.id, row.filename, row.content_type, row.size,
        row.created_at, row.expires_at,
        row.type ?? null, row.status ?? null,
        row.session_id ?? null, row.project_id ?? null, row.meta ?? null,
        row.active_version_id ?? null, row.description ?? null,
        userMeta ? JSON.stringify(userMeta) : null,
      )
      .run();
  }

  async find(id: string): Promise<AssetMetadata | null> {
    const row = await this.db
      .prepare("SELECT * FROM assets WHERE id = ?1")
      .bind(id)
      .first();
    if (!row) return null;
    return parseAssetRow(row as Record<string, unknown>);
  }

  async update(id: string, patch: { activeVersionId?: string | null; expiresAt?: number; description?: string; userMeta?: Record<string, unknown> }): Promise<void> {
    const sets: string[] = [];
    const binds: unknown[] = [];
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
    await this.db.prepare(sql).bind(...binds).run();
  }

  async delete(id: string): Promise<void> {
    await this.db.prepare("DELETE FROM assets WHERE id = ?1").bind(id).run();
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

    const { results } = await this.db.prepare(sql).bind(...binds).all();
    const hasMore = results.length > limit;
    const items = results.slice(0, limit).map((r) => parseAssetRow(r as Record<string, unknown>));
    const cursor = hasMore && items.length > 0
      ? encodeCursor(items[items.length - 1].createdAt, items[items.length - 1].id)
      : undefined;

    return { items, cursor };
  }

  async listExpired(now: number, limit: number): Promise<AssetMetadata[]> {
    const { results } = await this.db
      .prepare(
        "SELECT * FROM assets WHERE expires_at > 0 AND expires_at < ?1 LIMIT ?2",
      )
      .bind(now, limit)
      .all();
    return results.map((r) => parseAssetRow(r as Record<string, unknown>));
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
// D1VersionStore (ADR-005)
// ---------------------------------------------------------------------------

export class D1VersionStore implements VersionStore {
  constructor(private db: D1Database) {}

  async save(version: AssetVersion): Promise<void> {
    const { userMeta, ...rest } = version as AssetVersion & Record<string, unknown>;
    const row = modelToRow(rest as Record<string, unknown>, VERSION_META_KEYS);
    await this.db
      .prepare(
        `INSERT OR REPLACE INTO asset_versions
         (id, asset_id, version, filename, content_type, size, created_at,
          type, status, meta, user_meta)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)`,
      )
      .bind(
        row.id, row.asset_id, row.version, row.filename, row.content_type,
        row.size, row.created_at,
        row.type ?? null, row.status ?? null, row.meta ?? null,
        userMeta ? JSON.stringify(userMeta) : null,
      )
      .run();
  }

  async find(id: string): Promise<AssetVersion | null> {
    const row = await this.db
      .prepare("SELECT * FROM asset_versions WHERE id = ?1")
      .bind(id)
      .first();
    if (!row) return null;
    return parseVersionRow(row as Record<string, unknown>);
  }

  async findByAssetId(assetId: string, options?: { limit?: number; cursor?: string }): Promise<ListResult<AssetVersion>> {
    const limit = options?.limit ?? 20;
    const binds: unknown[] = [assetId];
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

    const { results } = await this.db.prepare(sql).bind(...binds).all();
    const hasMore = results.length > limit;
    const items = results.slice(0, limit).map((r) => parseVersionRow(r as Record<string, unknown>));
    const cursor = hasMore && items.length > 0
      ? encodeCursor(items[items.length - 1].createdAt, items[items.length - 1].id)
      : undefined;

    return { items, cursor };
  }

  async findLatest(assetId: string): Promise<AssetVersion | null> {
    const row = await this.db
      .prepare("SELECT * FROM asset_versions WHERE asset_id = ?1 ORDER BY version DESC LIMIT 1")
      .bind(assetId)
      .first();
    if (!row) return null;
    return parseVersionRow(row as Record<string, unknown>);
  }

  async nextVersion(assetId: string): Promise<number> {
    const row = await this.db
      .prepare("SELECT MAX(version) as max_ver FROM asset_versions WHERE asset_id = ?1")
      .bind(assetId)
      .first();
    const maxVer = (row as Record<string, unknown> | null)?.max_ver;
    return typeof maxVer === "number" ? maxVer + 1 : 1;
  }

  async update(id: string, patch: Partial<Pick<AssetVersion, 'status' | 'userMeta'>>): Promise<void> {
    const sets: string[] = [];
    const binds: unknown[] = [];
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
    await this.db.prepare(sql).bind(...binds).run();
  }

  async delete(id: string): Promise<void> {
    await this.db.prepare("DELETE FROM asset_versions WHERE id = ?1").bind(id).run();
  }

  async deleteByAssetId(assetId: string): Promise<{ totalSize: number; count: number }> {
    // First sum up sizes for storage accounting
    const row = await this.db
      .prepare("SELECT COALESCE(SUM(size), 0) as total_size, COUNT(*) as count FROM asset_versions WHERE asset_id = ?1")
      .bind(assetId)
      .first();
    const totalSize = (row as Record<string, unknown> | null)?.total_size as number ?? 0;
    const count = (row as Record<string, unknown> | null)?.count as number ?? 0;

    await this.db.prepare("DELETE FROM asset_versions WHERE asset_id = ?1").bind(assetId).run();
    return { totalSize, count };
  }

  async count(assetId: string): Promise<number> {
    const row = await this.db
      .prepare("SELECT COUNT(*) as cnt FROM asset_versions WHERE asset_id = ?1")
      .bind(assetId)
      .first();
    return (row as Record<string, unknown> | null)?.cnt as number ?? 0;
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
// D1StorageUsageStore (ADR-004)
// ---------------------------------------------------------------------------

export interface StorageUsage {
  totalSize: number;
  assetCount: number;
  updatedAt: number;
}

export interface StorageUsageStore {
  get(scope: string): Promise<StorageUsage | null>;
  increment(scope: string, sizeBytes: number): Promise<void>;
  decrement(scope: string, sizeBytes: number): Promise<void>;
  recalculate(scope: string, totalSize: number, assetCount: number): Promise<void>;
}

export class D1StorageUsageStore implements StorageUsageStore {
  constructor(private db: D1Database) {}

  async get(scope: string): Promise<StorageUsage | null> {
    const row = await this.db
      .prepare("SELECT * FROM storage_usage WHERE scope = ?1")
      .bind(scope)
      .first();
    if (!row) return null;
    return rowToModel<StorageUsage>(row as Record<string, unknown>);
  }

  async increment(scope: string, sizeBytes: number): Promise<void> {
    const now = Date.now();
    await this.db
      .prepare(
        `INSERT INTO storage_usage (scope, total_size, asset_count, updated_at)
         VALUES (?1, ?2, ?3, ?4)
         ON CONFLICT(scope) DO UPDATE SET
           total_size = total_size + ?2,
           asset_count = asset_count + 1,
           updated_at = ?4`,
      )
      .bind(scope, sizeBytes, 1, now)
      .run();
  }

  async decrement(scope: string, sizeBytes: number): Promise<void> {
    const now = Date.now();
    await this.db
      .prepare(
        `UPDATE storage_usage
         SET total_size = MAX(0, total_size - ?2),
             asset_count = MAX(0, asset_count - 1),
             updated_at = ?3
         WHERE scope = ?1`,
      )
      .bind(scope, sizeBytes, now)
      .run();
  }

  async recalculate(scope: string, totalSize: number, assetCount: number): Promise<void> {
    const now = Date.now();
    await this.db
      .prepare(
        `INSERT OR REPLACE INTO storage_usage (scope, total_size, asset_count, updated_at)
         VALUES (?1, ?2, ?3, ?4)`,
      )
      .bind(scope, totalSize, assetCount, now)
      .run();
  }
}

// --- Tests ---

if (import.meta.vitest) {
  const { test, expect, beforeEach } = import.meta.vitest;

  // Minimal D1Database mock for unit tests
  // Uses `as unknown as` casts for D1 types since we only need a functional subset
  function mockD1(): D1Database & { _tables: Map<string, Map<string, Record<string, unknown>>> } {
    const tables = new Map<string, Map<string, Record<string, unknown>>>();

    function getTable(name: string): Map<string, Record<string, unknown>> {
      if (!tables.has(name)) tables.set(name, new Map());
      return tables.get(name)!;
    }

    function parseSql(sql: string, binds: unknown[]): D1Result {
      const trimmed = sql.trim().replace(/\s+/g, " ");

      // INSERT OR REPLACE
      if (trimmed.startsWith("INSERT OR REPLACE INTO") || trimmed.startsWith("INSERT INTO")) {
        const tableMatch = trimmed.match(/INTO\s+(\w+)/);
        if (!tableMatch) throw new Error(`Cannot parse table name from: ${trimmed}`);
        const tableName = tableMatch[1];
        const table = getTable(tableName);

        const colMatch = trimmed.match(/\(([^)]+)\)\s+VALUES/);
        if (!colMatch) throw new Error(`Cannot parse columns from: ${trimmed}`);
        const cols = colMatch[1].split(",").map((c) => c.trim());

        // Handle ON CONFLICT for storage_usage UPSERT
        const isUpsert = trimmed.includes("ON CONFLICT");

        const row: Record<string, unknown> = {};
        for (let i = 0; i < cols.length; i++) {
          row[cols[i]] = binds[i] ?? null;
        }

        const pk = getPrimaryKey(tableName);
        const pkValue = typeof pk === "string" ? String(row[pk]) : pk.map((k) => String(row[k])).join(":");

        if (isUpsert && table.has(pkValue)) {
          // ON CONFLICT DO UPDATE: apply increments
          const existing = table.get(pkValue)!;
          const sizeBytes = binds[1] as number;
          const now = binds[3] as number;
          existing.total_size = (existing.total_size as number) + sizeBytes;
          existing.asset_count = (existing.asset_count as number) + 1;
          existing.updated_at = now;
        } else {
          table.set(pkValue, { ...row });
        }

        return { results: [], success: true, meta: {} } as unknown as D1Result;
      }

      // SELECT
      if (trimmed.startsWith("SELECT")) {
        const tableMatch = trimmed.match(/FROM\s+(\w+)/);
        if (!tableMatch) throw new Error(`Cannot parse table name from: ${trimmed}`);
        const tableName = tableMatch[1];
        const table = getTable(tableName);

        let rows = [...table.values()];

        // WHERE clause filtering
        const whereMatch = trimmed.match(/WHERE\s+(.+?)(?:\s+ORDER|\s+LIMIT|$)/);
        if (whereMatch) {
          rows = filterRows(rows, whereMatch[1], binds);
        }

        // ORDER BY created_at DESC
        if (trimmed.includes("ORDER BY created_at DESC")) {
          rows.sort((a, b) => (b.created_at as number) - (a.created_at as number));
        } else if (trimmed.includes("ORDER BY created_at")) {
          rows.sort((a, b) => (a.created_at as number) - (b.created_at as number));
        }

        // LIMIT
        const limitMatch = trimmed.match(/LIMIT\s+\?(\d+)/);
        if (limitMatch) {
          const limitIdx = parseInt(limitMatch[1], 10) - 1;
          const limitVal = binds[limitIdx] as number;
          rows = rows.slice(0, limitVal);
        }

        return { results: rows.map((r) => ({ ...r })), success: true, meta: {} } as unknown as D1Result;
      }

      // DELETE
      if (trimmed.startsWith("DELETE FROM")) {
        const tableMatch = trimmed.match(/FROM\s+(\w+)/);
        if (!tableMatch) throw new Error(`Cannot parse table name from: ${trimmed}`);
        const tableName = tableMatch[1];
        const table = getTable(tableName);
        const pk = getPrimaryKey(tableName);

        const whereMatch = trimmed.match(/WHERE\s+(.+)$/);
        if (whereMatch) {
          const toDelete: string[] = [];
          for (const [key, row] of table) {
            if (matchesWhere(row, whereMatch[1], binds)) {
              toDelete.push(key);
            }
          }
          for (const key of toDelete) table.delete(key);
        }

        return { results: [], success: true, meta: {} } as unknown as D1Result;
      }

      // UPDATE
      if (trimmed.startsWith("UPDATE")) {
        const tableMatch = trimmed.match(/UPDATE\s+(\w+)/);
        if (!tableMatch) throw new Error(`Cannot parse table name from: ${trimmed}`);
        const tableName = tableMatch[1];
        const table = getTable(tableName);

        const whereMatch = trimmed.match(/WHERE\s+(.+)$/);
        if (whereMatch) {
          for (const row of table.values()) {
            if (matchesWhere(row, whereMatch[1], binds)) {
              // Parse SET clause for storage_usage decrement
              const sizeBytes = binds[1] as number;
              const now = binds[2] as number;
              row.total_size = Math.max(0, (row.total_size as number) - sizeBytes);
              row.asset_count = Math.max(0, (row.asset_count as number) - 1);
              row.updated_at = now;
            }
          }
        }

        return { results: [], success: true, meta: {} } as unknown as D1Result;
      }

      throw new Error(`Unsupported SQL: ${trimmed}`);
    }

    function getPrimaryKey(tableName: string): string | string[] {
      if (tableName === "members") return ["workspace_id", "user_id"];
      return "id";
    }

    function filterRows(rows: Record<string, unknown>[], whereClause: string, binds: unknown[]): Record<string, unknown>[] {
      return rows.filter((row) => matchesWhere(row, whereClause, binds));
    }

    function matchesWhere(row: Record<string, unknown>, whereClause: string, binds: unknown[]): boolean {
      // Simple equality: column = ?N
      const eqParts = whereClause.split(" AND ").map((p) => p.trim());
      for (const part of eqParts) {
        const eqMatch = part.match(/^(\w+)\s*=\s*\?(\d+)$/);
        if (eqMatch) {
          const col = eqMatch[1];
          const idx = parseInt(eqMatch[2], 10) - 1;
          if (row[col] !== binds[idx]) return false;
          continue;
        }

        // scope = ?1 (simple case already handled above)
        // For IN clause, status IN, and complex expressions — skip (accept all)
      }
      return true;
    }

    const db = {
      prepare(sql: string) {
        let boundBinds: unknown[] = [];
        const stmt = {
          bind(...args: unknown[]) {
            boundBinds = args;
            return stmt;
          },
          async first() {
            const result = parseSql(sql, boundBinds);
            return result.results[0] ?? null;
          },
          async all() {
            return parseSql(sql, boundBinds);
          },
          async run() {
            return parseSql(sql, boundBinds);
          },
          async raw() {
            const result = parseSql(sql, boundBinds);
            return (result.results as Record<string, unknown>[]).map((r) => Object.values(r));
          },
        };
        return stmt;
      },
      async dump() { return new ArrayBuffer(0); },
      async batch() { return []; },
      async exec() { return { count: 0, duration: 0 }; },
    } as unknown as D1Database;

    return Object.assign(db, { _tables: tables });
  }

  // --- D1WorkspaceStore tests ---

  test("workspace save and find", async () => {
    const db = mockD1();
    const store = new D1WorkspaceStore(db);
    const ws = { id: "ws1", name: "Test", createdAt: 100, updatedAt: 100 };
    await store.save(ws);
    const found = await store.find("ws1");
    expect(found).toEqual(ws);
  });

  test("workspace find returns null for missing", async () => {
    const db = mockD1();
    const store = new D1WorkspaceStore(db);
    expect(await store.find("nonexistent")).toBeNull();
  });

  test("workspace delete", async () => {
    const db = mockD1();
    const store = new D1WorkspaceStore(db);
    await store.save({ id: "ws1", name: "Test", createdAt: 100, updatedAt: 100 });
    await store.delete("ws1");
    expect(await store.find("ws1")).toBeNull();
  });

  // --- D1MemberStore tests ---

  test("member save, find, list, listByUser", async () => {
    const db = mockD1();
    const store = new D1MemberStore(db);
    const m1 = { workspaceId: "ws1", userId: "u1", role: "owner" as const, createdAt: 100, updatedAt: 100 };
    const m2 = { workspaceId: "ws1", userId: "u2", role: "editor" as const, createdAt: 200, updatedAt: 200 };
    const m3 = { workspaceId: "ws2", userId: "u1", role: "viewer" as const, createdAt: 300, updatedAt: 300 };
    await store.save(m1);
    await store.save(m2);
    await store.save(m3);

    expect(await store.find("ws1", "u1")).toEqual(m1);
    expect(await store.find("ws1", "u3")).toBeNull();

    const wsList = await store.list("ws1");
    expect(wsList).toHaveLength(2);
    expect(wsList.map((m) => m.userId).sort()).toEqual(["u1", "u2"]);

    const userList = await store.listByUser("u1");
    expect(userList).toHaveLength(2);
    expect(userList.map((m) => m.workspaceId).sort()).toEqual(["ws1", "ws2"]);
  });

  test("member delete", async () => {
    const db = mockD1();
    const store = new D1MemberStore(db);
    await store.save({ workspaceId: "ws1", userId: "u1", role: "owner" as const, createdAt: 100, updatedAt: 100 });
    await store.delete("ws1", "u1");
    expect(await store.find("ws1", "u1")).toBeNull();
  });

  // --- D1ProjectStore tests ---

  test("project save, find, list by ownerId", async () => {
    const db = mockD1();
    const store = new D1ProjectStore(db);
    const p1 = { id: "p1", name: "Proj1", createdAt: 100, updatedAt: 100, ownerId: "u1", workspaceId: "ws1" };
    const p2 = { id: "p2", name: "Proj2", createdAt: 200, updatedAt: 200, ownerId: "u1" };
    await store.save(p1);
    await store.save(p2);

    expect(await store.find("p1")).toEqual(p1);

    const byOwner = await store.list({ ownerId: "u1" });
    expect(byOwner).toHaveLength(2);
  });

  test("project list by workspaceId", async () => {
    const db = mockD1();
    const store = new D1ProjectStore(db);
    await store.save({ id: "p1", name: "P1", createdAt: 100, updatedAt: 100, ownerId: "u1", workspaceId: "ws1" });
    await store.save({ id: "p2", name: "P2", createdAt: 200, updatedAt: 200, ownerId: "u1", workspaceId: "ws2" });

    const result = await store.list({ workspaceId: "ws1" });
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe("p1");
  });

  test("project list returns empty with no params", async () => {
    const db = mockD1();
    const store = new D1ProjectStore(db);
    expect(await store.list({})).toEqual([]);
  });

  test("project delete", async () => {
    const db = mockD1();
    const store = new D1ProjectStore(db);
    await store.save({ id: "p1", name: "P1", createdAt: 100, updatedAt: 100, ownerId: "u1" });
    await store.delete("p1", "u1");
    expect(await store.find("p1")).toBeNull();
  });

  // --- D1MetadataStore tests ---

  test("asset save and find", async () => {
    const db = mockD1();
    const store = new D1MetadataStore(db);
    const asset: AssetMetadata = {
      id: "a1", filename: "test.bin", contentType: "application/octet-stream",
      size: 100, createdAt: 1000, expiresAt: 2000,
    };
    await store.save(asset, 3600);
    const found = await store.find("a1");
    expect(found?.id).toBe("a1");
    expect(found?.filename).toBe("test.bin");
  });

  test("asset delete", async () => {
    const db = mockD1();
    const store = new D1MetadataStore(db);
    await store.save({
      id: "a1", filename: "test.bin", contentType: "application/octet-stream",
      size: 100, createdAt: 1000, expiresAt: 2000,
    }, 3600);
    await store.delete("a1");
    expect(await store.find("a1")).toBeNull();
  });

  test("asset list filters by projectId", async () => {
    const db = mockD1();
    const store = new D1MetadataStore(db);
    await store.save({ id: "a1", filename: "f1", contentType: "text/plain", size: 10, createdAt: 100, expiresAt: 9999, projectId: "p1" }, 3600);
    await store.save({ id: "a2", filename: "f2", contentType: "text/plain", size: 20, createdAt: 200, expiresAt: 9999, projectId: "p2" }, 3600);

    const result = await store.list({ projectId: "p1" });
    expect(result.items).toHaveLength(1);
    expect(result.items[0].id).toBe("a1");
  });

  // --- D1StorageUsageStore tests ---

  test("storage usage increment and get", async () => {
    const db = mockD1();
    const store = new D1StorageUsageStore(db);
    await store.increment("project:p1", 1000);
    const usage = await store.get("project:p1");
    expect(usage).not.toBeNull();
    expect(usage!.totalSize).toBe(1000);
    expect(usage!.assetCount).toBe(1);
  });

  test("storage usage multiple increments accumulate", async () => {
    const db = mockD1();
    const store = new D1StorageUsageStore(db);
    await store.increment("project:p1", 1000);
    await store.increment("project:p1", 500);
    const usage = await store.get("project:p1");
    expect(usage!.totalSize).toBe(1500);
    expect(usage!.assetCount).toBe(2);
  });

  test("storage usage decrement", async () => {
    const db = mockD1();
    const store = new D1StorageUsageStore(db);
    await store.increment("project:p1", 1000);
    await store.increment("project:p1", 500);
    await store.decrement("project:p1", 400);
    const usage = await store.get("project:p1");
    expect(usage!.totalSize).toBe(1100);
    expect(usage!.assetCount).toBe(1);
  });

  test("storage usage decrement does not go below zero", async () => {
    const db = mockD1();
    const store = new D1StorageUsageStore(db);
    await store.increment("project:p1", 100);
    await store.decrement("project:p1", 999);
    const usage = await store.get("project:p1");
    expect(usage!.totalSize).toBe(0);
    expect(usage!.assetCount).toBe(0);
  });

  test("storage usage recalculate overwrites", async () => {
    const db = mockD1();
    const store = new D1StorageUsageStore(db);
    await store.increment("project:p1", 1000);
    await store.recalculate("project:p1", 42, 3);
    const usage = await store.get("project:p1");
    expect(usage!.totalSize).toBe(42);
    expect(usage!.assetCount).toBe(3);
  });

  test("storage usage get returns null for missing scope", async () => {
    const db = mockD1();
    const store = new D1StorageUsageStore(db);
    expect(await store.get("nonexistent")).toBeNull();
  });
}
