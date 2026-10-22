/**
 * The `site_hosts` port (ADR-013 B2).
 *
 * One row per hostname. The hostname is the full host — `{name}{suffix}` for a
 * subdomain, the customer's host for a custom domain (B5) — so the resolver's
 * lookup is a primary-key read on the value it already has, and both kinds
 * live in one table behind one resolver.
 */

export type SiteHostKind = "subdomain" | "custom";

export interface SiteHost {
  /** Full host, lowercase. Primary key. */
  hostname: string;
  /** Target asset. Null only on a released row (B3). */
  assetId: string | null;
  /** Owning project: listing, quota and authorization all key off it. */
  projectId: string;
  kind: SiteHostKind;
  /** Null for `subdomain` — nothing to verify; the TXT check for `custom` (B5). */
  verifiedAt: number | null;
  /**
   * The secret the customer publishes as `TXT _reearth-serve-verify.{hostname}`
   * (B5). Issued when a `custom` row is created and compared on every verify
   * attempt; null on `subdomain` rows.
   */
  verificationToken: string | null;
  /**
   * What the `CustomHostnameProvisioner` last reported for this hostname (B5).
   * Null until the row is verified; a cache of the provider's state, never the
   * source of truth.
   */
  certificateStatus: string | null;
  /** Non-null ⇒ held but not serving (B3 disable; unused until then). */
  disabledAt: number | null;
  /** Whether `v{n}--` / `latest--` hosts resolve (B4). Off by default. */
  previews: boolean;
  /** Set instead of deleting; starts the 30-day cooldown (B3). */
  releasedAt: number | null;
  createdAt: number;
  createdBy: string | null;
}

/** The mutable part of a claimed row. Omitted fields are left alone. */
export interface SiteHostPatch {
  /** Timestamp to disable at, or null to enable (B3). */
  disabledAt?: number | null;
  /** Whether `v{n}--` / `latest--` hosts resolve (B4). */
  previews?: boolean;
  /** Timestamp the TXT check passed at (B5). Never cleared once set. */
  verifiedAt?: number | null;
  /** The provisioner's latest word on the certificate (B5). */
  certificateStatus?: string | null;
}

export interface SiteHostStore {
  find(hostname: string): Promise<SiteHost | null>;
  /** Active (not released) rows of an asset. */
  listByAsset(assetId: string): Promise<SiteHost[]>;
  /** Active (not released) rows of a project. */
  listByProject(projectId: string): Promise<SiteHost[]>;
  /**
   * Claim a hostname. Returns false when the hostname is already present —
   * including a released row inside its cooldown — so a lost race reports
   * "name is taken" rather than overwriting someone else's row.
   */
  insert(host: SiteHost): Promise<boolean>;
  /**
   * Change the two switches of an active row (B3 disable/enable, B4 previews).
   * Released rows are never touched: the caller rejects them before getting
   * here, and the `released_at IS NULL` guard keeps a race from reviving one.
   */
  update(hostname: string, patch: SiteHostPatch): Promise<void>;
  /** Hard-remove a row. Only for a cooldown that has run out, and for the cron. */
  remove(hostname: string): Promise<void>;
  /** Start the cooldown: set `released_at`, null `asset_id`. */
  release(hostname: string, releasedAt: number): Promise<void>;
  /**
   * Release every name of an asset (asset deletion — B3: releases, does not
   * cascade). Returns the hostnames released, so the caller can drop their
   * cache entries.
   */
  releaseByAsset(assetId: string, releasedAt: number): Promise<string[]>;
  /** Active rows in a project, for the per-project quota. */
  countActiveByProject(projectId: string): Promise<number>;
  /** Purge released rows whose cooldown ended before `before`. Returns them. */
  purgeReleasedBefore(before: number, limit: number): Promise<string[]>;
}
