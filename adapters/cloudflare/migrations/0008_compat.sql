-- Migration 0008: storage compatibility layer (ADR-019)
--
-- No foreign keys to assets: the memory store would not cascade, so
-- SqlAtomicWrites.deleteAsset drops an asset's bindings and hashes in its batch.

CREATE TABLE compat_buckets (
  name        TEXT PRIMARY KEY,
  project_id  TEXT NOT NULL,
  mount_rule  TEXT,
  upstream    TEXT,
  created_at  INTEGER NOT NULL,
  last_generation INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX idx_compat_buckets_project ON compat_buckets(project_id);

CREATE TABLE compat_bindings (
  bucket      TEXT NOT NULL,
  key         TEXT NOT NULL,
  binding     TEXT NOT NULL CHECK (binding IN ('object', 'folder')),
  asset_id    TEXT,
  claimed_at  INTEGER NOT NULL,
  claim_token TEXT NOT NULL,
  lease_token TEXT,
  leased_at   INTEGER,
  PRIMARY KEY (bucket, key)
);

CREATE INDEX idx_compat_bindings_asset ON compat_bindings(asset_id);

CREATE TABLE compat_hashes (
  object_ref  TEXT PRIMARY KEY,
  asset_id    TEXT NOT NULL,
  generation  INTEGER NOT NULL,
  md5         BLOB NOT NULL,
  crc32c      INTEGER NOT NULL
);

CREATE INDEX idx_compat_hashes_asset ON compat_hashes(asset_id);

CREATE TABLE compat_credentials (
  id            TEXT PRIMARY KEY,
  project_id    TEXT NOT NULL,
  bucket        TEXT NOT NULL,
  role          TEXT NOT NULL CHECK (role IN ('viewer', 'editor')),
  client_email  TEXT NOT NULL UNIQUE,
  public_jwk    TEXT NOT NULL,
  label         TEXT,
  created_by    TEXT NOT NULL,
  created_at    INTEGER NOT NULL,
  revoked_at    INTEGER
);

CREATE INDEX idx_compat_credentials_project ON compat_credentials(project_id);
CREATE INDEX idx_compat_credentials_bucket ON compat_credentials(bucket);

CREATE TABLE compat_uploads (
  id             TEXT PRIMARY KEY,
  bucket         TEXT NOT NULL,
  key            TEXT NOT NULL,
  credential_id  TEXT NOT NULL,
  meta           TEXT NOT NULL,
  received       INTEGER NOT NULL,
  hash_state     TEXT NOT NULL,
  state          TEXT NOT NULL CHECK (state IN ('open', 'committing', 'committed')),
  result         TEXT,
  expires_at     INTEGER NOT NULL
);

CREATE INDEX idx_compat_uploads_bucket ON compat_uploads(bucket);
CREATE INDEX idx_compat_uploads_expires ON compat_uploads(expires_at);
