-- Migration 0010: indexes for the SHA-256 backfill (ADR-017 phase P4)
--
-- Rows stored before ADR-017 have `sha256` and `integrity` both NULL
-- (migration 0008). The cleanup cron hashes them a few at a time: each tick it
-- reads one page of such rows that have no `integrity-backfill` job yet
-- (core/integrity/backfill.ts, adapters/sql/integrity-backfill.ts).
--
-- Without an index that page is a scan of every asset and version, every tick,
-- and the scan gets longer as the backfill proceeds (the rows it skips are the
-- ones already hashed). The partial indexes hold only the rows still to do, so
-- the page costs a handful of reads and an empty index once the backfill is
-- over. A row leaves the index when the backfill (or anything else) writes its
-- hash.
--
-- `idx_jobs_type_status` serves the cron's count of backfill jobs still open,
-- which bounds how many run at once.

CREATE INDEX idx_assets_unhashed ON assets(created_at)
  WHERE sha256 IS NULL AND integrity IS NULL;
CREATE INDEX idx_asset_versions_unhashed ON asset_versions(created_at)
  WHERE sha256 IS NULL AND integrity IS NULL;
CREATE INDEX idx_jobs_type_status ON jobs(type, status);
