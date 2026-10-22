/**
 * `_headers` and `_redirects` — Netlify-style control files read from the root
 * of an extracted archive (ADR-013 C3).
 *
 * This module is **pure**: text in, rules out, plus a matcher for each kind.
 * Nothing here touches storage, the request or the clock — the two files are
 * read once, at extraction time, by `core/site/hosting.ts`, and the parsed
 * result is stored on the version (or the asset) as system metadata. The file
 * handler only ever matches against what is stored.
 *
 * Two rules shape everything below:
 *
 * 1. **The handler wins.** A rule may not set a header the delivery semantics
 *    own (`Cache-Control`, `ETag`, `Vary`, the CORS headers — A2/A3/B7) or one
 *    that would be a security footgun (`Set-Cookie`, `WWW-Authenticate`).
 *    Those names are refused here, at parse time, so the handler can apply
 *    rule headers *before* its own without checking anything.
 * 2. **Redirect targets stay inside the site.** Netlify allows a redirect to
 *    another origin because the name belongs to the site's owner either way.
 *    Here a site lives under `serve.reearth.land`, and letting an uploaded zip
 *    bounce visitors off that name is a phishing primitive. Targets must be
 *    rooted paths; external ones are refused with a warning. A deliberate
 *    limit, not an oversight.
 */

import type {
  SiteHeaderRule,
  SiteHosting,
  SiteRedirectRule,
} from "../../shared/api";

export type { SiteHeaderRule, SiteHosting, SiteRedirectRule };

// --- Limits (ADR-013 C3) ---------------------------------------------------

/** Either control file, in bytes. Past this the file is ignored entirely. */
export const MAX_CONTROL_FILE_BYTES = 64 * 1024;
export const MAX_HEADER_RULES = 100;
export const MAX_HEADERS_PER_RULE = 20;
export const MAX_HEADER_VALUE_BYTES = 2 * 1024;
export const MAX_REDIRECT_RULES = 500;

/** The statuses `_redirects` may ask for. `200` is a rewrite, not a redirect. */
export const REDIRECT_STATUSES = [200, 301, 302, 307, 308] as const;

/**
 * Headers a rule may never set.
 *
 * The first group is owned by delivery: A2 decides `Cache-Control`, A3 decides
 * `ETag` / `Last-Modified` / `Vary`, and the body framing headers describe
 * bytes the handler produced. `content-type` is on the list because the
 * extractor already assigned it from the entry's name (A4) and a rule that
 * disagreed would make the same bytes mean two things.
 *
 * The second group is security-relevant: CORS is decided per asset by B7
 * (`*` for public assets, an echoed `Origin` with credentials for protected
 * ones), and `Set-Cookie` / `WWW-Authenticate` from uploaded content would let
 * a site mint cookies on its own origin or stack a credential dialog on the
 * password page.
 *
 * `x-robots-tag` is deliberately **not** here: a production site may want its
 * own robots policy. A preview host still wins, because the handler sets
 * `noindex` after rule headers have been applied.
 */
const DENIED_HEADERS = new Set([
  "cache-control",
  "etag",
  "last-modified",
  "content-length",
  "content-encoding",
  "content-range",
  "content-type",
  "accept-ranges",
  "vary",
  "set-cookie",
  "www-authenticate",
]);

/** Prefix form of the denylist: the whole CORS family belongs to B7. */
const DENIED_HEADER_PREFIXES = ["access-control-"];

function isDeniedHeader(name: string): boolean {
  return DENIED_HEADERS.has(name) || DENIED_HEADER_PREFIXES.some((p) => name.startsWith(p));
}

// RFC 9110 token, lowercased.
const HEADER_NAME = /^[a-z0-9!#$%&'*+.^_`|~-]+$/;
// Anything a header value may not carry: CR, LF, NUL and the other controls.
const CONTROL_CHARS = /\p{Cc}/u;

// --- Results ---------------------------------------------------------------

export interface ParsedHeaders {
  rules: SiteHeaderRule[];
  warnings: string[];
}

export interface ParsedRedirects {
  rules: SiteRedirectRule[];
  warnings: string[];
}

/** What `matchRedirect` hands back: the target with substitutions applied. */
export interface RedirectMatch {
  to: string;
  status: number;
  force: boolean;
}

function byteLength(text: string): number {
  return new TextEncoder().encode(text).length;
}

function splitLines(text: string): string[] {
  // A BOM on the first line would make the pattern not start with "/".
  return text.replace(/^\uFEFF/, "").split(/\r?\n/);
}

// --- Pattern matching ------------------------------------------------------

/**
 * A path pattern: an exact path (`/about`), a trailing prefix wildcard
 * (`/blog/*`, `/*`), or `:placeholder` segments that match exactly one
 * segment each. `*` is only meaningful as the final segment.
 */
export interface PatternMatch {
  /** `:name` segments by name. */
  params: Record<string, string>;
  /** What a trailing `*` swallowed, with no leading slash. */
  splat: string;
}

export function matchPattern(pattern: string, path: string): PatternMatch | null {
  const p = pattern.split("/");
  const s = path.split("/");
  const params: Record<string, string> = {};

  for (let i = 0; i < p.length; i++) {
    const segment = p[i];
    if (segment === "*") {
      // A trailing `*` matches the rest, including nothing at all: `/blog/*`
      // covers `/blog/`, and `/*` covers `/`.
      return { params, splat: s.slice(i).join("/") };
    }
    if (i >= s.length) return null;
    if (segment.startsWith(":") && segment.length > 1) {
      // A placeholder stands for a segment, so it must not match an empty one:
      // `/users/:id` does not match `/users/`.
      if (s[i] === "") return null;
      params[segment.slice(1)] = s[i];
      continue;
    }
    if (segment !== s[i]) return null;
  }

  return s.length === p.length ? { params, splat: "" } : null;
}

/** True when `*` appears anywhere but as the last segment. */
function hasMisplacedSplat(pattern: string): boolean {
  const segments = pattern.split("/");
  return segments.some((seg, i) => seg.includes("*") && (seg !== "*" || i !== segments.length - 1));
}

// --- `_headers` ------------------------------------------------------------

/**
 * Parse `_headers`.
 *
 * ```
 * /*
 *   X-Frame-Options: DENY
 * /admin/*
 *   Content-Security-Policy: default-src 'self'
 * ```
 *
 * A non-indented line beginning with `/` opens a block; indented `Name: value`
 * lines belong to it. `#` starts a full-line comment; blank lines are skipped.
 *
 * Exceeding any *size* limit ignores the whole file (one warning says so) —
 * a truncated rule set is worse than none, because the author cannot tell
 * which half survived. A single bad or denied header only costs that header.
 */
export function parseHeaders(text: string): ParsedHeaders {
  const warnings: string[] = [];
  const ignore = (reason: string): ParsedHeaders => ({
    rules: [],
    warnings: [`_headers ignored: ${reason}`],
  });

  if (byteLength(text) > MAX_CONTROL_FILE_BYTES) {
    return ignore(`the file is larger than ${MAX_CONTROL_FILE_BYTES} bytes`);
  }

  const rules: SiteHeaderRule[] = [];
  let current: SiteHeaderRule | null = null;
  let currentCount = 0;

  const lines = splitLines(text);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trim();
    if (trimmed === "" || trimmed.startsWith("#")) continue;

    const indented = /^\s/.test(line);

    if (!indented) {
      if (!trimmed.startsWith("/")) {
        warnings.push(`_headers line ${i + 1}: a path pattern must start with "/" (got "${trimmed}")`);
        current = null;
        continue;
      }
      if (hasMisplacedSplat(trimmed)) {
        warnings.push(`_headers line ${i + 1}: "*" is only allowed as the last segment`);
        current = null;
        continue;
      }
      if (rules.length >= MAX_HEADER_RULES) {
        return ignore(`more than ${MAX_HEADER_RULES} rules`);
      }
      current = { pattern: trimmed, headers: {} };
      currentCount = 0;
      rules.push(current);
      continue;
    }

    if (!current) {
      warnings.push(`_headers line ${i + 1}: header outside any path block`);
      continue;
    }

    const colon = trimmed.indexOf(":");
    if (colon <= 0) {
      warnings.push(`_headers line ${i + 1}: expected "Name: value"`);
      continue;
    }
    const name = trimmed.slice(0, colon).trim().toLowerCase();
    const value = trimmed.slice(colon + 1).trim();

    if (!HEADER_NAME.test(name)) {
      warnings.push(`_headers line ${i + 1}: "${name}" is not a valid header name`);
      continue;
    }
    if (isDeniedHeader(name)) {
      warnings.push(`_headers line ${i + 1}: "${name}" cannot be set by a rule`);
      continue;
    }
    if (CONTROL_CHARS.test(value)) {
      warnings.push(`_headers line ${i + 1}: "${name}" has a control character in its value`);
      continue;
    }
    if (byteLength(value) > MAX_HEADER_VALUE_BYTES) {
      return ignore(`a header value is larger than ${MAX_HEADER_VALUE_BYTES} bytes`);
    }
    if (currentCount >= MAX_HEADERS_PER_RULE && current.headers[name] === undefined) {
      return ignore(`more than ${MAX_HEADERS_PER_RULE} headers on one rule`);
    }

    if (current.headers[name] === undefined) currentCount++;
    // The last mention of a name inside a block wins, as it does across blocks.
    current.headers[name] = value;
  }

  // A block with no usable headers would only cost bytes in storage.
  return { rules: rules.filter((r) => Object.keys(r.headers).length > 0), warnings };
}

/**
 * Every header the rules put on a response for `path`, lowercase-keyed.
 * Later rules override earlier ones for the same header, so a `/*` block at the
 * top is a default and a more specific block below it is an override.
 */
export function matchHeaders(rules: SiteHeaderRule[], path: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const rule of rules) {
    if (!matchPattern(rule.pattern, path)) continue;
    for (const [name, value] of Object.entries(rule.headers)) out[name] = value;
  }
  return out;
}

// --- `_redirects` ----------------------------------------------------------

/**
 * Parse `_redirects`.
 *
 * ```
 * /old-page   /new-page        301
 * /blog/*     /news/:splat     301!
 * /*          /index.html      200
 * ```
 *
 * `from to [status]`, one per line; `#` starts a comment; blank lines are
 * skipped. A `!` on the status (or on the target when no status is given)
 * makes the rule **forced**: it applies even when `from` names a file that
 * exists. Without it the rule only fires when the lookup misses, which is
 * Netlify's shadowing semantics and what makes a `/* /index.html 200` rule
 * safe to leave in place.
 *
 * The default status is `301`, also as Netlify.
 */
export function parseRedirects(text: string): ParsedRedirects {
  const warnings: string[] = [];
  const ignore = (reason: string): ParsedRedirects => ({
    rules: [],
    warnings: [`_redirects ignored: ${reason}`],
  });

  if (byteLength(text) > MAX_CONTROL_FILE_BYTES) {
    return ignore(`the file is larger than ${MAX_CONTROL_FILE_BYTES} bytes`);
  }

  const rules: SiteRedirectRule[] = [];
  const lines = splitLines(text);

  for (let i = 0; i < lines.length; i++) {
    const comment = lines[i].indexOf("#");
    const line = (comment === -1 ? lines[i] : lines[i].slice(0, comment)).trim();
    if (line === "") continue;

    const tokens = line.split(/\s+/);
    if (tokens.length < 2) {
      warnings.push(`_redirects line ${i + 1}: expected "from to [status]"`);
      continue;
    }
    if (tokens.length > 3) {
      warnings.push(`_redirects line ${i + 1}: too many fields`);
      continue;
    }

    const from = tokens[0];
    let to = tokens[1];
    let statusToken = tokens[2];
    let force = false;

    if (statusToken !== undefined && statusToken.endsWith("!")) {
      force = true;
      statusToken = statusToken.slice(0, -1);
    } else if (statusToken === undefined && to.endsWith("!")) {
      // `/old /new!` — the `!` rides on the target when the status is implied.
      force = true;
      to = to.slice(0, -1);
    }

    if (!from.startsWith("/")) {
      warnings.push(`_redirects line ${i + 1}: "${from}" must start with "/"`);
      continue;
    }
    if (hasMisplacedSplat(from)) {
      warnings.push(`_redirects line ${i + 1}: "*" is only allowed as the last segment`);
      continue;
    }

    const status = statusToken === undefined ? 301 : Number(statusToken);
    if (!Number.isInteger(status) || !(REDIRECT_STATUSES as readonly number[]).includes(status)) {
      warnings.push(
        `_redirects line ${i + 1}: status must be one of ${REDIRECT_STATUSES.join(", ")} (got "${statusToken}")`,
      );
      continue;
    }

    const targetProblem = internalTargetProblem(to);
    if (targetProblem) {
      warnings.push(`_redirects line ${i + 1}: ${targetProblem}`);
      continue;
    }

    if (rules.length >= MAX_REDIRECT_RULES) {
      return ignore(`more than ${MAX_REDIRECT_RULES} rules`);
    }
    rules.push({ from, to, status, force });
  }

  return { rules, warnings };
}

/**
 * Why `to` is not a path inside this site, or null when it is one.
 *
 * Deliberately narrow: a rooted path, no protocol-relative `//host` form, no
 * scheme, no backslashes (which some clients normalise to `/` after the check
 * would have passed). A site must not be able to redirect a visitor off the
 * hostname we gave it — see the module comment.
 */
function internalTargetProblem(to: string): string | null {
  if (!to.startsWith("/")) return `"${to}" must be a path inside the site (start with "/")`;
  if (to.startsWith("//")) return `"${to}" points at another origin`;
  if (to.includes("://") || to.includes("\\")) return `"${to}" is not a plain path`;
  return null;
}

/**
 * The first rule that matches `path`, with `:splat` and `:placeholder`
 * substituted into its target. First match wins, so order in the file is the
 * author's priority order.
 *
 * The caller decides *which* rules to offer: forced rules are matched before
 * the file lookup, the rest only after it misses.
 */
export function matchRedirect(rules: SiteRedirectRule[], path: string): RedirectMatch | null {
  for (const rule of rules) {
    const matched = matchPattern(rule.from, path);
    if (!matched) continue;
    const to = substitute(rule.to, matched);
    // Substitution can only ever splice in path segments, but a rule whose
    // target became something else is dropped rather than trusted.
    if (internalTargetProblem(to)) continue;
    return { to, status: rule.status, force: rule.force };
  }
  return null;
}

function substitute(target: string, matched: PatternMatch): string {
  return target.replace(/:([a-zA-Z_][a-zA-Z0-9_]*)/g, (whole, name: string) => {
    if (name === "splat") return matched.splat;
    const value = matched.params[name];
    return value === undefined ? whole : value;
  });
}

// --- Storage bound ---------------------------------------------------------

/** What `meta.hosting` may occupy on the row, serialised (ADR-013 C3). */
export const MAX_HOSTING_JSON_BYTES = 256 * 1024;

/**
 * Keep the stored rules inside {@link MAX_HOSTING_JSON_BYTES}.
 *
 * The per-file caps already bound this in every realistic case; this is the
 * backstop that keeps a pathological pair of files from putting a quarter of a
 * megabyte of JSON on a row that is read on every request. Dropping the rules
 * and keeping the warning is the honest outcome: the site behaves as it did
 * before the files existed, and the API says why.
 */
export function boundHosting(hosting: SiteHosting): SiteHosting {
  if (byteLength(JSON.stringify(hosting)) <= MAX_HOSTING_JSON_BYTES) return hosting;
  return {
    headers: [],
    redirects: [],
    warnings: [
      ...hosting.warnings,
      `rules dropped: the parsed rules exceed ${MAX_HOSTING_JSON_BYTES} bytes`,
    ],
  };
}
