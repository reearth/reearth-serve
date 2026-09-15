-- Migration 0007: SPA fallback opt-in (ADR-013 C1)
--
--   spa  0 | 1. When 1, a miss inside an extracted archive that does not look
--        like a request for an asset file is answered with the archive's root
--        `index.html` and status 200, so a client-side route survives a reload.
--        Defaults to 0: a 3D Tiles viewer asking for a tile that is not there
--        must see a 404, not an HTML body.
--
-- A flat column rather than a key inside `user_meta`, for the same reason
-- `access` is flat (0006): `user_meta` is caller-owned and a system field
-- living inside it would be silently destroyed by any client that PATCHes the
-- whole object. ADR-013 C1 wrote it as `userMeta.hosting.spa`; the deviation is
-- recorded in the ADR's C1 implementation notes.
--
-- NOT NULL DEFAULT 0 is safe on ALTER TABLE in SQLite (a constant default needs
-- no table rewrite), and every existing row reads as "no fallback" without a
-- backfill.

ALTER TABLE assets ADD COLUMN spa INTEGER NOT NULL DEFAULT 0;
