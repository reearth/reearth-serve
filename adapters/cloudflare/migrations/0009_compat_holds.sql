-- Migration 0009: partial indexes for the claims and leases the scheduled sweep clears (ADR-019)

CREATE INDEX idx_compat_bindings_claims ON compat_bindings(claimed_at) WHERE asset_id IS NULL;
CREATE INDEX idx_compat_bindings_leases ON compat_bindings(leased_at) WHERE lease_token IS NOT NULL;
