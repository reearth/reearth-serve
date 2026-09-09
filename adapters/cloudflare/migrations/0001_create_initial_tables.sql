-- Migration 0001: Create initial tables for D1 migration from KV
-- See ADR-003 for context and rationale
--
-- Each table has a `meta` TEXT column for schema-less extension (JSON).
-- Fields that are never used in WHERE/ORDER BY are stored in `meta`
-- to avoid migrations for every new optional field.

-- Workspaces
CREATE TABLE workspaces (
  id         TEXT PRIMARY KEY,
  name       TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  meta       TEXT
);

-- Members (workspace ↔ user join table)
CREATE TABLE members (
  workspace_id TEXT NOT NULL,
  user_id      TEXT NOT NULL,
  role         TEXT NOT NULL,
  created_at   INTEGER NOT NULL,
  updated_at   INTEGER NOT NULL,
  meta         TEXT,
  PRIMARY KEY (workspace_id, user_id)
);
CREATE INDEX idx_members_user ON members(user_id);

-- Projects
CREATE TABLE projects (
  id           TEXT PRIMARY KEY,
  name         TEXT NOT NULL,
  created_at   INTEGER NOT NULL,
  updated_at   INTEGER NOT NULL,
  owner_id     TEXT NOT NULL,
  workspace_id TEXT,
  meta         TEXT
);
CREATE INDEX idx_projects_owner ON projects(owner_id);
CREATE INDEX idx_projects_workspace ON projects(workspace_id) WHERE workspace_id IS NOT NULL;

-- Jobs
-- meta contains: completedAt, startedAt, error, totalFiles, fileCount, extractedSize
CREATE TABLE jobs (
  id          TEXT PRIMARY KEY,
  asset_id    TEXT NOT NULL,
  type        TEXT NOT NULL,
  status      TEXT NOT NULL,
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL,
  retry_count INTEGER DEFAULT 0,
  session_id  TEXT,
  project_id  TEXT,
  meta        TEXT
);
CREATE INDEX idx_jobs_session ON jobs(session_id) WHERE session_id IS NOT NULL;
CREATE INDEX idx_jobs_project ON jobs(project_id) WHERE project_id IS NOT NULL;
CREATE INDEX idx_jobs_status ON jobs(status);
CREATE INDEX idx_jobs_asset ON jobs(asset_id);

-- Assets
-- meta contains: contentEncoding, originalSize, archiveFormat, fileCount, extractedSize, jobId
CREATE TABLE assets (
  id         TEXT PRIMARY KEY,
  filename   TEXT NOT NULL,
  content_type TEXT NOT NULL,
  size       INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  type       TEXT,
  status     TEXT,
  session_id TEXT,
  project_id TEXT,
  meta       TEXT
);
CREATE INDEX idx_assets_session ON assets(session_id) WHERE session_id IS NOT NULL;
CREATE INDEX idx_assets_project ON assets(project_id) WHERE project_id IS NOT NULL;
CREATE INDEX idx_assets_expires ON assets(expires_at);
CREATE INDEX idx_assets_created ON assets(created_at);

-- Storage usage counters (ADR-004)
CREATE TABLE storage_usage (
  scope       TEXT PRIMARY KEY,
  total_size  INTEGER NOT NULL DEFAULT 0,
  asset_count INTEGER NOT NULL DEFAULT 0,
  updated_at  INTEGER NOT NULL,
  meta        TEXT
);
