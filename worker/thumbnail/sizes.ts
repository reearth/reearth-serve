// Thumbnail size catalogue. See docs/adr/009-image-thumbnail-generation.md.
//
// xs is the size aimed at CesiumJS billboards: 64 px keeps the TextureAtlas
// well under the 2048 px MAX_TEXTURE_SIZE common on older mobile GPUs while
// admitting ~800 unique images per atlas.

export const THUMBNAIL_SIZES = ["xs", "sm", "md", "lg"] as const;
export type ThumbnailSize = (typeof THUMBNAIL_SIZES)[number];

export const THUMBNAIL_LONG_EDGE: Record<ThumbnailSize, number> = {
  xs: 64,
  sm: 128,
  md: 512,
  lg: 1280,
};

export const THUMBNAIL_QUALITY: Record<ThumbnailSize, number> = {
  xs: 80,
  sm: 80,
  md: 85,
  lg: 85,
};

export const THUMBNAIL_FORMAT = "webp" as const;
export const THUMBNAIL_CONTENT_TYPE = "image/webp" as const;

export function isThumbnailSize(value: string): value is ThumbnailSize {
  return (THUMBNAIL_SIZES as readonly string[]).includes(value);
}

// Filename within the _thumbs/ prefix for a given size.
export function thumbnailFilename(size: ThumbnailSize): string {
  return `${size}.${THUMBNAIL_FORMAT}`;
}

// Content types we currently know how to generate thumbnails for.
const SUPPORTED_SOURCE_CONTENT_TYPES = new Set([
  "image/jpeg",
  "image/png",
  "image/webp",
  "image/gif",
]);

export function isThumbnailableContentType(contentType: string | undefined): boolean {
  if (!contentType) return false;
  const base = contentType.split(";")[0].trim().toLowerCase();
  return SUPPORTED_SOURCE_CONTENT_TYPES.has(base);
}

if (import.meta.vitest) {
  const { test, expect, describe } = import.meta.vitest;

  describe("isThumbnailSize", () => {
    test("accepts xs/sm/md/lg", () => {
      for (const s of THUMBNAIL_SIZES) expect(isThumbnailSize(s)).toBe(true);
    });
    test("rejects unknown values", () => {
      expect(isThumbnailSize("xxl")).toBe(false);
      expect(isThumbnailSize("XS")).toBe(false);
      expect(isThumbnailSize("")).toBe(false);
    });
  });

  describe("thumbnailFilename", () => {
    test("appends .webp", () => {
      expect(thumbnailFilename("xs")).toBe("xs.webp");
      expect(thumbnailFilename("lg")).toBe("lg.webp");
    });
  });

  describe("isThumbnailableContentType", () => {
    test("accepts supported image MIME types", () => {
      expect(isThumbnailableContentType("image/jpeg")).toBe(true);
      expect(isThumbnailableContentType("image/png")).toBe(true);
      expect(isThumbnailableContentType("image/webp")).toBe(true);
      expect(isThumbnailableContentType("image/gif")).toBe(true);
    });
    test("strips parameters before matching", () => {
      expect(isThumbnailableContentType("image/jpeg; charset=binary")).toBe(true);
      expect(isThumbnailableContentType("IMAGE/JPEG")).toBe(true);
    });
    test("rejects non-images and unsupported formats", () => {
      expect(isThumbnailableContentType("text/plain")).toBe(false);
      expect(isThumbnailableContentType("image/tiff")).toBe(false);
      expect(isThumbnailableContentType("image/avif")).toBe(false);
      expect(isThumbnailableContentType(undefined)).toBe(false);
      expect(isThumbnailableContentType("")).toBe(false);
    });
  });

  describe("THUMBNAIL_LONG_EDGE", () => {
    test("matches ADR-009 contract", () => {
      expect(THUMBNAIL_LONG_EDGE.xs).toBe(64);
      expect(THUMBNAIL_LONG_EDGE.sm).toBe(128);
      expect(THUMBNAIL_LONG_EDGE.md).toBe(512);
      expect(THUMBNAIL_LONG_EDGE.lg).toBe(1280);
    });
  });
}
