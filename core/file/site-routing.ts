/**
 * Applying a version's `_headers` / `_redirects` to one request (ADR-013 C3).
 *
 * The rules themselves are parsed once at extraction time (`core/site/rules.ts`,
 * `core/site/hosting.ts`); everything here is the per-request half, kept out of
 * `handler.ts` so the delivery path reads as delivery.
 *
 * **Handler wins.** Rule headers are applied to a response the moment it is
 * built, *before* the handler sets `X-Robots-Tag`, `Vary` and the CORS headers,
 * so anything the handler decides overwrites a rule that tried to decide it
 * too. The parser's denylist covers the headers already on the response by
 * then (`Cache-Control`, `ETag`, `Content-Type`, …), so the two halves of the
 * rule meet without either checking the other.
 */

import { ENTRY_CACHE_CONTROL } from "./caching";
import { matchHeaders, matchRedirect, type RedirectMatch, type SiteHosting } from "../site/rules";

/** The request path a rule matches against: always rooted, never empty. */
export function rulePath(filePath: string): string {
  return `/${filePath}`;
}

/** The file path a rewrite target names, with the leading slash taken off. */
export function targetFilePath(to: string): string {
  return to.replace(/^\//, "");
}

/**
 * The redirect or rewrite that applies, or null.
 *
 * `force` decides *when* the rule is consulted, not what it does: forced rules
 * run before the lookup (they may shadow a real file), plain ones only after it
 * has missed. That is Netlify's shadowing semantics, and it is what lets a
 * `/* /index.html 200` rule sit in a site that also serves real files.
 */
export function siteRedirect(
  hosting: SiteHosting,
  filePath: string,
  phase: "force" | "fallback",
): RedirectMatch | null {
  const rules = hosting.redirects.filter((r) => r.force === (phase === "force"));
  if (rules.length === 0) return null;
  return matchRedirect(rules, rulePath(filePath));
}

/**
 * A 3xx response for a matched rule.
 *
 * The `Location` is a path on the same origin, built under `/files/{id}` so the
 * site middleware's `unrewriteLocation` strips the prefix back off on a site
 * host, exactly as it does for A1's directory redirect. The query string
 * survives, because a rule moves a page and not its parameters.
 *
 * Permanent moves (301/308) take the moving-HTML policy: they are worth
 * caching, but a redeploy must be able to take them back. Temporary ones
 * (302/307) say they may change at any moment, so they are `no-store`. A
 * protected asset is `no-store` either way — a shared cache holding "where this
 * path went" is still information about a site behind a password.
 */
export function siteRedirectResponse(
  match: RedirectMatch,
  opts: { assetId: string; requestUrl: string; protected: boolean },
): Response {
  const url = new URL(opts.requestUrl);
  const location = `/files/${opts.assetId}${match.to}${url.search}`;
  const cacheControl = opts.protected || match.status === 302 || match.status === 307
    ? "no-store"
    : ENTRY_CACHE_CONTROL;
  return new Response(null, {
    status: match.status,
    headers: { Location: location, "Cache-Control": cacheControl },
  });
}

/**
 * Put the matching `_headers` rules on a response.
 *
 * Called immediately after the response is built and before the handler adds
 * anything of its own — see the module comment. The path is the one the
 * visitor asked for (after a 200 rewrite, the rewritten one), not the file that
 * ended up being read: a rule written for `/about` must apply when `/about` is
 * answered by the SPA shell or by `404.html`.
 */
export function applySiteHeaders(
  res: Response,
  hosting: SiteHosting | null,
  filePath: string,
): Response {
  if (!hosting || hosting.headers.length === 0) return res;
  for (const [name, value] of Object.entries(matchHeaders(hosting.headers, rulePath(filePath)))) {
    res.headers.set(name, value);
  }
  return res;
}
