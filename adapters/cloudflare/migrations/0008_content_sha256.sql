-- Migration 0008: SHA-256 and integrity state of stored bytes (ADR-017 §1)
--
--   sha256     lowercase hex SHA-256 of the stored object — after the client's
--              gzip when it is stored gzip.
--   integrity  'verified' | 'pending' | 'failed'. 'verified': the store or
--              Serve hashed the stored bytes and they match. 'pending': the
--              bytes are in place but the hash is not confirmed yet (presigned
--              multipart; confirmed by a later job, ADR-017 §2).
--
-- Both columns go on `assets` as well as `asset_versions`: a first upload
-- creates only the asset row — versions start at the second upload (ADR-005) —
-- so the asset row is where the first object's hash lives, exactly as its
-- `size` and `content_type` do.
--
-- Flat columns, not `meta` keys: a later phase (ADR-017 §3, §5) looks blobs up
-- and reference-counts them by hash, which wants a column it can index.
--
-- Nullable with no default: NULL on both means "stored before ADR-017". The
-- backfill (ADR-017 follow-up, P4) fills them in.

ALTER TABLE assets ADD COLUMN sha256 TEXT;
ALTER TABLE assets ADD COLUMN integrity TEXT;
ALTER TABLE asset_versions ADD COLUMN sha256 TEXT;
ALTER TABLE asset_versions ADD COLUMN integrity TEXT;
