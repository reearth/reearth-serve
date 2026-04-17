-- Migration 0003: Add cleanup_pending table (SCA-02)
--
-- DELETE /api/v1/assets/:id previously removed only the single archive
-- object + D1 row, leaving every extracted file under assets/{id}/files/*
-- stranded in R2 forever (cron's listExpired couldn't see them — the asset
-- row was gone). Project assets were already untouched by cron anyway
-- (expiresAt=0), so project-asset deletes leaked storage too.
--
-- cleanup_pending records R2 prefixes that the DELETE handler couldn't
-- finish wiping synchronously. The scheduled worker drains them under
-- subrequest-budget control, the same way it handles expired assets.

CREATE TABLE cleanup_pending (
  prefix     TEXT PRIMARY KEY,
  created_at INTEGER NOT NULL
);
CREATE INDEX idx_cleanup_pending_created ON cleanup_pending(created_at);
