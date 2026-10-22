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
import {
  CUSTOM_HOST_ERRORS, newVerificationToken, validateCustomHostname,
  verificationRecordName, verificationRecordValue,
} from "./custom";
import type { DnsResolver } from "./dns";
import type { CustomHostnameProvisioner } from "./provisioner";
import { apexHost } from "./middleware";
import type { SiteHost, SiteHostKind, SiteHostPatch, SiteHostStore } from "./repository";

/** Per-project cap on active names. Raised per plan later (B2). */
export const SITE_HOST_QUOTA = 20;

/** How long a released name is held before it can be claimed again (B3). */
export const RELEASE_COOLDOWN_MS = 30 * 24 * 60 * 60 * 1000;

/** How many verify attempts one hostname gets per window (B5). */
export const VERIFY_ATTEMPT_LIMIT = 10;
export const VERIFY_ATTEMPT_WINDOW_SECONDS = 60 * 60;

export const SITE_HOST_ERRORS = {
  notEnabled: "site hosts are not enabled on this server",
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
  /** `BASE_URL`; its host is the apex a custom domain may not be (B5). */
  baseUrl?: string;
  /** TXT lookups for custom-domain verification (B5). */
  dns?: DnsResolver;
  /** Certificates for custom domains (B5). */
  provisioner?: CustomHostnameProvisioner;
  /**
   * Where a customer points their CNAME: `SITE_FALLBACK_ORIGIN` if the
   * platform has one (Cloudflare for SaaS does), otherwise the apex.
   */
  fallbackOrigin?: string;
}

/** The CNAME target a custom domain is told to point at (B5). */
export function cnameTarget(deps: SiteHostDeps): string {
  return deps.fallbackOrigin || apexHost(deps.baseUrl ?? "") || "";
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

  // The two kinds are validated by different rule sets: a label under our own
  // suffix is ours to reserve words in (B2), a domain the customer owns is not
  // (B5). Both produce the full host the row is keyed by.
  let hostname: string;
  if (kind === "custom") {
    const custom = validateCustomHostname(params.hostname, {
      suffix: deps.suffix,
      apexHost: apexHost(deps.baseUrl ?? "") ?? undefined,
    });
    if (!custom.ok) return { ok: false, status: 400, error: custom.error };
    hostname = custom.hostname;
  } else {
    const check = validateSiteName(toSiteName(params.hostname, deps.suffix));
    if (!check.ok) return { ok: false, status: 400, error: check.error };
    hostname = `${check.name}${deps.suffix}`;
  }

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
    // A `subdomain` is verified by construction — it is under a suffix we
    // control. A `custom` row starts unverified and does not resolve until its
    // TXT record is found (B5).
    verifiedAt: null,
    verificationToken: kind === "custom" ? newVerificationToken() : null,
    certificateStatus: null,
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
  | { ok: false; status: 400 | 404 | 409; error: string };

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
  // B5: `v{n}--name` has no meaning on a domain the customer owns — the label
  // is theirs, not ours to prefix. Silently ignoring the flag would leave the
  // API claiming previews are on for hosts that will never answer.
  if (params.previews === true && existing.kind === "custom") {
    return { ok: false, status: 400, error: CUSTOM_HOST_ERRORS.previews };
  }

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
  // B5: give the certificate up too. Best effort — the name is released
  // either way, and a certificate for a hostname that no longer resolves here
  // is the provider's problem to expire, not a reason to fail the release.
  if (existing.kind === "custom" && existing.verifiedAt !== null) {
    await deprovision(deps, hostname);
  }

  // ADR-007: emit site_host.released here — there is no event store in core yet.

  return { ok: true };
}

async function deprovision(deps: SiteHostDeps, hostname: string): Promise<void> {
  if (!deps.provisioner) return;
  try {
    await deps.provisioner.deprovision(hostname);
  } catch (e) {
    console.warn(
      `Deprovisioning the certificate for ${hostname} failed:`,
      e instanceof Error ? e.message : e,
    );
  }
}

// --- Custom domains: verification (ADR-013 B5) ---

export type VerifyResult =
  | { ok: true; host: SiteHost }
  | { ok: false; status: 400 | 404 | 409 | 429; error: string };

export interface VerifyParams {
  assetId: string;
  hostname: string;
  now?: number;
}

/**
 * Check the customer's `TXT _reearth-serve-verify.{hostname}` record and, if
 * it carries this row's token, verify the row and start certificate issuance.
 *
 * Verification is idempotent: an already-verified row is a `200` that refreshes
 * the certificate status rather than an error, because the customer's natural
 * reaction to "is it live yet?" is to run verify again.
 */
export async function verifySiteHost(deps: SiteHostDeps, params: VerifyParams): Promise<VerifyResult> {
  const now = params.now ?? Date.now();
  const hostname = toFullHost(params.hostname, deps.suffix);

  const existing = await deps.hosts.find(hostname);
  if (!existing || existing.releasedAt !== null || existing.assetId !== params.assetId) {
    return { ok: false, status: 404, error: "Host not found" };
  }
  // Nothing to verify about a name under our own suffix, and answering 200
  // would suggest there had been.
  if (existing.kind !== "custom") {
    return { ok: false, status: 400, error: CUSTOM_HOST_ERRORS.notCustom };
  }

  // A DNS lookup per request is a free amplifier otherwise: the endpoint is
  // authenticated, but one member can still point it at a resolver in a loop.
  if (!await takeVerifyAttempt(deps.cache, hostname, VERIFY_ATTEMPT_LIMIT)) {
    return { ok: false, status: 429, error: CUSTOM_HOST_ERRORS.rateLimited };
  }

  if (existing.verifiedAt !== null) {
    return { ok: true, host: await refreshCertificateStatus(deps, existing) };
  }

  const expected = verificationRecordValue(existing.verificationToken ?? "");
  const records = deps.dns
    ? await deps.dns.lookupTxt(verificationRecordName(hostname))
    : [];
  // Resolvers hand back every TXT record at the name, and a domain usually has
  // several (SPF, other vendors' proofs); one match is the proof.
  if (!records.some((record) => record.trim() === expected)) {
    return { ok: false, status: 409, error: CUSTOM_HOST_ERRORS.unverified };
  }

  const certificateStatus = await provisionCertificate(deps, hostname);
  await deps.hosts.update(hostname, { verifiedAt: now, certificateStatus });
  // The resolver caches the unverified row as a miss, so the host would stay
  // 404 for up to a minute without this.
  await dropCache(deps.cache, [hostname]);

  // ADR-007: emit site_host.verified here — there is no event store in core yet.

  return { ok: true, host: { ...existing, verifiedAt: now, certificateStatus } };
}

/**
 * Ask the provisioner where issuance got to and write the answer back, for a
 * row whose certificate is not active yet. Cheap (one provider call) and it is
 * what turns "pending" into "active" without the operator doing anything.
 */
export async function refreshCertificateStatus(
  deps: SiteHostDeps,
  host: SiteHost,
): Promise<SiteHost> {
  if (!deps.provisioner || host.kind !== "custom" || host.verifiedAt === null) return host;
  if (host.certificateStatus === "active") return host;

  let status: string;
  try {
    status = (await deps.provisioner.status(host.hostname)).status;
  } catch (e) {
    // The row is the customer's, not the provider's; a provider outage must
    // not turn a GET into a 500.
    console.warn(
      `Reading the certificate status of ${host.hostname} failed:`,
      e instanceof Error ? e.message : e,
    );
    return host;
  }
  if (status === host.certificateStatus) return host;

  await deps.hosts.update(host.hostname, { certificateStatus: status });
  return { ...host, certificateStatus: status };
}

async function provisionCertificate(deps: SiteHostDeps, hostname: string): Promise<string | null> {
  if (!deps.provisioner) return null;
  try {
    return (await deps.provisioner.provision(hostname)).status;
  } catch (e) {
    // The TXT check is what verification means; a certificate that failed to
    // start is "pending" and the single-row GET will retry the status.
    console.warn(
      `Provisioning a certificate for ${hostname} failed:`,
      e instanceof Error ? e.message : e,
    );
    return "pending";
  }
}

/**
 * A fixed-window counter over the `KeyValue` port: `limit` attempts per
 * hostname per hour. Deliberately minimal — it is a brake on a loop, not a
 * defence against a distributed attacker, and the port has no atomic increment
 * to build anything stronger on (ADR-012 §2).
 */
async function takeVerifyAttempt(
  cache: KeyValue | undefined,
  hostname: string,
  limit: number,
): Promise<boolean> {
  if (!cache) return true;
  const key = `verify-attempts:${hostname}`;
  try {
    const used = parseInt(await cache.get(key) ?? "", 10);
    const count = Number.isFinite(used) ? used : 0;
    if (count >= limit) return false;
    await cache.put(key, String(count + 1), { ttlSeconds: VERIFY_ATTEMPT_WINDOW_SECONDS });
    return true;
  } catch {
    // A cache that is down must not lock verification out entirely.
    return true;
  }
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

/**
 * One row of an asset (ADR-013 B5's single-row GET).
 *
 * Released rows are a `404` here as they are everywhere else on the asset's
 * routes: the row's asset is null, so it is not this asset's any more.
 */
export async function getAssetSiteHost(
  deps: SiteHostDeps,
  params: { assetId: string; hostname: string },
): Promise<SiteHost | null> {
  const hostname = toFullHost(params.hostname, deps.suffix);
  const host = await deps.hosts.find(hostname);
  if (!host || host.releasedAt !== null || host.assetId !== params.assetId) return null;
  return host;
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
