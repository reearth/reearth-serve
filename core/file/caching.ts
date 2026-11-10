/**
 * Cache policy for file delivery (ADR-013).
 *
 * Two kinds of URL reach the same bytes:
 *
 * - `/files/{versionId}/…` is pinned. A version is immutable, so the response
 *   can be cached for a year and never revalidated.
 * - `/files/{assetId}/…` follows the asset's active version. Every file at
 *   such a URL is revalidated on every use (`max-age=0, must-revalidate`, the
 *   same default Netlify applies to a whole deploy): switching the active
 *   version is a blue/green cut-over, and it is only one if *all* files move
 *   together — a one-hour lifetime on a non-hashed `app.js` would have let an
 *   old bundle run against the new `index.html`. Revalidation is a conditional
 *   request answered by a `304` on the ETag, so the cost is a round trip, not
 *   bytes. A consumer that wants the year-long cache — a tileset pulled by a
 *   viewer — pins the version ID in the URL instead.
 */
export const PINNED_CACHE_CONTROL = "public, max-age=31536000, immutable";
export const ENTRY_CACHE_CONTROL = "public, max-age=0, must-revalidate";
export const DEFAULT_CACHE_CONTROL = ENTRY_CACHE_CONTROL;

/** The part of a delivery policy the cache header depends on (ADR-014 §4 Response). */
export interface CachePolicy {
  private: boolean;
  maxAgeCap: number | null;
}

const PUBLIC_POLICY: CachePolicy = { private: false, maxAgeCap: null };

/**
 * A protected asset (ADR-013 B7) keeps the lifetimes above and only swaps
 * `public` for `private`, so a browser may still keep a protected site's files
 * (and revalidate them) while no shared cache stores them. On Cloudflare,
 * Worker responses are not cached by default, which makes this defence in
 * depth rather than the whole mechanism, but a corporate proxy in front of a
 * visitor is exactly the shared cache `private` exists for.
 *
 * A delivery token also caps `max-age` at the token's remaining life, and
 * keeps `immutable` only at a pinned URL.
 */
export function cacheControlFor(
  at: { pinned: boolean; contentType: string },
  policy: CachePolicy = PUBLIC_POLICY,
): string {
  const base = at.pinned
    ? PINNED_CACHE_CONTROL
    : isEntryDocument(at.contentType)
      ? ENTRY_CACHE_CONTROL
      : DEFAULT_CACHE_CONTROL;
  return applyPolicy(base, policy, at.pinned);
}

/**
 * Thumbnails never change for a version, so they take the pinned lifetime at
 * any URL. Under a token an asset-ID URL revalidates like an entry document,
 * which no token's remaining life can undercut.
 */
export function thumbnailCacheControl(pinned: boolean, policy: CachePolicy): string {
  const base = pinned || policy.maxAgeCap === null ? PINNED_CACHE_CONTROL : ENTRY_CACHE_CONTROL;
  return applyPolicy(base, policy, pinned);
}

function applyPolicy(base: string, policy: CachePolicy, pinned: boolean): string {
  const cap = policy.maxAgeCap;
  return base.split(", ").flatMap((directive) => {
    if (directive === "public" && policy.private) return ["private"];
    if (cap === null) return [directive];
    if (directive.startsWith("max-age=")) return [`max-age=${Math.min(Number(directive.slice(8)), cap)}`];
    if (directive === "immutable" && !pinned) return [];
    return [directive];
  }).join(", ");
}

function isEntryDocument(contentType: string): boolean {
  const type = contentType.split(";")[0].trim().toLowerCase();
  return type === "text/html" || type === "application/xhtml+xml";
}

/**
 * ETag for the representation actually sent. The store's tag identifies the
 * stored bytes; when those bytes are gzip and we decode them (or slice a range
 * out of the decoded stream) the wire representation differs, so the tag
 * becomes weak — same content, different bytes.
 */
export function representationEtag(
  storedEtag: string | undefined,
  opts: { transformed: boolean },
): string | undefined {
  if (!storedEtag) return undefined;
  const quoted = storedEtag.startsWith('"') || storedEtag.startsWith('W/"') ? storedEtag : `"${storedEtag}"`;
  if (!opts.transformed) return quoted;
  return quoted.startsWith("W/") ? quoted : `W/${quoted}`;
}

/** Weak comparison per RFC 9110 §8.8.3.2: `W/` prefixes are ignored on both sides. */
export function etagMatches(ifNoneMatch: string | undefined, etag: string): boolean {
  if (!ifNoneMatch) return false;
  if (ifNoneMatch.trim() === "*") return true;
  const wanted = stripWeak(etag);
  return ifNoneMatch
    .split(",")
    .map((tag) => stripWeak(tag.trim()))
    .some((tag) => tag === wanted);
}

function stripWeak(tag: string): string {
  return tag.startsWith("W/") ? tag.slice(2) : tag;
}

if (import.meta.vitest) {
  const { test, expect } = import.meta.vitest;

  test("pinned URLs are immutable regardless of type", () => {
    expect(cacheControlFor({ pinned: true, contentType: "text/html" })).toBe(PINNED_CACHE_CONTROL);
  });

  test("HTML at an asset URL revalidates every time", () => {
    expect(cacheControlFor({ pinned: false, contentType: "text/html; charset=utf-8" })).toBe(ENTRY_CACHE_CONTROL);
    expect(cacheControlFor({ pinned: false, contentType: "application/xhtml+xml" })).toBe(ENTRY_CACHE_CONTROL);
  });

  test("other files at an asset URL revalidate every time too (blue/green cut-over)", () => {
    for (const contentType of ["application/javascript", "text/css", "application/octet-stream"]) {
      const value = cacheControlFor({ pinned: false, contentType });
      expect(value).toBe("public, max-age=0, must-revalidate");
      expect(value).not.toContain("immutable");
    }
  });

  test("a protected asset keeps its lifetime but turns private (ADR-013 B7)", () => {
    const cc = (o: { pinned: boolean; contentType: string }) =>
      cacheControlFor(o, { private: true, maxAgeCap: null });
    expect(cc({ pinned: false, contentType: "text/html" })).toBe("private, max-age=0, must-revalidate");
    expect(cc({ pinned: false, contentType: "application/javascript" })).toBe("private, max-age=0, must-revalidate");
    expect(cc({ pinned: true, contentType: "text/html" })).toBe("private, max-age=31536000, immutable");
    // No shared cache may store any of them.
    for (const contentType of ["text/html", "application/javascript"]) {
      expect(cc({ pinned: false, contentType })).not.toContain("public");
    }
  });

  test("a token caps max-age at its remaining life and keeps immutable only when pinned", () => {
    const token = { private: true, maxAgeCap: 600 };
    expect(cacheControlFor({ pinned: true, contentType: "text/html" }, token)).toBe("private, max-age=600, immutable");
    expect(cacheControlFor({ pinned: false, contentType: "text/html" }, token)).toBe("private, max-age=0, must-revalidate");
    expect(thumbnailCacheControl(true, token)).toBe("private, max-age=600, immutable");
    expect(thumbnailCacheControl(false, token)).toBe("private, max-age=0, must-revalidate");
    expect(thumbnailCacheControl(false, { private: true, maxAgeCap: null })).toBe("private, max-age=31536000, immutable");
  });

  test("representationEtag quotes bare tags and weakens transformed ones", () => {
    expect(representationEtag("abc", { transformed: false })).toBe('"abc"');
    expect(representationEtag('"abc"', { transformed: false })).toBe('"abc"');
    expect(representationEtag('"abc"', { transformed: true })).toBe('W/"abc"');
    expect(representationEtag('W/"abc"', { transformed: true })).toBe('W/"abc"');
    expect(representationEtag(undefined, { transformed: false })).toBeUndefined();
  });

  test("etagMatches uses weak comparison over a list", () => {
    expect(etagMatches('"abc"', '"abc"')).toBe(true);
    expect(etagMatches('W/"abc"', '"abc"')).toBe(true);
    expect(etagMatches('"abc"', 'W/"abc"')).toBe(true);
    expect(etagMatches('"x", "abc"', '"abc"')).toBe(true);
    expect(etagMatches("*", '"abc"')).toBe(true);
    expect(etagMatches('"xyz"', '"abc"')).toBe(false);
    expect(etagMatches(undefined, '"abc"')).toBe(false);
  });
}
