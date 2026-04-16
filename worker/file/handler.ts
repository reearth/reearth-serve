import { Hono } from "hono";
import { cors } from "hono/cors";
import type { AppEnv } from "../types";
import { decompressStream } from "../asset/compression";
import { resolveAssetVersion } from "../asset/usecase";
import { parseRange, sliceStream } from "./stream";

// File delivery uses a URL-as-capability model by design (ROADMAP "file-layer
// access control (URL visibility) — distinct from service-layer"). Knowing
// the asset ID grants download; confidentiality relies on ID unguessability
// and on enumeration endpoints (list APIs) being scoped to the caller, NOT on
// request-time auth here. Do not add access checks without updating ROADMAP.
export const fileRoutes = new Hono<AppEnv>();

// CORS only on file delivery routes
fileRoutes.use("/*", cors({ origin: "*" }));

// GET /files/:id/:filename — serve single-file asset
// GET /files/:id/path/to/file — serve extracted file from archive asset
fileRoutes.get("/:id/:path{.+}", async (c) => {
  const metadataStore = c.get("metadata");
  const versions = c.get("versions");
  const storage = c.get("storage");
  const id = c.req.param("id");
  const filePath = c.req.param("path");
  const rangeHeader = c.req.header("Range");
  const acceptEncoding = c.req.header("Accept-Encoding") ?? "";
  const clientAcceptsGzip = acceptEncoding.includes("gzip");
  const range = parseRange(rangeHeader);

  // Resolve asset + version
  const resolved = await resolveAssetVersion(metadataStore, versions, id);
  if (!resolved) {
    return c.json({ error: "File not found" }, 404);
  }

  const { asset, version } = resolved;

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
});

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
    return new Response(file.body, { status: 200, headers });
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
