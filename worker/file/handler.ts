import { Hono } from "hono";
import { cors } from "hono/cors";
import type { AppEnv } from "../types";
import { decompressStream } from "../asset/compression";
import { parseRange, sliceStream } from "./stream";

export const fileRoutes = new Hono<AppEnv>();

// CORS only on file delivery routes
fileRoutes.use("/*", cors({ origin: "*" }));

// GET /files/:id/:filename — serve single-file asset
// GET /files/:id/path/to/file — serve extracted file from archive asset
fileRoutes.get("/:id/:path{.+}", async (c) => {
  const metadataStore = c.get("metadata");
  const storage = c.get("storage");
  const id = c.req.param("id");
  const filePath = c.req.param("path");
  const rangeHeader = c.req.header("Range");
  const acceptEncoding = c.req.header("Accept-Encoding") ?? "";
  const clientAcceptsGzip = acceptEncoding.includes("gzip");
  const range = parseRange(rangeHeader);

  const asset = await metadataStore.find(id);
  if (!asset) {
    return c.json({ error: "File not found" }, 404);
  }

  // Determine storage key and content info based on asset type
  const isArchiveSubpath = asset.type === "archive" && filePath !== asset.filename;
  const storageKeyPath = isArchiveSubpath
    ? `assets/${id}/files/${filePath}`
    : `assets/${id}/${asset.filename}`;

  const file = await storage.get(storageKeyPath, undefined);
  if (!file) {
    return c.json({ error: "File not found" }, 404);
  }

  const contentType = isArchiveSubpath ? file.contentType : asset.contentType;
  const contentEncoding = isArchiveSubpath ? file.contentEncoding : asset.contentEncoding;
  const displayName = isArchiveSubpath ? filePath.split("/").pop() || filePath : asset.filename;
  const isGzipStored = contentEncoding === "gzip";

  // --- Non-gzip file ---
  if (!isGzipStored) {
    if (range) {
      const rangedFile = await storage.get(storageKeyPath, range);
      if (!rangedFile) return c.json({ error: "File not found" }, 404);

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
  const originalSize = asset.originalSize;

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
});
