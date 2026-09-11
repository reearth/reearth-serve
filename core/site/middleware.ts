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
 * - `asset` — serve this ID through the file router. `preview` says the host
 *   was a `v{n}--` / `latest--` one (B4) and decides the cache policy the file
 *   handler applies to it:
 *   - absent — the ID host or the bare name: the handler decides on its own
 *     (a version ID is pinned, an asset ID follows the asset).
 *   - `"pinned"` — `v{n}--`: `id` is a version ID and never moves.
 *   - `"latest"` — `latest--`: `id` is a version ID too, but the host follows
 *     the asset, so the response must stay revalidatable even though it names
 *     one version. Both forms are `noindex`.
 * - `disabled` — the name is claimed and held but its owner has taken the site
 *   down (B3): `503`, because "exists, not serving" is the true answer.
 * - `gone` — the name is held by a released row inside its cooldown (B3): the
 *   site is gone, and saying so is not the same as saying the name is free.
 *
 * A `null` resolution is the fourth case (miss) and stays outside the union so
 * a resolver can express it without constructing anything.
 */
export type SitePreview = "pinned" | "latest";

export type SiteTarget =
  | { kind: "asset"; id: string; preview?: SitePreview }
  | { kind: "disabled" }
  | { kind: "gone" };

/**
 * How the middleware tells the file router that a request came from a preview
 * host (ADR-013 B4). The rewritten request is a new `Request` dispatched into
 * a separate Hono app, so there is no context to carry it on.
 *
 * The middleware always deletes the header before setting it: it copies the
 * visitor's headers onto the rewritten request, and a visitor who sent this
 * one themselves would otherwise choose their own cache policy.
 */
export const SITE_PREVIEW_HEADER = "x-reearth-site-preview";

/**
 * What the middleware hands the resolver.
 *
 * Two forms, because the two kinds of site host are recognised differently:
 * a `subdomain` is known by its leading label under `SITE_HOST_SUFFIX` and
 * needs the suffix put back on to reach its row, while a `custom` host (B5) is
 * the row's key already — there is no label to take off it. Making the
 * distinction part of the query keeps the resolver from having to guess which
 * of the two a string is.
 */
export type SiteHostQuery =
  | { form: "label"; label: string }
  | { form: "custom"; hostname: string };

/** Resolves a site host, or null for 404. */
export type SiteHostResolver = (query: SiteHostQuery) => Promise<SiteTarget | null>;

/** Asset and version IDs: 16 lowercase hex characters, valid DNS labels as-is. */
const ID_LABEL = /^[0-9a-f]{16}$/;

/**
 * B1's resolver: the label must be an asset or version ID. Anything else is a
 * miss — a name is not a thing this part knows how to resolve (B2 does).
 */
export const resolveIdLabel: SiteHostResolver = async (query) =>
  query.form === "label" && ID_LABEL.test(query.label)
    ? { kind: "asset", id: query.label }
    : null;

export interface SiteHostOptions {
  /** `SITE_HOST_SUFFIX`, e.g. `.serve.reearth.land`. Undefined ⇒ feature off. */
  suffix: string | undefined;
  /**
   * `BASE_URL`. Its host is the apex — the one hostname that is never a site
   * (ADR-013 B5): the UI, the API, the docs and the health check live there,
   * and every *other* host is a candidate for a `site_hosts` lookup.
   */
  baseUrl: string;
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
 * Hostnames that are the management surface even though they are not the apex:
 * the loopback names a local run, a health probe or a unit test arrives on.
 * The port is ignored, so `localhost:8788` counts and `abc.localhost:8788`
 * (which is a site host under a `.localhost:8788` suffix) does not.
 */
const LOOPBACK_HOSTS: ReadonlySet<string> = new Set(["localhost", "127.0.0.1", "[::1]", "::1", "0.0.0.0"]);

/** The host part of `BASE_URL`, lowercased, port included. Null if unparseable. */
export function apexHost(baseUrl: string): string | null {
  try {
    return new URL(baseUrl).host.toLowerCase() || null;
  } catch {
    // A malformed BASE_URL is a deployment problem. Returning null means the
    // apex is unknown, which the caller reads as "nothing is the apex except
    // loopback" rather than "everything is".
    return null;
  }
}

/**
 * True when `host` is the management surface rather than a site (ADR-013 B5).
 *
 * B1–B4 could answer this from the suffix alone: a site host ended with it.
 * Custom domains cannot be recognised from the string at all — `map.city.
 * example.jp` looks like any other host — so the rule is inverted: the apex is
 * named, and everything else is a site host until a `site_hosts` lookup says
 * otherwise. Three hostnames are the apex:
 *
 * - the host of `BASE_URL`, where the UI, the API and the docs live;
 * - the suffix without its leading dot — the wildcard's own parent, which is
 *   usually the same host and must never be a site even when it is not;
 * - loopback, so a local run and the unit suite are not site hosts.
 */
export function isApexHost(
  host: string | null | undefined,
  baseUrl: string,
  suffix: string | undefined,
): boolean {
  const lower = (host ?? "").trim().toLowerCase();
  // No Host header at all is not a site request; the app answers it as before.
  if (!lower) return true;
  if (LOOPBACK_HOSTS.has(lower.replace(/:\d+$/, ""))) return true;
  if (suffix && lower === suffix.replace(/^\./, "")) return true;
  return lower === apexHost(baseUrl);
}

/**
 * True when the whole request belongs to the app rather than to the UI / API
 * split, i.e. when `host` is a site host.
 *
 * For runtime entrypoints that route by path *before* the app sees the request
 * (the Node runtime's API-only guard, the Worker's React Router fallback): on
 * a site host every path belongs to the app, including `/`, or the UI and the
 * operational endpoints would answer there — exactly what ADR-013 B1's
 * "nothing but the site on a site host" forbids.
 *
 * Since B5 the test is "not the apex" rather than "ends with the suffix": a
 * custom domain cannot be recognised without a table read, and the read lives
 * in the middleware, so the entrypoint has to hand every non-apex host to the
 * app and let the middleware decide. A host with no row falls through to the
 * middleware's own plain-text 404 — it never reaches the UI, which is the
 * point: an unknown hostname pointed at us must not serve the dashboard.
 *
 * With no suffix configured the feature is off and the old path-based split
 * applies unchanged, so a deployment that serves its UI on a second hostname
 * is not broken by enabling nothing.
 */
export function isSiteHost(
  host: string | null | undefined,
  opts: { baseUrl: string; suffix: string | undefined },
): boolean {
  const normalized = normalizeSiteHostSuffix(opts.suffix);
  if (!normalized) return false;
  return !isApexHost(host, opts.baseUrl, normalized);
}

export function siteHostMiddleware(opts: SiteHostOptions): MiddlewareHandler<AppEnv> {
  const suffix = normalizeSiteHostSuffix(opts.suffix);
  const resolve = opts.resolve ?? resolveIdLabel;

  return async (c, next) => {
    if (!suffix) return next();

    const host = (c.req.header("Host") ?? "").trim().toLowerCase();
    const label = siteHostLabel(host, suffix);
    // Order matters: the suffix branch is tried first so that a dev deployment
    // whose suffix is `.localhost:8788` still resolves `abc.localhost:8788`
    // before the loopback rule in `isApexHost` could claim it.
    const query: SiteHostQuery | null = label !== null
      ? { form: "label", label }
      : isApexHost(host, opts.baseUrl, suffix)
        ? null
        // B5: anything else is a custom domain until the table says otherwise.
        : { form: "custom", hostname: host };
    if (!query) return next();

    const target = await resolve(query);
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
    if (target.kind === "disabled") return disabledResponse();
    if (target.kind === "gone") return goneResponse();

    const url = new URL(c.req.url);
    const prefix = `/files/${target.id}`;
    // `pathname` starts with "/" and is already percent-encoded; the query
    // string rides along untouched.
    url.pathname = `${prefix}${url.pathname}`;

    const headers = new Headers(c.req.raw.headers);
    headers.delete(SITE_PREVIEW_HEADER);
    if (target.preview) headers.set(SITE_PREVIEW_HEADER, target.preview);

    const rewritten = await rewriteRequest(c.req.raw, url, headers);
    if (!rewritten) return tooLargeResponse();
    const res = await opts.serve(rewritten);

    return unrewriteLocation(res, prefix);
  };
}

/**
 * The largest body the rewrite will carry, in bytes.
 *
 * The only `POST` a site host has is the password form (ADR-013 B7), which is a
 * few hundred bytes. The body is buffered rather than streamed because a
 * duplex request body is not portable across the two runtimes, and buffering
 * only makes sense with a bound on it — otherwise a visitor could make the
 * process hold an arbitrarily large upload for a route that does not exist.
 */
const MAX_REWRITTEN_BODY_BYTES = 64 * 1024;

/**
 * Build the request the file-only router is asked to serve.
 *
 * `GET`/`HEAD` have no body. Anything else is buffered, so the form endpoint
 * can read it; a body over the cap yields null, which the caller turns into a
 * `413`.
 */
async function rewriteRequest(
  original: Request,
  url: URL,
  headers: Headers,
): Promise<Request | null> {
  const method = original.method;
  if (method === "GET" || method === "HEAD") {
    return new Request(url, { method, headers });
  }
  const declared = Number.parseInt(original.headers.get("Content-Length") ?? "", 10);
  if (Number.isFinite(declared) && declared > MAX_REWRITTEN_BODY_BYTES) return null;

  const body = await original.arrayBuffer();
  if (body.byteLength > MAX_REWRITTEN_BODY_BYTES) return null;
  return new Request(url, { method, headers, body });
}

function tooLargeResponse(): Response {
  return new Response("Payload too large", {
    status: 413,
    headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" },
  });
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

/**
 * The disabled-site page (ADR-013 B3).
 *
 * `503`, not `404`: the name is claimed and held, and "exists, not serving" is
 * both true and not an invitation to claim it. `no-store` because the site
 * comes back the moment its owner enables it again, `noindex` so the outage
 * does not replace the site in a search index, and `Retry-After` so a crawler
 * that honours it comes back in an hour instead of hammering the host.
 */
export function disabledResponse(): Response {
  return new Response(DISABLED_PAGE, {
    status: 503,
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store",
      "X-Robots-Tag": "noindex",
      "Retry-After": "3600",
    },
  });
}

const DISABLED_PAGE =
  '<!doctype html><meta charset="utf-8"><title>This site is temporarily unavailable</title>' +
  "<h1>This site is temporarily unavailable</h1>";

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
    const id = (label: string) => resolveIdLabel({ form: "label", label });
    expect(await id("3f9a1c2b4d5e6f70")).toEqual({ kind: "asset", id: "3f9a1c2b4d5e6f70" });
    expect(await id("3F9A1C2B4D5E6F70")).toBeNull();
    expect(await id("kawasaki-flood-map")).toBeNull();
    expect(await id("3f9a1c2b4d5e6f7")).toBeNull();
    // B1's resolver knows nothing about custom domains.
    expect(await resolveIdLabel({ form: "custom", hostname: "map.city.example.jp" })).toBeNull();
  });

  test("apexHost is the host of BASE_URL, port included", () => {
    expect(apexHost("https://serve.reearth.land")).toBe("serve.reearth.land");
    expect(apexHost("http://localhost:8788/base")).toBe("localhost:8788");
    expect(apexHost("not a url")).toBeNull();
  });

  test("isApexHost names the management surface and nothing else", () => {
    const base = "https://serve.reearth.land";
    const suffix = ".serve.reearth.land";
    expect(isApexHost("serve.reearth.land", base, suffix)).toBe(true);
    // The wildcard's parent, even when BASE_URL points somewhere else.
    expect(isApexHost("serve.reearth.land", "https://api.reearth.land", suffix)).toBe(true);
    expect(isApexHost("", base, suffix)).toBe(true);
    expect(isApexHost(undefined, base, suffix)).toBe(true);
    expect(isApexHost("localhost", base, suffix)).toBe(true);
    expect(isApexHost("localhost:8788", base, suffix)).toBe(true);
    expect(isApexHost("127.0.0.1:5173", base, suffix)).toBe(true);

    expect(isApexHost("kawasaki.serve.reearth.land", base, suffix)).toBe(false);
    expect(isApexHost("map.city.example.jp", base, suffix)).toBe(false);
    // A site host under a loopback suffix is still a site host.
    expect(isApexHost("abc.localhost:8788", "http://localhost:8788", ".localhost:8788")).toBe(false);
  });

  test("isSiteHost is 'not the apex', and is off without a suffix", () => {
    const opts = { baseUrl: "https://serve.reearth.land", suffix: ".serve.reearth.land" };
    expect(isSiteHost("kawasaki.serve.reearth.land", opts)).toBe(true);
    // B5: a custom domain is a site host although it ends with nothing of ours.
    expect(isSiteHost("map.city.example.jp", opts)).toBe(true);
    expect(isSiteHost("serve.reearth.land", opts)).toBe(false);
    expect(isSiteHost("localhost:8788", opts)).toBe(false);
    expect(isSiteHost("map.city.example.jp", { ...opts, suffix: undefined })).toBe(false);
  });
}
