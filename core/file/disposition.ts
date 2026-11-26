/**
 * Which files the apex renders and which it downloads (ADR-013 A1
 * and A4).
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

import { essenceOf, OCTET_STREAM, parseMediaType, type MediaType } from "./media-type";

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

/** True when `type`'s essence is in {@link INLINE_TYPES}. */
export function isInlineType(type: MediaType): boolean {
  return INLINE_TYPES.has(essenceOf(type));
}

/**
 * `Content-Type` and `Content-Disposition` for a parsed stored type, plus the
 * sandbox CSP whenever it is an attachment.
 *
 * `null` is a stored value `parseMediaType` rejected. Rows written before
 * uploads were parsed may hold one, so it is sent as octet-stream and treated
 * as active on the apex.
 */
export function contentHeaders(
  type: MediaType | null,
  displayName: string,
  siteHost: boolean,
): Record<string, string> {
  const inline = siteHost || (type !== null && isInlineType(type));
  const headers: Record<string, string> = {
    "Content-Type": type ?? OCTET_STREAM,
    "Content-Disposition": `${inline ? "inline" : "attachment"}; filename="${encodeURIComponent(displayName)}"`,
  };
  if (!inline) headers["Content-Security-Policy"] = "sandbox";
  return headers;
}

if (import.meta.vitest) {
  const { test, expect } = import.meta.vitest;

  const disposition = (stored: string | undefined) =>
    contentHeaders(parseMediaType(stored), "f", false)["Content-Disposition"].split(";")[0];

  test("the parsed type decides, ignoring parameters and case", () => {
    expect(disposition("text/plain; charset=utf-8")).toBe("inline");
    expect(disposition("IMAGE/PNG")).toBe("inline");
    for (const type of ["text/html", "image/svg+xml", "application/xml", "text/javascript", "application/pdf"]) {
      expect(disposition(type), type).toBe("attachment");
    }
  });

  test("a type that does not parse is an octet-stream attachment, sandboxed", () => {
    for (const stored of ["text/plain;x=,text/html", "", undefined]) {
      expect(contentHeaders(parseMediaType(stored), "f", false)).toEqual({
        "Content-Type": "application/octet-stream",
        "Content-Disposition": 'attachment; filename="f"',
        "Content-Security-Policy": "sandbox",
      });
    }
  });

  test("a site host stays inline and still gets the normalized type", () => {
    expect(contentHeaders(parseMediaType("TEXT/HTML; x=y"), "f", true)).toEqual({
      "Content-Type": "text/html",
      "Content-Disposition": 'inline; filename="f"',
    });
  });
}
