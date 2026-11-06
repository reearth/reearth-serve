/**
 * Which files the apex renders and which it downloads (ADR-020 §9 items 5, 8
 * and 10).
 *
 * The apex `/files/{id}/…` form shares one origin across every asset, so a
 * document a browser renders there runs on that shared origin. Only types a
 * browser shows without running script are `inline`; everything else, HTML,
 * SVG, XML, JavaScript and PDF included, is an `attachment` with
 * `Content-Security-Policy: sandbox`, so a browser that renders it anyway
 * cannot read the apex's path-scoped cookies. A deny list of active types was
 * rejected because it leaves every unlisted type inline.
 *
 * Site hosts are their own origin per site and stay `inline`: a static site
 * needs its HTML to render.
 */

export const INLINE_TYPES: ReadonlySet<string> = new Set([
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
  "image/avif",
  "text/plain",
  "text/csv",
  "application/json",
  "application/geo+json",
  "model/gltf+json",
  "model/gltf-binary",
  "application/octet-stream",
  "application/x-protobuf",
  "application/vnd.mapbox-vector-tile",
  "video/mp4",
  "video/webm",
  "audio/mpeg",
  "audio/ogg",
]);

/** True when `contentType`'s media type, without parameters or case, is in {@link INLINE_TYPES}. */
export function isInlineType(contentType: string): boolean {
  return INLINE_TYPES.has(contentType.split(";")[0].trim().toLowerCase());
}

/** `Content-Disposition`, plus the sandbox CSP whenever it is an attachment. */
export function dispositionHeaders(
  contentType: string,
  displayName: string,
  siteHost: boolean,
): Record<string, string> {
  const inline = siteHost || isInlineType(contentType);
  const headers: Record<string, string> = {
    "Content-Disposition": `${inline ? "inline" : "attachment"}; filename="${encodeURIComponent(displayName)}"`,
  };
  if (!inline) headers["Content-Security-Policy"] = "sandbox";
  return headers;
}

if (import.meta.vitest) {
  const { test, expect } = import.meta.vitest;

  test("isInlineType ignores parameters and case", () => {
    expect(isInlineType("text/plain; charset=utf-8")).toBe(true);
    expect(isInlineType("IMAGE/PNG")).toBe(true);
    for (const type of ["text/html", "image/svg+xml", "application/xml", "text/javascript", "application/pdf", ""]) {
      expect(isInlineType(type)).toBe(false);
    }
  });
}
