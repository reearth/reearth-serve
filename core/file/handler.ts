import { Hono } from "hono";
import { cors } from "hono/cors";
import { describeRoute, resolver } from "hono-openapi";
import type { AppEnv } from "../types";
import { decompressStream } from "../asset/compression";
import { resolveAssetVersion } from "../asset/usecase";
import { legacyThumbKey, versionThumbKey } from "../asset/usecase/shared";
import { parseRange, sliceStream } from "./stream";
import { errorResponseSchema } from "../../shared";
import {
  THUMBNAIL_SIZES,
  isThumbnailSize,
  thumbnailFilename,
  THUMBNAIL_CONTENT_TYPE,
  type ThumbnailSize,
} from "../thumbnail/sizes";

// Detect a thumbnail request. Returns the requested size on success, "invalid"
// if the request explicitly named an unknown size (→ 400), or null if not a
// thumb request.
function detectThumbRequest(
  filePath: string,
  query: string | undefined,
): ThumbnailSize | "invalid" | null {
  // Query-parameter form: ?thumb=xs takes precedence.
  if (query !== undefined) {
    return isThumbnailSize(query) ? query : "invalid";
  }
  // Path form: _thumbs/<size>.webp
  const match = filePath.match(/^_thumbs\/([^/]+)\.webp$/);
  if (!match) return null;
  return isThumbnailSize(match[1]) ? match[1] : "invalid";
}

// File delivery uses a URL-as-capability model by design (ROADMAP "file-layer
// access control (URL visibility) — distinct from service-layer"). Knowing
// the asset ID grants download; confidentiality relies on ID unguessability
// and on enumeration endpoints (list APIs) being scoped to the caller, NOT on
// request-time auth here. Do not add access checks without updating ROADMAP.
export const fileRoutes = new Hono<AppEnv>();

// CORS only on file delivery routes
fileRoutes.use("/*", cors({ origin: "*" }));

const stringHeader = (description: string) => ({ description, schema: { type: "string" as const } });
const fileHeaders = {
  "Content-Type": stringHeader("Stored content type of the file (image/webp for thumbnails)"),
  "Content-Length": stringHeader("Body length in bytes. Omitted when a gzip-stored file is decompressed and its original size is unknown"),
  "Content-Encoding": stringHeader("`gzip` when a gzip-stored file is passed through to a client that accepts gzip"),
  "Content-Disposition": stringHeader("`inline; filename=\"<name>\"`"),
  "Accept-Ranges": stringHeader("`bytes`. Not sent on gzip pass-through responses or thumbnails"),
  "Cache-Control": stringHeader("`public, max-age=3600, immutable` for files; `public, max-age=31536000, immutable` for thumbnails"),
  "Access-Control-Allow-Origin": stringHeader("`*`"),
};
const jsonError = (description: string) => ({
  description,
  content: { "application/json": { schema: resolver(errorResponseSchema) } },
});

// GET /files/:id/:filename — serve single-file asset
// GET /files/:id/path/to/file — serve extracted file from archive asset
fileRoutes.get("/:id/:path{.+}",
  describeRoute({
    tags: ["Files"],
    summary: "Download a file",
    description: [
      "Public permalink for an asset's file. `id` is an asset ID (serves the active version, or the latest when none is set) or a version ID (serves that version).",
      "",
      "For a single-file asset `path` is its filename; for an extracted archive it is the entry path inside the archive and may contain `/`.",
      "`_thumbs/{size}.webp` (or `?thumb={size}` on any path) serves a generated WebP thumbnail.",
      "",
      "Gzip-stored files are sent as-is with `Content-Encoding: gzip` when the request has `Accept-Encoding: gzip` and no `Range`; otherwise they are decompressed on the fly.",
      "",
      "Conditional requests (`If-None-Match`, `If-Modified-Since`) are not supported: no `ETag` / `Last-Modified` is sent and `304` is never returned.",
      "An unparseable `Range` header is ignored and the full file is returned with `200`.",
    ].join("\n"),
    // URL-as-capability: no credentials, see the comment above.
    security: [],
    parameters: [
      { name: "id", in: "path", required: true, schema: { type: "string" }, description: "Asset ID or version ID" },
      { name: "path", in: "path", required: true, schema: { type: "string" }, description: "Filename, or a path inside an extracted archive (may contain `/`, sent raw or escaped as `%2F`)" },
      { name: "thumb", in: "query", required: false, schema: { type: "string", enum: [...THUMBNAIL_SIZES] }, description: "Serve the WebP thumbnail of this size instead of the file. Any other value → 400" },
      { name: "Range", in: "header", required: false, schema: { type: "string", pattern: "^bytes=\\d+-\\d*$" }, description: "Single byte range, `bytes=<start>-` or `bytes=<start>-<end>`. Suffix (`bytes=-N`) and multi-range forms are ignored" },
      { name: "Accept-Encoding", in: "header", required: false, schema: { type: "string" }, description: "If it contains `gzip`, gzip-stored files are passed through compressed (non-Range requests only)" },
    ],
    responses: {
      200: {
        description: "File content",
        headers: fileHeaders,
        content: { "*/*": { schema: { type: "string", format: "binary" } } },
      },
      206: {
        description: "Partial content for a `Range` request",
        headers: {
          ...fileHeaders,
          "Content-Range": stringHeader("`bytes <start>-<end>/<total>`. Omitted when a gzip-stored file's original size is unknown"),
        },
        content: { "*/*": { schema: { type: "string", format: "binary" } } },
      },
      400: jsonError("Invalid thumbnail size"),
      404: jsonError("Asset, file, or thumbnail not found"),
    },
  }),
  async (c) => {
    const metadataStore = c.get("metadata");
    const versions = c.get("versions");
    const storage = c.get("storage");
    const id = c.req.param("id");
    const filePath = c.req.param("path");
    const rangeHeader = c.req.header("Range");
    const acceptEncoding = c.req.header("Accept-Encoding") ?? "";
    const clientAcceptsGzip = acceptEncoding.includes("gzip");
    const range = parseRange(rangeHeader);

    // Thumbnail dispatch (query parameter or _thumbs/ path).
    const thumb = detectThumbRequest(filePath, c.req.query("thumb"));
    if (thumb === "invalid") {
      return c.json({ error: "Invalid thumbnail size" }, 400);
    }

    // Resolve asset + version
    const resolved = await resolveAssetVersion(metadataStore, versions, id);
    if (!resolved) {
      return c.json({ error: "File not found" }, 404);
    }

    const { asset, version } = resolved;

    if (thumb) {
      return serveThumbnail(storage, asset, version, thumb);
    }

    // Determine storage key based on whether we have a version
    let storageKeyPath: string;
    let contentType: string;
    let contentEncoding: string | undefined;
    let displayName: string;
    let originalSize: number | undefined;

    if (version) {
      // Versioned layout
      const isArchiveSubpath = version.type === "archive" && filePath !== version.filename;
      if (isArchiveSubpath) {
        storageKeyPath = `assets/${asset.id}/v/${version.id}/files/${filePath}`;
      } else {
        storageKeyPath = `assets/${asset.id}/v/${version.id}/${version.filename}`;
      }

      const file = await storage.get(storageKeyPath, undefined);
      if (!file) {
        // Legacy fallback: try old layout
        return serveLegacy(c, storage, asset, filePath, range, clientAcceptsGzip, rangeHeader);
      }

      contentType = isArchiveSubpath ? file.contentType : version.contentType;
      contentEncoding = isArchiveSubpath ? file.contentEncoding : version.contentEncoding;
      displayName = isArchiveSubpath ? filePath.split("/").pop() || filePath : version.filename;
      originalSize = version.originalSize;

      return serveFile(file, contentType, contentEncoding, displayName, originalSize, range, clientAcceptsGzip, rangeHeader, storage, storageKeyPath);
    }

    // Legacy (no versions) — use the old layout
    return serveLegacy(c, storage, asset, filePath, range, clientAcceptsGzip, rangeHeader);
  },
);

async function serveThumbnail(
  storage: any,
  asset: { id: string },
  version: { id: string } | null,
  size: ThumbnailSize,
): Promise<Response> {
  const filename = thumbnailFilename(size);
  const key = version
    ? versionThumbKey(asset.id, version.id, filename)
    : legacyThumbKey(asset.id, filename);
  const file = await storage.get(key, undefined);
  if (!file) {
    return new Response(JSON.stringify({ error: "Thumbnail not available" }), {
      status: 404,
      headers: { "Content-Type": "application/json", "Cache-Control": "public, max-age=30" },
    });
  }

  return new Response(file.body, {
    status: 200,
    headers: {
      "Content-Type": THUMBNAIL_CONTENT_TYPE,
      "Content-Length": String(file.size),
      "Cache-Control": "public, max-age=31536000, immutable",
    },
  });
}

async function serveLegacy(
  c: any,
  storage: any,
  asset: any,
  filePath: string,
  range: { offset: number; length: number } | null,
  clientAcceptsGzip: boolean,
  rangeHeader: string | undefined,
) {
  const isArchiveSubpath = asset.type === "archive" && filePath !== asset.filename;
  const storageKeyPath = isArchiveSubpath
    ? `assets/${asset.id}/files/${filePath}`
    : `assets/${asset.id}/${asset.filename}`;

  const file = await storage.get(storageKeyPath, undefined);
  if (!file) {
    return c.json({ error: "File not found" }, 404);
  }

  const contentType = isArchiveSubpath ? file.contentType : asset.contentType;
  const contentEncoding = isArchiveSubpath ? file.contentEncoding : asset.contentEncoding;
  const displayName = isArchiveSubpath ? filePath.split("/").pop() || filePath : asset.filename;
  const originalSize = asset.originalSize;

  return serveFile(file, contentType, contentEncoding, displayName, originalSize, range, clientAcceptsGzip, rangeHeader, storage, storageKeyPath);
}

function serveFile(
  file: { body: ReadableStream; size: number; contentType: string; contentEncoding?: string },
  contentType: string,
  contentEncoding: string | undefined,
  displayName: string,
  originalSize: number | undefined,
  range: { offset: number; length: number } | null,
  clientAcceptsGzip: boolean,
  rangeHeader: string | undefined,
  storage: any,
  storageKeyPath: string,
) {
  const isGzipStored = contentEncoding === "gzip";

  // --- Non-gzip file ---
  if (!isGzipStored) {
    if (range) {
      return (async () => {
        const rangedFile = await storage.get(storageKeyPath, range);
        if (!rangedFile) return new Response(JSON.stringify({ error: "File not found" }), { status: 404, headers: { "Content-Type": "application/json" } });

        const headers: Record<string, string> = {
          "Content-Type": contentType,
          "Accept-Ranges": "bytes",
          "Cache-Control": "public, max-age=3600, immutable",
          "Content-Disposition": `inline; filename="${encodeURIComponent(displayName)}"`,
        };

        if (rangedFile.range) {
          const { offset, length, totalSize } = rangedFile.range;
          headers["Content-Range"] = `bytes ${offset}-${offset + length - 1}/${totalSize}`;
          headers["Content-Length"] = String(length);
          return new Response(rangedFile.body, { status: 206, headers });
        }
        return new Response(rangedFile.body, { status: 200, headers });
      })();
    }

    const headers: Record<string, string> = {
      "Content-Type": contentType,
      "Accept-Ranges": "bytes",
      "Cache-Control": "public, max-age=3600, immutable",
      "Content-Disposition": `inline; filename="${encodeURIComponent(displayName)}"`,
      "Content-Length": String(file.size),
    };
    return new Response(file.body, { status: 200, headers });
  }

  // --- Gzip-stored + client accepts gzip + no range → pass through ---
  if (clientAcceptsGzip && !rangeHeader) {
    const headers: Record<string, string> = {
      "Content-Type": contentType,
      "Content-Encoding": "gzip",
      "Content-Length": String(file.size),
      "Cache-Control": "public, max-age=3600, immutable",
      "Content-Disposition": `inline; filename="${encodeURIComponent(displayName)}"`,
    };
    // encodeBody "manual" tells the runtime the body is ALREADY gzip. The
    // default ("automatic") treats the body as plain and re-encodes per
    // Content-Encoding, so the edge stripped the header and shipped raw
    // gzip bytes to clients — XML/GeoJSON downloads arrived as binary
    // garbage for any client whose Accept-Encoding didn't surface here.
    return new Response(file.body, {
      status: 200,
      headers,
      encodeBody: "manual",
    } as ResponseInit);
  }

  // --- Gzip-stored: decompress ---
  const decompressed = decompressStream(file.body);

  if (!range) {
    const headers: Record<string, string> = {
      "Content-Type": contentType,
      "Accept-Ranges": "bytes",
      "Cache-Control": "public, max-age=3600, immutable",
      "Content-Disposition": `inline; filename="${encodeURIComponent(displayName)}"`,
    };
    if (originalSize) headers["Content-Length"] = String(originalSize);
    return new Response(decompressed, { status: 200, headers });
  }

  // Range on gzip: decompress, skip to offset, stream the range
  const sliced = sliceStream(decompressed, range.offset, range.length, originalSize);
  const headers: Record<string, string> = {
    "Content-Type": contentType,
    "Accept-Ranges": "bytes",
    "Cache-Control": "public, max-age=3600, immutable",
    "Content-Disposition": `inline; filename="${encodeURIComponent(displayName)}"`,
  };

  if (originalSize) {
    const end = Math.min(range.offset + range.length, originalSize) - 1;
    const length = end - range.offset + 1;
    headers["Content-Range"] = `bytes ${range.offset}-${end}/${originalSize}`;
    headers["Content-Length"] = String(length);
  }

  return new Response(sliced, { status: 206, headers });
}
