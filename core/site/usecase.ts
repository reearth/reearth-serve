/**
 * Claiming, listing and releasing site names (ADR-013 B2, B3).
 *
 * Everything here is provider-independent and takes its collaborators as
 * arguments, so the handler layer only translates HTTP. `now` is injected
 * rather than read from the clock so the cooldown and the purge are testable
 * without waiting 30 days.
 */

import type { KeyValue } from "../kv/port";
import type { AssetMetadata } from "../asset/model";
import { hostCacheKey } from "./resolver";
import { cooldownError, NAME_ERRORS, toSiteName, validateSiteName } from "./names";
import type { SiteHost, SiteHostKind, SiteHostPatch, SiteHostStore } from "./repository";

/** Per-project cap on active names. Raised per plan later (B2). */
export const SITE_HOST_QUOTA = 20;

/** How long a released name is held before it can be claimed again (B3). */
export const RELEASE_COOLDOWN_MS = 30 * 24 * 60 * 60 * 1000;

export const SITE_HOST_ERRORS = {
  notEnabled: "site hosts are not enabled on this server",
  customUnsupported: "custom domains are not supported yet",
  projectRequired: "names require a project asset",
  archiveRequired: "names require an archive asset",
  quota: `project has reached its limit of ${SITE_HOST_QUOTA} site names`,
  released: "name has been released",
} as const;

export type ClaimFailure = { ok: false; status: 400 | 503; error: string };
export type ClaimSuccess = { ok: true; host: SiteHost };
export type ClaimResult = ClaimSuccess | ClaimFailure;

export interface SiteHostDeps {
  hosts: SiteHostStore;
  /** Resolution cache; entries are dropped on every change to a row (B6). */
  cache?: KeyValue;
  /** `SITE_HOST_SUFFIX`. Undefined ⇒ claiming is unavailable (reads are not). */
  suffix: string | undefined;
}

export interface ClaimParams {
  asset: AssetMetadata;
  /** Bare label or full host; both round-trip. */
  hostname: string;
  kind?: SiteHostKind;
  userId: string | null;
  now?: number;
}

export async function claimSiteHost(deps: SiteHostDeps, params: ClaimParams): Promise<ClaimResult> {
  const now = params.now ?? Date.now();
  const kind = params.kind ?? "subdomain";

  // B5. Rejected before anything else so the caller is told the kind is not
  // supported rather than that their perfectly good domain is malformed.
  if (kind !== "subdomain") {
    return { ok: false, status: 400, error: SITE_HOST_ERRORS.customUnsupported };
  }
  // Without a suffix there is no host to claim: the row would name a host that
  // resolves nowhere. Reading and listing stay available either way, so an
  // operator can enable the feature later without losing rows.
  if (!deps.suffix) {
    return { ok: false, status: 503, error: SITE_HOST_ERRORS.notEnabled };
  }
  // Demo assets expire in an hour and have no accountable owner; a name that
  // outlives its asset by 29 days is exactly what the cooldown is for, and
  // there would be no project to hold it (B2).
  if (!params.asset.projectId) {
    return { ok: false, status: 400, error: SITE_HOST_ERRORS.projectRequired };
  }
  // A name promises a site, and a site is an extracted archive. Pointing a
  // hostname at a single GeoJSON would promise one that does not exist (B1).
  if (params.asset.type !== "archive") {
    return { ok: false, status: 400, error: SITE_HOST_ERRORS.archiveRequired };
  }

  const check = validateSiteName(toSiteName(params.hostname, deps.suffix));
  if (!check.ok) return { ok: false, status: 400, error: check.error };

  const hostname = `${check.name}${deps.suffix}`;
  const existing = await deps.hosts.find(hostname);
  if (existing) {
    if (existing.releasedAt === null) {
      return { ok: false, status: 400, error: NAME_ERRORS.taken };
    }
    const until = existing.releasedAt + RELEASE_COOLDOWN_MS;
    if (now < until) {
      return { ok: false, status: 400, error: cooldownError(until) };
    }
    // Cooldown served. The cron would have purged this row on its next tick;
    // doing it here means a name is claimable the moment it is free rather
    // than whenever the cron next runs.
    await deps.hosts.remove(hostname);
  }

  if (await deps.hosts.countActiveByProject(params.asset.projectId) >= SITE_HOST_QUOTA) {
    return { ok: false, status: 400, error: SITE_HOST_ERRORS.quota };
  }

  const host: SiteHost = {
    hostname,
    assetId: params.asset.id,
    projectId: params.asset.projectId,
    kind,
    verifiedAt: null,
    disabledAt: null,
    previews: false,
    releasedAt: null,
    createdAt: now,
    createdBy: params.userId,
  };
  // A concurrent claim that won the race owns the row; report it as taken
  // rather than overwriting it.
  if (!await deps.hosts.insert(host)) {
    return { ok: false, status: 400, error: NAME_ERRORS.taken };
  }

  // The resolver may have cached this hostname as a miss (a visitor who tried
  // the name before it existed); drop it so the site is live immediately.
  await dropCache(deps.cache, [hostname]);

  // ADR-007: emit site_host.claimed here — there is no event store in core yet.

  return { ok: true, host };
}

export type UpdateResult =
  | { ok: true; host: SiteHost }
  | { ok: false; status: 404 | 409; error: string };

export interface UpdateParams {
  /** The asset the caller is acting through; the row must belong to it. */
  assetId: string;
  /** The asset's project, for deciding what a released row is allowed to say. */
  projectId: string | undefined;
  hostname: string;
  /** B3: true sets `disabled_at`, false clears it. Undefined leaves it alone. */
  disabled?: boolean;
  /** B4: `v{n}--` / `latest--` previews. Undefined leaves it alone. */
  previews?: boolean;
  now?: number;
}

/**
 * Change a claimed name's publish state (B3) or its preview flag (B4).
 *
 * Disabling holds the name and takes the site down (`503`); enabling puts it
 * back. A released row is not a candidate: it has no asset and is living out
 * its cooldown, so the answer is `409` rather than a state change nobody could
 * observe.
 */
export async function updateSiteHost(deps: SiteHostDeps, params: UpdateParams): Promise<UpdateResult> {
  const now = params.now ?? Date.now();
  const hostname = toFullHost(params.hostname, deps.suffix);

  const existing = await deps.hosts.find(hostname);
  if (!existing) return notFound();
  if (existing.releasedAt !== null) {
    // The row's asset is gone, so ownership is judged by the project that still
    // holds the name. Someone else's released name is a 404: this endpoint must
    // not confirm that a name exists to a caller who cannot act on it.
    return existing.projectId === params.projectId && params.projectId !== undefined
      ? { ok: false, status: 409, error: SITE_HOST_ERRORS.released }
      : notFound();
  }
  if (existing.assetId !== params.assetId) return notFound();

  const patch: SiteHostPatch = {
    ...(params.disabled !== undefined && { disabledAt: params.disabled ? now : null }),
    ...(params.previews !== undefined && { previews: params.previews }),
  };
  await deps.hosts.update(hostname, patch);

  // The resolver caches the row's state, disabled included, so the switch has
  // to reach the cache or the site would take up to a minute to go down.
  await dropCache(deps.cache, [hostname]);

  // ADR-007: emit site_host.disabled / .enabled / .previews_changed here —
  // there is no event store in core yet.

  return {
    ok: true,
    host: {
      ...existing,
      disabledAt: patch.disabledAt !== undefined ? patch.disabledAt : existing.disabledAt,
      previews: patch.previews !== undefined ? patch.previews : existing.previews,
    },
  };
}

function notFound(): UpdateResult {
  return { ok: false, status: 404, error: "Host not found" };
}

export type ReleaseResult = { ok: true } | { ok: false; status: 404; error: string };

/**
 * Release a name (B3): the row survives with `released_at` set and no asset,
 * so the host answers 410 and nobody else can claim it for 30 days.
 */
export async function releaseSiteHost(
  deps: SiteHostDeps,
  params: { assetId: string; hostname: string; now?: number },
): Promise<ReleaseResult> {
  const now = params.now ?? Date.now();
  const hostname = toFullHost(params.hostname, deps.suffix);

  const existing = await deps.hosts.find(hostname);
  // A released row is already gone as far as this asset is concerned, and a
  // row belonging to another asset must not be confirmed to exist.
  if (!existing || existing.releasedAt !== null || existing.assetId !== params.assetId) {
    return { ok: false, status: 404, error: "Host not found" };
  }

  await deps.hosts.release(hostname, now);
  await dropCache(deps.cache, [hostname]);

  // ADR-007: emit site_host.released here — there is no event store in core yet.

  return { ok: true };
}

/**
 * Release every name of an asset being deleted (B3: "asset deletion releases,
 * it does not cascade"). Returns the hostnames released.
 */
export async function releaseAssetSiteHosts(
  deps: SiteHostDeps,
  assetId: string,
  now: number = Date.now(),
): Promise<string[]> {
  const released = await deps.hosts.releaseByAsset(assetId, now);
  await dropCache(deps.cache, released);
  // ADR-007: emit site_host.released here — there is no event store in core yet.
  return released;
}

export function listAssetSiteHosts(deps: SiteHostDeps, assetId: string): Promise<SiteHost[]> {
  return deps.hosts.listByAsset(assetId);
}

export function listProjectSiteHosts(deps: SiteHostDeps, projectId: string): Promise<SiteHost[]> {
  return deps.hosts.listByProject(projectId);
}

/**
 * Purge released rows whose cooldown has run out — the cleanup cron's share of
 * B3. Until this runs the name stays held, which is the point.
 */
export async function purgeReleasedSiteHosts(
  deps: SiteHostDeps,
  options: { now?: number; limit?: number } = {},
): Promise<string[]> {
  const now = options.now ?? Date.now();
  const purged = await deps.hosts.purgeReleasedBefore(now - RELEASE_COOLDOWN_MS, options.limit ?? 100);
  await dropCache(deps.cache, purged);
  return purged;
}

/** The full host for a name given as either form. */
export function toFullHost(hostname: string, suffix: string | undefined): string {
  const name = toSiteName(hostname, suffix);
  return suffix && !name.includes(".") ? `${name}${suffix}` : name;
}

/** The URL a named site is served from; the scheme follows `baseUrl` (B1). */
export function siteHostUrl(hostname: string, baseUrl: string): string {
  let protocol = "https:";
  try {
    protocol = new URL(baseUrl).protocol;
  } catch {
    // A malformed BASE_URL is a deployment problem, not a reason to fail the
    // claim; https is the only sane default for a public hostname.
  }
  return `${protocol}//${hostname}/`;
}

async function dropCache(cache: KeyValue | undefined, hostnames: string[]): Promise<void> {
  if (!cache) return;
  for (const hostname of hostnames) {
    try {
      await cache.delete(hostCacheKey(hostname));
    } catch {
      // A stale cache entry expires within a minute on its own; failing the
      // claim over it would be worse.
    }
  }
}
