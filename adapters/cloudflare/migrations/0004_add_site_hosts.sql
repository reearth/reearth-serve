-- Migration 0004: Add site_hosts table (ADR-013 B2)
--
-- One row per hostname a site is served from. Named subdomains
-- (`kawasaki-flood-map.serve.reearth.land`) are the `subdomain` kind; custom
-- domains (ADR-013 B5) will be the `custom` kind in the same table, so one
-- resolver serves both.
--
-- `hostname` is the FULL host, not the bare label: a custom domain has no
-- suffix to append, and storing the full host keeps the resolver's lookup a
-- single primary-key read on the value it already has.
--
-- No foreign key to assets: deleting an asset must RELEASE its names, not
-- cascade them away (ADR-013 B3). A plain ON DELETE CASCADE would free the
-- name immediately and reopen the subdomain-takeover window that the 30-day
-- cooldown exists to close. `asset_id` is therefore nullable — a released row
-- points at nothing while it lives out its cooldown.

CREATE TABLE site_hosts (
  hostname    TEXT PRIMARY KEY,
  asset_id    TEXT,
  project_id  TEXT NOT NULL,
  kind        TEXT NOT NULL,
  verified_at INTEGER,
  disabled_at INTEGER,
  previews    INTEGER NOT NULL DEFAULT 0,
  released_at INTEGER,
  created_at  INTEGER NOT NULL,
  created_by  TEXT
);

CREATE INDEX idx_site_hosts_asset ON site_hosts(asset_id);
CREATE INDEX idx_site_hosts_project ON site_hosts(project_id);
-- The cleanup cron purges rows whose cooldown has run out; without this it
-- would scan the whole table on every tick.
CREATE INDEX idx_site_hosts_released ON site_hosts(released_at);
