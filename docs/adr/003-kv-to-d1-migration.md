# ADR-003: Metadata Storage Migration from KV to D1

- **Status:** Accepted
- **Date:** 2026-03-17
- **Deciders:** @rot1024

## Context

Re:Earth Serve uses Cloudflare KV for all metadata storage. Several KV usage patterns are fragile or limiting:

1. **Index list race conditions (HIGH risk):** `addToList`/`removeFromList` performs read-modify-write on JSON arrays (`asset_list:project:{id}`, `job_list:all`, etc.). Two concurrent writes from different edge locations can silently drop entries.
2. **No atomic counters:** Storage usage tracking (ADR-004) requires a reconciliation cron job to correct drift from non-atomic increment/decrement.
3. **Dual inverse indices:** Member lookups maintain two manually-synchronized lists (`member_list:{wsId}` + `user_workspaces:{userId}`). A failure between writes leaves them inconsistent.
4. **No ad-hoc queries:** Filtering, sorting, or aggregating across entities requires reading all entries individually.

The repository layer already uses interfaces (`MetadataStore`, `JobStore`, `ProjectStore`, `WorkspaceStore`, `MemberStore`), so D1 implementations can be swapped in without changing business logic.

## Decision

Migrate metadata storage from KV to D1 (Cloudflare's SQLite-based database) in a phased approach. KV is retained for ephemeral data that benefits from TTL auto-expiration.

### What Moves to D1

| Entity | Current KV keys | Why D1 |
|--------|----------------|--------|
| Assets | `asset:{id}`, `asset_list:*` | Eliminates index list race conditions; enables filtered queries |
| Jobs | `job:{id}`, `job_list:*` | Strong consistency for status updates; better cleanup queries |
| Projects | `project:{id}`, `project_list:*`, `project_list_ws:*` | Eliminates index list races |
| Workspaces | `workspace:{id}` | Consistency with other D1 entities |
| Members | `member:{ws}:{user}`, `member_list:*`, `user_workspaces:*` | Eliminates fragile dual inverse indices |
| Storage Usage | `storage_usage:*` (ADR-004) | Atomic `UPDATE SET total_size = total_size + ?`; no reconciliation needed |

### What Stays on KV

| Entity | KV keys | Reason |
|--------|---------|--------|
| Sessions | `session:{id}` | Ephemeral, TTL auto-expiration, no listing/querying needed |
| Upload Sessions | `upload:{id}` | Same — ephemeral, TTL-expiring, simple get/put/delete |
| JWKS cache | (in auth middleware) | Cached with TTL |
| Cleanup cursor | `cleanup:cursor` | Removed entirely — D1 query-based cleanup is stateless |

### D1 Schema

```sql
-- Assets
CREATE TABLE assets (
  id               TEXT PRIMARY KEY,
  filename         TEXT NOT NULL,
  content_type     TEXT NOT NULL,
  size             INTEGER NOT NULL,
  created_at       INTEGER NOT NULL,
  expires_at       INTEGER NOT NULL,
  content_encoding TEXT,
  original_size    INTEGER,
  type             TEXT,
  status           TEXT,
  archive_format   TEXT,
  file_count       INTEGER,
  extracted_size   INTEGER,
  job_id           TEXT,
  session_id       TEXT,
  project_id       TEXT
);
CREATE INDEX idx_assets_session ON assets(session_id) WHERE session_id IS NOT NULL;
CREATE INDEX idx_assets_project ON assets(project_id) WHERE project_id IS NOT NULL;
CREATE INDEX idx_assets_expires ON assets(expires_at);
CREATE INDEX idx_assets_created ON assets(created_at);

-- Jobs
CREATE TABLE jobs (
  id             TEXT PRIMARY KEY,
  asset_id       TEXT NOT NULL,
  type           TEXT NOT NULL,
  status         TEXT NOT NULL,
  created_at     INTEGER NOT NULL,
  updated_at     INTEGER NOT NULL,
  completed_at   INTEGER,
  started_at     INTEGER,
  error          TEXT,
  total_files    INTEGER,
  file_count     INTEGER,
  extracted_size INTEGER,
  retry_count    INTEGER DEFAULT 0,
  session_id     TEXT,
  project_id     TEXT
);
CREATE INDEX idx_jobs_session ON jobs(session_id) WHERE session_id IS NOT NULL;
CREATE INDEX idx_jobs_project ON jobs(project_id) WHERE project_id IS NOT NULL;
CREATE INDEX idx_jobs_status ON jobs(status);
CREATE INDEX idx_jobs_asset ON jobs(asset_id);

-- Projects
CREATE TABLE projects (
  id           TEXT PRIMARY KEY,
  name         TEXT NOT NULL,
  created_at   INTEGER NOT NULL,
  updated_at   INTEGER NOT NULL,
  owner_id     TEXT NOT NULL,
  workspace_id TEXT
);
CREATE INDEX idx_projects_owner ON projects(owner_id);
CREATE INDEX idx_projects_workspace ON projects(workspace_id) WHERE workspace_id IS NOT NULL;

-- Workspaces
CREATE TABLE workspaces (
  id         TEXT PRIMARY KEY,
  name       TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

-- Members
CREATE TABLE members (
  workspace_id TEXT NOT NULL,
  user_id      TEXT NOT NULL,
  role         TEXT NOT NULL,
  created_at   INTEGER NOT NULL,
  updated_at   INTEGER NOT NULL,
  PRIMARY KEY (workspace_id, user_id)
);
CREATE INDEX idx_members_user ON members(user_id);

-- Storage Usage (ADR-004)
CREATE TABLE storage_usage (
  scope       TEXT PRIMARY KEY,
  total_size  INTEGER NOT NULL DEFAULT 0,
  asset_count INTEGER NOT NULL DEFAULT 0,
  updated_at  INTEGER NOT NULL
);
```

### Column Naming Convention

D1 uses `snake_case` columns; TypeScript models use `camelCase`. A shared helper handles the mapping:

```typescript
function rowToModel<T>(row: Record<string, unknown>): T;  // snake_case → camelCase
function modelToRow(model: Record<string, unknown>): Record<string, unknown>;  // camelCase → snake_case
```

### TTL Expiration Without KV

KV auto-deletes keys after TTL. D1 has no such mechanism. For assets with `expires_at`:

- The `expires_at` column stores the expiration timestamp (already in the model).
- The cleanup cron queries `SELECT id FROM assets WHERE expires_at < ?` instead of scanning R2.
- Permanent assets (project-scoped) use `expires_at = 0` or a far-future value. The cleanup query naturally skips them.
- Sessions and upload sessions stay on KV where TTL auto-expiration continues to work.

### Cleanup Cron Changes

**Before (KV-based):**
1. Scan R2 by prefix to discover asset IDs
2. For each ID, check KV — if metadata expired (TTL), delete R2 objects
3. Persist cursor in KV for next cron invocation

**After (D1-based):**
1. `SELECT id, filename FROM assets WHERE expires_at > 0 AND expires_at < ? LIMIT 100` — find expired assets directly
2. Delete R2 objects for each
3. `DELETE FROM assets WHERE id IN (...)`
4. `DELETE FROM jobs WHERE asset_id IN (...)`
5. No cursor needed — the query is stateless

**`retriggerPendingJobs` changes:**

Before: Read `job_list:all` from KV, iterate all job IDs, read each job.

After:
```sql
SELECT * FROM jobs
WHERE type = 'archive-extraction'
  AND (status IN ('pending', 'failed')
       OR (status = 'running' AND updated_at < ?))
  AND retry_count < ?
```

The `retriggerPendingJobs` function currently bypasses the `JobStore` interface and directly reads KV keys. With D1, it should use the `JobStore` interface instead (adding a new query method if needed, e.g., `listRetriable()`).

### Pagination Change

**Before:** Offset-based cursor (JSON array index position as string).

**After:** Keyset pagination using `(created_at, id)` composite cursor. This is more stable than offset-based pagination — inserts/deletes don't shift pages.

```sql
SELECT * FROM assets
WHERE project_id = ?
  AND (created_at, id) < (?, ?)
ORDER BY created_at DESC, id DESC
LIMIT ?
```

The cursor is encoded as `{createdAt}:{id}` (or base64 for opacity).

The `ListResult<T>` interface (`{ items: T[]; cursor?: string }`) is unchanged — only the cursor value format changes internally.

### Repository Interface Changes

Most interfaces need no changes. Two adjustments:

1. **`ProjectStore.delete(id, ownerId)`** — The `ownerId` parameter was needed to clean up the `project_list:{ownerId}` index. With D1, the `owner_id` column is in the table itself. The parameter can remain for backward compatibility but is ignored by the D1 implementation.

2. **`JobStore`** — Add an optional method for the cleanup handler:
   ```typescript
   listRetriable?(stuckThresholdMs: number, maxRetries: number): Promise<Job[]>;
   ```
   This replaces the raw KV reads in `retriggerPendingJobs`. If the method is absent, the handler falls back to `list()` + in-memory filtering (for KV backward compatibility during phased migration).

## Implementation Plan

### Phase A: Infrastructure

| Step | File | Change |
|------|------|--------|
| A1 | `wrangler.toml` | Add D1 binding |
| A2 | `env.d.ts` | Add `DB: D1Database` |
| A3 | `worker/infra/d1-schema.sql` | New: all CREATE TABLE/INDEX statements |
| A4 | `worker/infra/d1.ts` | New: D1 store implementations (empty stubs initially) |
| A5 | `worker/infra/d1-helpers.ts` | New: snake/camel mapping, `rowToModel`, pagination helpers |

### Phase B: Members + Workspaces (low risk, low traffic)

| Step | File | Change |
|------|------|--------|
| B1 | `worker/infra/d1.ts` | Implement `D1WorkspaceStore`, `D1MemberStore` |
| B2 | `worker/app.ts` | Swap `KVWorkspaceStore` → `D1WorkspaceStore`, `KVMemberStore` → `D1MemberStore` |
| B3 | Tests | Add in-source tests for D1 implementations |

### Phase C: Projects

| Step | File | Change |
|------|------|--------|
| C1 | `worker/infra/d1.ts` | Implement `D1ProjectStore` |
| C2 | `worker/app.ts` | Swap `KVProjectStore` → `D1ProjectStore` |
| C3 | Tests | Add in-source tests |

### Phase D: Jobs

| Step | File | Change |
|------|------|--------|
| D1 | `worker/infra/d1.ts` | Implement `D1JobStore` (including `listRetriable()`) |
| D2 | `worker/job/repository.ts` | Add optional `listRetriable` to `JobStore` interface |
| D3 | `worker/cleanup/handler.ts` | Refactor `retriggerPendingJobs` to use `JobStore` interface instead of raw KV |
| D4 | `worker/app.ts` | Swap `KVJobStore` → `D1JobStore` |
| D5 | Tests | Add in-source tests |

### Phase E: Assets (highest impact)

| Step | File | Change |
|------|------|--------|
| E1 | `worker/infra/d1.ts` | Implement `D1MetadataStore` |
| E2 | `worker/cleanup/usecase.ts` | Rewrite cleanup to use D1 query instead of R2 scan |
| E3 | `worker/cleanup/handler.ts` | Remove `cleanup:cursor` KV logic; `handleScheduled` uses `MetadataStore` interface for expired asset query |
| E4 | `worker/app.ts` | Swap `KVMetadataStore` → `D1MetadataStore` |
| E5 | Tests | Add in-source tests; verify E2E tests pass |

### Phase F: Storage Usage Counters (ADR-004)

| Step | File | Change |
|------|------|--------|
| F1 | `worker/infra/d1.ts` | Implement `D1StorageUsageStore` with atomic increment |
| F2 | Asset upload/delete usecases | Add counter increment/decrement calls |
| F3 | Project/workspace GET handlers | Embed `storageUsage` in responses |
| F4 | Reconciliation cron | Simplify or remove — D1 atomic updates eliminate drift |
| F5 | Tests | Add in-source tests |

### Phase ordering and deployability

Each phase is independently deployable. Phases B + C can be combined (both small). Phase E is the largest and should be deployed separately with careful E2E verification.

```
A (infra) → B+C (members, workspaces, projects) → D (jobs) → E (assets) → F (storage usage)
```

### Data Migration

KV には永続データがないため（エフェメラルアセットは TTL で自動失効、プロジェクト/ワークスペースは未使用）、データ移行は不要。D1 スキーマを適用してコードをデプロイすれば完了。

将来 KV に永続データが存在する状態で D1 に移行する場合は、一時的なマイグレーションスクリプトまたは API エンドポイントを作成し、KV のインデックスリストからエンティティを読み出して D1 に INSERT する。

### Wrangler Configuration

```toml
# Add to wrangler.toml
[[d1_databases]]
binding = "DB"
database_name = "reearth-serve"
database_id = "D1_DATABASE_ID"
migrations_dir = "worker/infra/migrations"
```

```typescript
// Add to env.d.ts
interface Env {
  DB: D1Database;
  // ... existing bindings unchanged
}
```

### Schema Migration Management

D1にはwrangler CLI組み込みのマイグレーション機能があり、ORM は不要。

**ディレクトリ構成:**

```
worker/infra/migrations/
  0001_create_initial_tables.sql   ← Phase A: 全テーブル＋インデックス
  0002_add_xxx.sql                 ← 将来のスキーマ変更
```

**ワークフロー:**

```bash
# マイグレーションファイルを生成
npx wrangler d1 migrations create reearth-serve create_initial_tables
# → worker/infra/migrations/0001_create_initial_tables.sql

# ローカルに適用（開発時）
npx wrangler d1 migrations apply reearth-serve --local

# 本番に適用
npx wrangler d1 migrations apply reearth-serve --remote

# 未適用のマイグレーションを確認
npx wrangler d1 migrations list reearth-serve --remote
```

**特徴:**
- 適用前に自動バックアップが取られる
- 失敗したマイグレーションは自動ロールバック（前の成功状態に戻る）
- 適用済みマイグレーションはD1内部のテーブルで追跡される
- DOWN マイグレーションはない — ロールバックが必要なら新しいマイグレーションで戻すSQLを書く

**デプロイ順序:**

```bash
# 1. マイグレーション適用（スキーマを先に更新）
npx wrangler d1 migrations apply reearth-serve --remote

# 2. ビルド＆デプロイ（コードが新スキーマを参照）
npm run deploy
```

スキーマ変更が後方互換（カラム追加、テーブル追加）ならこの順序で安全。破壊的変更（カラム削除、リネーム）は2段階デプロイが必要：先にコードからカラム参照を外す → 次のデプロイでカラム削除。

### D1 Query API（ORM不要）

D1はWorkers Binding APIで `prepare().bind().run()` によるプリペアドステートメントを直接サポートしており、ORM不要でSQLインジェクション対策が組み込まれている。

```typescript
// プレースホルダ（?）で安全にパラメータをバインド
const stmt = env.DB
  .prepare("SELECT * FROM assets WHERE project_id = ? AND status = ?")
  .bind(projectId, "ready");
const { results } = await stmt.all();

// 1件取得
const row = await env.DB
  .prepare("SELECT * FROM assets WHERE id = ?")
  .bind(assetId)
  .first();

// INSERT / UPDATE / DELETE
await env.DB
  .prepare("INSERT INTO assets (id, filename, size) VALUES (?, ?, ?)")
  .bind(id, filename, size)
  .run();

// アトミックなカウンタ更新
await env.DB
  .prepare("UPDATE storage_usage SET total_size = total_size + ?, asset_count = asset_count + 1, updated_at = ? WHERE scope = ?")
  .bind(sizeBytes, Date.now(), scope)
  .run();

// 順序付きプレースホルダ（?NNN）— 同じ値を複数箇所で再利用可能
const stmt = env.DB
  .prepare("SELECT * FROM members WHERE workspace_id = ?1 OR user_id = ?2")
  .bind(workspaceId, userId);
```

**メソッド一覧:**

| メソッド | 用途 | 戻り値 |
|---------|------|--------|
| `.run()` | INSERT/UPDATE/DELETE の実行 | `{ success, meta }` |
| `.all()` | 全行取得 | `{ results: T[], success, meta }` |
| `.first()` | 1行取得 | `T \| null` |
| `.raw()` | 配列形式で取得 | `any[][]` |

D1実装ではこれらのAPIを直接使い、`rowToModel()` / `modelToRow()` ヘルパーで snake_case ↔ camelCase の変換のみ行う。

### Testing Strategy

**Unit tests:** Follow existing `import.meta.vitest` pattern. Mock `D1Database` interface similarly to the current `mockKV()`:

```typescript
function mockD1(): D1Database {
  // In-memory Map-based stub that implements prepare().bind().run()/.all()/.first()
}
```

**Existing usecase tests:** Unchanged — they mock repository interfaces, not KV/D1 directly.

**E2E tests:** `wrangler dev` supports D1 with a local SQLite file. Existing E2E tests in `e2e/` validate the full API surface after swapping implementations.

## Alternatives Considered

### Big-bang migration (all entities at once)

Rejected because: Too risky. A phased approach allows validating each entity independently and rolling back a single phase if issues arise.

### Dual-write (write to both KV and D1 during transition)

Rejected because: Adds complexity and doubles write latency. The repository interface swap is a clean cutover point. Rollback is trivial (revert `worker/app.ts`).

### Keep KV, fix race conditions with Durable Objects

Rejected because: Using Durable Objects as a coordination layer for KV writes adds significant cost and complexity. D1 solves the consistency problem natively while also unlocking query capabilities.

### Use D1 for everything (including sessions)

Rejected because: Sessions and upload sessions are ephemeral (1-hour TTL) and only need get/put/delete. KV's TTL auto-expiration is a perfect fit. Adding cron-based cleanup for sessions in D1 would be unnecessary overhead.

## Consequences

- **Consistency:** Index list race conditions are eliminated. Concurrent asset uploads to the same project can no longer silently drop entries.
- **Queries:** Filtered listing, sorting, and aggregation become possible (useful for admin dashboards, storage usage calculation, and future features).
- **Cleanup efficiency:** Expired asset discovery changes from O(n) R2 scan to O(1) SQL query.
- **Storage usage:** Atomic counters eliminate the need for periodic reconciliation (ADR-003 simplification).
- **New dependency:** D1 is added to the infrastructure. However, D1 is part of the Cloudflare Workers platform (same as KV, R2, Queues), so no external infrastructure is introduced.
- **KV retained:** Sessions and upload sessions continue to use KV. The KV binding remains in `wrangler.toml`.
- **Migration effort:** Each phase requires a one-time data migration script. No downtime — the swap is a code deployment.
- **Pagination model:** Changes from offset-based to keyset-based, which is more stable but a subtle behavioral change for API consumers. Since cursors are opaque strings, this should be transparent.
