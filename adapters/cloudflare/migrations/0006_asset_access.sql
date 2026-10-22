-- Migration 0006: asset access mode and password material (ADR-013 B7)
--
-- Four nullable/defaulted columns on `assets`, so every existing row keeps
-- working and reads as `public` without a backfill:
--
--   access            'public' | 'password'. NULL means 'public' — the default
--                     is expressed by absence rather than by an UPDATE over
--                     every row that predates this migration.
--   password_hash     PBKDF2-SHA256, encoded as `pbkdf2-sha256$<iterations>$<base64>`
--                     so the work factor can be raised without a second column
--                     and old hashes still verify.
--   password_salt     Base64, 16 random bytes, one per asset.
--   password_version  Incremented on every password change and carried inside
--                     the auth cookie, so rotating the password invalidates
--                     every outstanding cookie with no session state to sweep.
--                     Starts at 0.
--
-- The two secret columns are never selected into `AssetMetadata` (see
-- `parseAssetRow` in adapters/sql/stores.ts): they are read by their own
-- statement, for protected assets only, which is what makes "the hash is never
-- in an API response" a property of the store rather than a rule to remember at
-- each route.
--
-- ALTERs rather than a table rebuild: SQLite adds a nullable column without
-- rewriting the table, and 0001 is long since applied in production.

ALTER TABLE assets ADD COLUMN access TEXT;
ALTER TABLE assets ADD COLUMN password_hash TEXT;
ALTER TABLE assets ADD COLUMN password_salt TEXT;
ALTER TABLE assets ADD COLUMN password_version INTEGER NOT NULL DEFAULT 0;
