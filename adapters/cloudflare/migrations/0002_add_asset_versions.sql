-- Migration 0002: Add asset versioning (ADR-005)
--
-- Introduces the `asset_versions` table so that each asset can hold
-- multiple versions while keeping the asset ID (and public URL) stable.
-- The `assets` table gains `active_version_id`, `description`, and
-- `user_meta` columns.

-- Asset versions
-- meta contains: contentEncoding, originalSize, archiveFormat, fileCount, extractedSize, jobId
CREATE TABLE asset_versions (
  id           TEXT PRIMARY KEY,
  asset_id     TEXT NOT NULL,
  version      INTEGER NOT NULL,
  filename     TEXT NOT NULL,
  content_type TEXT NOT NULL,
  size         INTEGER NOT NULL,
  created_at   INTEGER NOT NULL,
  type         TEXT,
  status       TEXT,
  meta         TEXT,
  user_meta    TEXT,
  UNIQUE(asset_id, version)
);
CREATE INDEX idx_versions_asset ON asset_versions(asset_id);

-- Extend assets table
ALTER TABLE assets ADD COLUMN active_version_id TEXT;
ALTER TABLE assets ADD COLUMN description TEXT;
ALTER TABLE assets ADD COLUMN user_meta TEXT;

-- Add version_id to jobs for version-scoped extraction
ALTER TABLE jobs ADD COLUMN version_id TEXT;
CREATE INDEX idx_jobs_version ON jobs(version_id) WHERE version_id IS NOT NULL;
