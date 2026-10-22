-- Migration 0005: custom-domain verification columns (ADR-013 B5)
--
-- `site_hosts` already carries `verified_at` (added in 0004 for exactly this),
-- but a verification needs two more things 0004 did not anticipate:
--
--   verification_token  the secret the customer publishes as
--                       TXT _reearth-serve-verify.<hostname>. Issued at
--                       registration and compared on every verify attempt, so
--                       it has to survive between the two calls. Null on
--                       `subdomain` rows — there is nothing to prove about a
--                       name under our own suffix.
--   certificate_status  what the CustomHostnameProvisioner last reported:
--                       'pending' while Cloudflare for SaaS (or the platform's
--                       equivalent) is issuing, 'active' once the hostname
--                       serves TLS. Null until verification runs. It is a
--                       cache of the provider's state, never the source of
--                       truth — the single-row GET refreshes it while pending.
--
-- Two ALTERs rather than a table rebuild: SQLite adds a nullable column
-- without rewriting the table, and 0004 is already applied in production.

ALTER TABLE site_hosts ADD COLUMN verification_token TEXT;
ALTER TABLE site_hosts ADD COLUMN certificate_status TEXT;
