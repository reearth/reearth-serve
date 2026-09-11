/**
 * Cache policy for file delivery (ADR-013).
 *
 * Two kinds of URL reach the same bytes:
 *
 * - `/files/{versionId}/…` is pinned. A version is immutable, so the response
 *   can be cached for a year and never revalidated.
 * - `/files/{assetId}/…` follows the asset's active version. It must stay
 *   revalidatable or a new deploy is invisible for as long as the old copy
 *   sits in a cache. HTML is the entry point of a hosted site and is
 *   revalidated on every load; everything else keeps a one-hour lifetime and
 *   revalidates by ETag afterwards. Hashed asset filenames — what every
 *   frontend bundler emits — never need a fresh copy within that hour.
 */
export const PINNED_CACHE_CONTROL = "public, max-age=31536000, immutable";
export const ENTRY_CACHE_CONTROL = "public, max-age=0, must-revalidate";
export const DEFAULT_CACHE_CONTROL = "public, max-age=3600";

/**
 * `protected` (ADR-013 B7) keeps the lifetimes above and only swaps `public`
 * for `private`, so a browser still caches a protected site's assets for an
 * hour while no shared cache stores them. On Cloudflare, Worker responses are
 * not cached by default, which makes this defence in depth rather than the
 * whole mechanism — but a corporate proxy in front of a visitor is exactly the
 * shared cache `private` exists for.
 */
export function cacheControlFor(
  opts: { pinned: boolean; contentType: string; protected?: boolean },
): string {
  const base = opts.pinned
    ? PINNED_CACHE_CONTROL
    : isEntryDocument(opts.contentType)
      ? ENTRY_CACHE_CONTROL
      : DEFAULT_CACHE_CONTROL;
  return opts.protected ? privateForm(base) : base;
}

function privateForm(value: string): string {
  return value.startsWith("public, ") ? `private, ${value.slice("public, ".length)}` : value;
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

  test("other files at an asset URL keep the one-hour default without immutable", () => {
    const value = cacheControlFor({ pinned: false, contentType: "application/javascript" });
    expect(value).toBe(DEFAULT_CACHE_CONTROL);
    expect(value).not.toContain("immutable");
  });

  test("a protected asset keeps its lifetime but turns private (ADR-013 B7)", () => {
    const cc = (o: { pinned: boolean; contentType: string }) =>
      cacheControlFor({ ...o, protected: true });
    expect(cc({ pinned: false, contentType: "text/html" })).toBe("private, max-age=0, must-revalidate");
    expect(cc({ pinned: false, contentType: "application/javascript" })).toBe("private, max-age=3600");
    expect(cc({ pinned: true, contentType: "text/html" })).toBe("private, max-age=31536000, immutable");
    // No shared cache may store any of them.
    for (const contentType of ["text/html", "application/javascript"]) {
      expect(cc({ pinned: false, contentType })).not.toContain("public");
    }
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
