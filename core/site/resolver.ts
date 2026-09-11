/**
 * The composed site-host resolver (ADR-013 B6).
 *
 * The order is fixed and cheapest-first:
 *
 *   1. `^[0-9a-f]{16}$` → an asset or version ID (B1). No I/O at all; this is
 *      why B2 forbids ID-shaped names.
 *   2. the label contains `--` → a preview host (B4). Not implemented yet, so
 *      it is a miss; see the seam below.
 *   3. otherwise → one `site_hosts` read on `{label}{suffix}` (B2/B5), in
 *      front of which sits a short-TTL `KeyValue` cache.
 *
 * The middleware keeps no branch per host kind: everything above is expressed
 * as `SiteTarget | null`.
 */

import type { KeyValue } from "../kv/port";
import { ID_LABEL } from "./names";
import type { SiteHostResolver, SiteTarget } from "./middleware";
import type { SiteHostStore } from "./repository";

/** How long a resolution may be served from cache. */
export const HOST_CACHE_TTL_SECONDS = 60;

export function hostCacheKey(hostname: string): string {
  return `host:${hostname}`;
}

/** The cached form of a resolution, including the miss (so a 404 is cheap too). */
type CachedResolution =
  | { t: "asset"; id: string }
  | { t: "disabled" }
  | { t: "gone" }
  | { t: "miss" };

export interface ComposedResolverDeps {
  hosts: SiteHostStore;
  /** Short-TTL cache in front of the table. Invalidated on claim and release. */
  cache?: KeyValue;
  /** Already-normalised `SITE_HOST_SUFFIX`; needed to rebuild the full host. */
  suffix: string;
}

export function composeSiteHostResolver(deps: ComposedResolverDeps): SiteHostResolver {
  return async (label) => {
    // 1. ID host — no table read, no cache read.
    if (ID_LABEL.test(label)) return { kind: "asset", id: label };

    // 2. Preview host (B4). ADR-013 B4 will split on the first `--`, require
    //    the right side to be a `subdomain` row with `previews` on, and read
    //    `v{n}` or `latest` off the left. Until then a `--` label resolves to
    //    nothing, which the middleware answers as a 404 — the same answer an
    //    unclaimed name gets, and never someone else's site.
    if (label.includes("--")) return null;

    // 3. Named site.
    return resolveNamed(deps, `${label}${deps.suffix}`);
  };
}

async function resolveNamed(deps: ComposedResolverDeps, hostname: string): Promise<SiteTarget | null> {
  const key = hostCacheKey(hostname);

  const cached = await readCache(deps.cache, key);
  if (cached) return fromCached(cached);

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
        : { t: "asset", id: row.assetId };

  await writeCache(deps.cache, key, resolution);
  return fromCached(resolution);
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
