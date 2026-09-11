import type { MiddlewareHandler } from "hono";
import type { AppEnv } from "../types";

/**
 * Site hosts: one hostname per asset (ADR-013 B1).
 *
 * A request to `{label}{SITE_HOST_SUFFIX}` is served exactly as
 * `GET /files/{id}{path}` on the apex, and *nothing else* is reachable on
 * that hostname: the middleware answers every path from the file router, so
 * the API, the docs and the health endpoint stay on the apex. Without that
 * rule a hosted page would run same-origin with the management surface and
 * the per-asset origin would be cosmetic.
 *
 * B1 resolved ID-shaped labels only. B2 (named sites) adds the `site_hosts`
 * lookup and B6 fixes the order: ID shape first, then `--` previews, then the
 * table — all of it inside `SiteHostResolver` (see `./resolver.ts`), so the
 * middleware itself never grows a branch per host kind.
 */

/**
 * What a site host resolved to.
 *
 * - `asset` — serve this ID through the file router.
 * - `gone` — the name is held by a released row inside its cooldown (B3): the
 *   site is gone, and saying so is not the same as saying the name is free.
 *
 * A `null` resolution is the third case (miss) and stays outside the union so
 * a resolver can express it without constructing anything.
 */
export type SiteTarget =
  | { kind: "asset"; id: string }
  | { kind: "gone" };

/** Resolves a host's leading label, or null for 404. */
export type SiteHostResolver = (label: string) => Promise<SiteTarget | null>;

/** Asset and version IDs: 16 lowercase hex characters, valid DNS labels as-is. */
const ID_LABEL = /^[0-9a-f]{16}$/;

/**
 * B1's resolver: the label must be an asset or version ID. Anything else is a
 * miss — a name is not a thing this part knows how to resolve (B2 does).
 */
export const resolveIdLabel: SiteHostResolver = async (label) =>
  ID_LABEL.test(label) ? { kind: "asset", id: label } : null;

export interface SiteHostOptions {
  /** `SITE_HOST_SUFFIX`, e.g. `.serve.reearth.land`. Undefined ⇒ feature off. */
  suffix: string | undefined;
  /**
   * Dispatches the rewritten request. Must route *only* file delivery: it is
   * what guarantees that no API route can match on a site host.
   */
  serve: (req: Request) => Response | Promise<Response>;
  /** Defaults to {@link resolveIdLabel}; B2 passes a table-backed resolver. */
  resolve?: SiteHostResolver;
}

/**
 * Normalise and validate `SITE_HOST_SUFFIX`.
 *
 * The suffix is compared against the `Host` header verbatim, so it carries
 * the port in local development (`.localhost:8787`). It must start with a
 * dot: without one, `notserve.reearth.land` would match a suffix of
 * `serve.reearth.land` and every unrelated host would turn into a file
 * lookup. Fails loudly at composition time rather than silently disabling
 * the feature.
 */
export function normalizeSiteHostSuffix(value: string | undefined): string | undefined {
  const suffix = value?.trim().toLowerCase();
  if (!suffix) return undefined;
  if (!suffix.startsWith(".")) {
    throw new Error(`SITE_HOST_SUFFIX must start with "." (got "${value}")`);
  }
  return suffix;
}

/**
 * The leading label of `host` under `suffix`, or null when `host` is not a
 * site host. A label with a dot in it is not one either: the wildcard
 * certificate covers a single level (ADR-013 B1), so `a.b.serve…` cannot be
 * served and must not be mistaken for `a.b`.
 */
export function siteHostLabel(host: string, suffix: string): string | null {
  const lower = host.trim().toLowerCase();
  if (!lower.endsWith(suffix)) return null;
  const label = lower.slice(0, lower.length - suffix.length);
  if (label === "" || label.includes(".")) return null;
  return label;
}

/**
 * True when `host` is a site host under `suffix`.
 *
 * For runtime entrypoints that route by path *before* the app sees the request
 * (the Node runtime's API-only guard, the Worker's React Router fallback):
 * on a site host every path belongs to the app, including `/`, or the UI and
 * the operational endpoints would answer there — exactly what ADR-013 B1's
 * "nothing but the site on a site host" forbids.
 */
export function isSiteHost(host: string | null | undefined, suffix: string | undefined): boolean {
  const normalized = normalizeSiteHostSuffix(suffix);
  if (!normalized || !host) return false;
  return siteHostLabel(host, normalized) !== null;
}

export function siteHostMiddleware(opts: SiteHostOptions): MiddlewareHandler<AppEnv> {
  const suffix = normalizeSiteHostSuffix(opts.suffix);
  const resolve = opts.resolve ?? resolveIdLabel;

  return async (c, next) => {
    if (!suffix) return next();

    const label = siteHostLabel(c.req.header("Host") ?? "", suffix);
    if (label === null) return next();

    const target = await resolve(label);
    if (!target) {
      // Plain text, not the API's JSON error: on a site host there is no API,
      // and `no-store` keeps an unresolvable name from being cached as dead
      // (it becomes resolvable the moment someone claims it — B2).
      return new Response("Not found", {
        status: 404,
        headers: {
          "Content-Type": "text/plain; charset=utf-8",
          "Cache-Control": "no-store",
        },
      });
    }
    if (target.kind === "gone") return goneResponse();

    const url = new URL(c.req.url);
    const prefix = `/files/${target.id}`;
    // `pathname` starts with "/" and is already percent-encoded; the query
    // string rides along untouched.
    url.pathname = `${prefix}${url.pathname}`;

    // No body is carried over: only GET/HEAD reach the file router, and any
    // other method 404s there, so re-streaming a body would be for nothing.
    const res = await opts.serve(
      new Request(url, { method: c.req.raw.method, headers: c.req.raw.headers }),
    );

    return unrewriteLocation(res, prefix);
  };
}

/**
 * The released-name page (ADR-013 B3).
 *
 * `410`, not `404`: for the 30 days of the cooldown the name is still held, so
 * "gone" is the true answer and it does not invite a claim. `no-store` because
 * the page turns back into a site the moment the project re-points the name,
 * and `noindex` so a search engine does not keep the tombstone.
 */
export function goneResponse(): Response {
  return new Response(GONE_PAGE, {
    status: 410,
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store",
      "X-Robots-Tag": "noindex",
    },
  });
}

const GONE_PAGE =
  '<!doctype html><meta charset="utf-8"><title>This site has moved or been removed</title>' +
  "<h1>This site has moved or been removed</h1>";

/**
 * Undo the path rewrite in a `Location` header.
 *
 * The file handler's directory redirect (`/docs` → `/docs/`, ADR-013 A1) is
 * built from the URL it was given, which on a site host is the rewritten one.
 * Sent as-is it would point the visitor at `{id}.suffix/files/{id}/docs/`.
 */
function unrewriteLocation(res: Response, prefix: string): Response {
  const location = res.headers.get("Location");
  if (!location) return res;
  const target = new URL(location, "http://site.invalid");
  if (!target.pathname.startsWith(prefix)) return res;
  target.pathname = target.pathname.slice(prefix.length) || "/";
  res.headers.set("Location", location.startsWith("/") ? target.pathname + target.search : target.toString());
  return res;
}

if (import.meta.vitest) {
  const { test, expect } = import.meta.vitest;

  test("normalizeSiteHostSuffix lowercases and requires a leading dot", () => {
    expect(normalizeSiteHostSuffix(undefined)).toBeUndefined();
    expect(normalizeSiteHostSuffix("")).toBeUndefined();
    expect(normalizeSiteHostSuffix(".Serve.ReEarth.Land")).toBe(".serve.reearth.land");
    expect(normalizeSiteHostSuffix(".localhost:8787")).toBe(".localhost:8787");
    expect(() => normalizeSiteHostSuffix("serve.reearth.land")).toThrow(/must start with/);
  });

  test("siteHostLabel takes the single leading label, port included", () => {
    expect(siteHostLabel("abc.serve.reearth.land", ".serve.reearth.land")).toBe("abc");
    expect(siteHostLabel("ABC.Serve.ReEarth.Land", ".serve.reearth.land")).toBe("abc");
    expect(siteHostLabel("serve.reearth.land", ".serve.reearth.land")).toBeNull();
    expect(siteHostLabel("a.b.serve.reearth.land", ".serve.reearth.land")).toBeNull();
    expect(siteHostLabel("notserve.reearth.land", ".serve.reearth.land")).toBeNull();
    expect(siteHostLabel("abc.localhost:8787", ".localhost:8787")).toBe("abc");
    expect(siteHostLabel("localhost:8787", ".localhost:8787")).toBeNull();
  });

  test("resolveIdLabel accepts only 16 lowercase hex characters", async () => {
    expect(await resolveIdLabel("3f9a1c2b4d5e6f70")).toEqual({ kind: "asset", id: "3f9a1c2b4d5e6f70" });
    expect(await resolveIdLabel("3F9A1C2B4D5E6F70")).toBeNull();
    expect(await resolveIdLabel("kawasaki-flood-map")).toBeNull();
    expect(await resolveIdLabel("3f9a1c2b4d5e6f7")).toBeNull();
  });
}
