-- Migration 0009: the content-addressed blob layer (ADR-017 §3, §5; phase P2)
--
-- An upload that declares its SHA-256 is stored at `blobs/{scope}/{sha256}`
-- instead of under the asset's own prefix. Readers must not guess which, so
-- each row records it:
--
--   assets.blob_key / asset_versions.blob_key
--     The storage key of the row's original bytes when they live in the blob
--     layer. NULL means the classic layout: `assets/{assetId}/{filename}` for
--     an asset row, `assets/{assetId}/v/{versionId}/{filename}` for a version.
--     Written once, when the row is created; core/blob/model.ts
--     (`originalKey`) is the one reader.
--
-- `blob_refs` is the ledger of the blob layer: one row per blob key.
--
--   key              'blobs/' || scope || '/' || sha256 — what `blob_key` holds
--   scope            workspace ID, 'p_' || project ID for a project with no
--                    workspace, '_demo' for demo uploads (core/blob/model.ts)
--   ref_count        asset and version rows whose `blob_key` is `key`
--   state            'uploading'  claimed by a presigned upload session; no row
--                                 references it yet
--                    'verifying'  the claim completed but the store did not
--                                 vouch for the hash; the integrity job settles
--                                 it (ADR-017 §2)
--                    'ready'      the bytes are verified (or a direct upload is
--                                 about to write verified bytes)
--                    'deleting'   a sweep is removing the object; nothing may
--                                 write or attach to the key until the row is gone
--   claim_id         the upload session holding an 'uploading' claim
--   claim_expires_at when that claim lapses (the session's expiry)
--   zero_since       when ref_count last reached 0; the cleanup cron deletes
--                    the object a grace period later
--
-- Storage usage (ADR-004) is not derived from this table: it stays per asset
-- and per version row, as if every row held its own copy.

ALTER TABLE assets ADD COLUMN blob_key TEXT;
ALTER TABLE asset_versions ADD COLUMN blob_key TEXT;

CREATE INDEX idx_assets_blob_key ON assets(blob_key) WHERE blob_key IS NOT NULL;
CREATE INDEX idx_versions_blob_key ON asset_versions(blob_key) WHERE blob_key IS NOT NULL;

CREATE TABLE blob_refs (
  key              TEXT PRIMARY KEY,
  scope            TEXT NOT NULL,
  sha256           TEXT NOT NULL,
  ref_count        INTEGER NOT NULL DEFAULT 0,
  state            TEXT NOT NULL,
  claim_id         TEXT,
  claim_expires_at INTEGER,
  zero_since       INTEGER,
  created_at       INTEGER NOT NULL,
  updated_at       INTEGER NOT NULL
);

-- The cleanup cron's two scans: unreferenced blobs past their grace period,
-- and claims past their expiry.
CREATE INDEX idx_blob_refs_zero ON blob_refs(zero_since) WHERE ref_count = 0;
CREATE INDEX idx_blob_refs_claims ON blob_refs(claim_expires_at) WHERE state = 'uploading';
