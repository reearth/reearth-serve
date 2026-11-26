ALTER TABLE compat_buckets ADD COLUMN last_generation INTEGER NOT NULL DEFAULT 0;

UPDATE compat_buckets SET last_generation = created_at * 1000;

ALTER TABLE compat_bindings ADD COLUMN lease_token TEXT;
ALTER TABLE compat_bindings ADD COLUMN leased_at INTEGER;

CREATE TABLE compat_hashes_new (
  object_ref  TEXT PRIMARY KEY,
  asset_id    TEXT NOT NULL,
  generation  INTEGER NOT NULL,
  md5         BLOB,
  crc32c      INTEGER
);

INSERT INTO compat_hashes_new (object_ref, asset_id, generation, md5, crc32c)
  SELECT h.object_ref, h.asset_id,
         ROW_NUMBER() OVER (ORDER BY h.asset_id, COALESCE(v.version, 0), h.object_ref),
         h.md5, h.crc32c
    FROM compat_hashes AS h
    LEFT JOIN asset_versions AS v ON v.id = h.object_ref AND v.asset_id = h.asset_id;

-- SQLite cannot drop NOT NULL in place; the rows were copied into compat_hashes_new above.
-- atlas:nolint DS102
DROP TABLE compat_hashes;
ALTER TABLE compat_hashes_new RENAME TO compat_hashes;

CREATE INDEX idx_compat_hashes_asset ON compat_hashes(asset_id);
