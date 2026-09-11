/**
 * The composed site-host resolver (ADR-013 B6).
 *
 * The order is fixed and cheapest-first:
 *
 *   1. `^[0-9a-f]{16}$` → an asset or version ID (B1). No I/O at all; this is
 *      why B2 forbids ID-shaped names.
 *   2. the label contains `--` → a preview host (B4): `v{n}` or `latest` on
 *      the left, a name on the right, and the name's row must have `previews`
 *      on.
 *   3. otherwise → one `site_hosts` read on `{label}{suffix}` (B2/B5), in
 *      front of which sits a short-TTL `KeyValue` cache.
 *
 * The middleware keeps no branch per host kind: everything above is expressed
 * as `SiteTarget | null`.
 */

import type { KeyValue } from "../kv/port";
import { ID_LABEL } from "./names";
import type { VersionStore } from "../asset/repository";
import type { SiteHostResolver, SiteTarget } from "./middleware";
import type { SiteHostStore } from "./repository";

/** How long a resolution may be served from cache. */
export const HOST_CACHE_TTL_SECONDS = 60;

export function hostCacheKey(hostname: string): string {
  return `host:${hostname}`;
}

/**
 * The cached form of a resolution, including the miss (so a 404 is cheap too).
 *
 * `previews` rides along on the `asset` case because a name and its preview
 * hosts share one row and therefore one cache entry: `v3--name` costs no extra
 * read, and the PATCH that turns previews on drops the one key that both
 * forms are answered from.
 */
type CachedResolution =
  | { t: "asset"; id: string; previews: boolean }
  | { t: "disabled" }
  | { t: "gone" }
  | { t: "miss" };

/**
 * The left side of a preview label: `latest`, or `v` and a version number with
 * no leading zeros. `v0` is not a version (ADR-005 numbers from 1) and `v01`
 * is a second spelling of `v1` — two hostnames for one page, so both are 404.
 */
const PREVIEW_VERSION = /^v([1-9][0-9]*)$/;

export interface ComposedResolverDeps {
  hosts: SiteHostStore;
  /** Version lookups for `v{n}--` and `latest--` (B4). */
  versions: VersionStore;
  /** Short-TTL cache in front of the table. Invalidated on claim and release. */
  cache?: KeyValue;
  /** Already-normalised `SITE_HOST_SUFFIX`; needed to rebuild the full host. */
  suffix: string;
}

export function composeSiteHostResolver(deps: ComposedResolverDeps): SiteHostResolver {
  return async (label) => {
    // 1. ID host — no table read, no cache read.
    if (ID_LABEL.test(label)) return { kind: "asset", id: label };

    // 2. Preview host (B4). The split is on the FIRST `--`; names may not
    //    contain one (B2), so it is unambiguous. This branch never falls
    //    through to step 3 — otherwise `v3--name` would serve the production
    //    site whenever the left side were unreadable.
    const separator = label.indexOf("--");
    if (separator !== -1) {
      return resolvePreview(deps, label.slice(0, separator), label.slice(separator + 2));
    }

    // 3. Named site.
    return resolveNamed(deps, `${label}${deps.suffix}`);
  };
}

/**
 * `v{n}--name` and `latest--name` (ADR-013 B4).
 *
 * The left side is checked first because it costs nothing: a label whose left
 * side is not a version is not a preview host at all, and answering 404 before
 * any I/O keeps a made-up left side from probing the table. The name's own
 * state then decides — a disabled name's previews are down with it, and a
 * released name's are gone with it.
 */
async function resolvePreview(
  deps: ComposedResolverDeps,
  left: string,
  name: string,
): Promise<SiteTarget | null> {
  const match = PREVIEW_VERSION.exec(left);
  if (!match && left !== "latest") return null;

  const resolution = await resolveRow(deps, `${name}${deps.suffix}`);
  if (resolution.t !== "asset") return fromCached(resolution);
  // Off by default (B4): with previews on, sequential version numbers show a
  // public site's history to anyone who guesses. A name whose owner has not
  // asked for them has no preview hosts, and 404 is what "no such host" means.
  if (!resolution.previews) return null;

  const version = match
    ? await deps.versions.findByAssetAndNumber(resolution.id, Number(match[1]))
    : await deps.versions.findLatest(resolution.id);
  if (!version) return null;

  // Resolved to the version ID either way, so the file handler serves those
  // exact bytes. `pinned` may cache them forever; `latest` may not — the host
  // follows the asset and moves on the next upload.
  return { kind: "asset", id: version.id, preview: match ? "pinned" : "latest" };
}

async function resolveNamed(deps: ComposedResolverDeps, hostname: string): Promise<SiteTarget | null> {
  return fromCached(await resolveRow(deps, hostname));
}

/** One `site_hosts` row's resolution, from the cache when it is there. */
async function resolveRow(deps: ComposedResolverDeps, hostname: string): Promise<CachedResolution> {
  const key = hostCacheKey(hostname);

  const cached = await readCache(deps.cache, key);
  if (cached) return cached;

  const row = await deps.hosts.find(hostname);
  const resolution: CachedResolution = !row
    ? { t: "miss" }
    // A released row holds the name for its cooldown and must answer 410, not
    // 404: a stale link should say the site is gone, not that the name is free
    // (ADR-013 B3).
    : row.releasedAt !== null || row.assetId === null
      ? { t: "gone" }
      // Disabled is held-but-not-serving: 503, not 404, so it does not read as
      // an unclaimed name (ADR-013 B3).
      : row.disabledAt !== null
        ? { t: "disabled" }
        // `kind` is folded into `previews` rather than cached separately:
        // `v{n}--` has no meaning on a customer's own domain (B5), so a
        // `custom` row never has preview hosts whatever its flag says.
        : { t: "asset", id: row.assetId, previews: row.kind === "subdomain" && row.previews };

  await writeCache(deps.cache, key, resolution);
  return resolution;
}

function fromCached(resolution: CachedResolution): SiteTarget | null {
  if (resolution.t === "asset") return { kind: "asset", id: resolution.id };
  if (resolution.t === "disabled") return { kind: "disabled" };
  if (resolution.t === "gone") return { kind: "gone" };
  return null;
}

async function readCache(cache: KeyValue | undefined, key: string): Promise<CachedResolution | null> {
  if (!cache) return null;
  try {
    const raw = await cache.get(key);
    return raw ? (JSON.parse(raw) as CachedResolution) : null;
  } catch {
    // A cache that is down or holding junk must never take the site down with
    // it; fall through to the table.
    return null;
  }
}

async function writeCache(cache: KeyValue | undefined, key: string, value: CachedResolution): Promise<void> {
  if (!cache) return;
  try {
    await cache.put(key, JSON.stringify(value), { ttlSeconds: HOST_CACHE_TTL_SECONDS });
  } catch {
    // Same reasoning as above: caching is an optimisation, not a dependency.
  }
}
