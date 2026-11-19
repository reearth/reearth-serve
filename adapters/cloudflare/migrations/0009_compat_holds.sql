CREATE INDEX idx_compat_bindings_claims ON compat_bindings(claimed_at) WHERE asset_id IS NULL;
CREATE INDEX idx_compat_bindings_leases ON compat_bindings(leased_at) WHERE lease_token IS NOT NULL;

DROP TABLE compat_uploads;

CREATE TABLE compat_uploads (
  id             TEXT PRIMARY KEY,
  bucket         TEXT NOT NULL,
  key            TEXT NOT NULL,
  credential_id  TEXT NOT NULL,
  meta           TEXT NOT NULL,
  expires_at     INTEGER NOT NULL,
  revision       INTEGER NOT NULL,
  phase          TEXT NOT NULL
);

CREATE INDEX idx_compat_uploads_bucket ON compat_uploads(bucket);
CREATE INDEX idx_compat_uploads_expires ON compat_uploads(expires_at);
