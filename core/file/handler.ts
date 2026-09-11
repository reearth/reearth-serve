import { Hono } from "hono";
import { cors } from "hono/cors";
import type { AppEnv } from "../types";
import { decompressStream } from "../asset/compression";
import type { AssetMetadata, AssetVersion, StoredFile } from "../asset/model";
import type { FileStorage } from "../asset/repository";
import { resolveAssetVersion } from "../asset/usecase";
import { legacyThumbKey, versionThumbKey } from "../asset/usecase/shared";
import { cacheControlFor, etagMatches, representationEtag } from "./caching";
import { SITE_PREVIEW_HEADER, type SitePreview } from "../site/middleware";
import { parseRange, sliceStream } from "./stream";
import {
  isThumbnailSize,
  thumbnailFilename,
  THUMBNAIL_CONTENT_TYPE,
  type ThumbnailSize,
} from "../thumbnail/sizes";

const INDEX_FILE = "index.html";

/** Read the site middleware's preview marker; anything else is not one. */
function sitePreview(value: string | undefined): SitePreview | null {
  return value === "pinned" || value === "latest" ? value : null;
}

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

/**
 * One storage layout an asset's bytes may live under. Versioned assets use
 * `assets/{asset}/v/{version}/…`; assets that predate ADR-005 use
 * `assets/{asset}/…`. The two differ only in prefix and in where the main
 * file's HTTP metadata comes from, so the delivery code works against this
 * shape and never against the raw asset/version rows.
 */
interface Layout {
  archive: boolean;
  /** Filename of the uploaded object (the archive itself for archive assets). */
  filename: string;
  mainKey: string;
  /** Storage key of an extracted entry. Only meaningful when `archive`. */
  entryKey(path: string): string;
  contentType: string;
  contentEncoding?: string;
  originalSize?: number;
}

function versionedLayout(asset: AssetMetadata, version: AssetVersion): Layout {
  const prefix = `assets/${asset.id}/v/${version.id}`;
  return {
    archive: version.type === "archive",
    filename: version.filename,
    mainKey: `${prefix}/${version.filename}`,
    entryKey: (path) => `${prefix}/files/${path}`,
    contentType: version.contentType,
    contentEncoding: version.contentEncoding,
    originalSize: version.originalSize,
  };
}

function legacyLayout(asset: AssetMetadata): Layout {
  const prefix = `assets/${asset.id}`;
  return {
    archive: asset.type === "archive",
    filename: asset.filename,
    mainKey: `${prefix}/${asset.filename}`,
    entryKey: (path) => `${prefix}/files/${path}`,
    contentType: asset.contentType,
    contentEncoding: asset.contentEncoding,
    originalSize: asset.originalSize,
  };
}

interface Located {
  key: string;
  file: StoredFile;
  contentType: string;
  contentEncoding?: string;
  displayName: string;
  originalSize?: number;
}

/**
 * Map a request path onto an object in one layout.
 *
 * - Empty path or trailing slash → the directory's `index.html` (archives) or
 *   the uploaded file itself (single-file assets).
 * - The archive's own filename → the archive.
 * - Anything else on an archive → the extracted entry at that path.
 * - Anything else on a single-file asset → the uploaded file. The path after
 *   the ID has never been checked for single-file assets, and links in the
 *   wild depend on that.
 */
async function locate(storage: FileStorage, layout: Layout, filePath: string): Promise<Located | null> {
  const wantsDirectory = filePath === "" || filePath.endsWith("/");

  if (!layout.archive) {
    const file = await storage.get(layout.mainKey);
    if (!file) return null;
    return {
      key: layout.mainKey,
      file,
      contentType: layout.contentType,
      contentEncoding: layout.contentEncoding,
      displayName: layout.filename,
      originalSize: layout.originalSize,
    };
  }

  if (!wantsDirectory && filePath === layout.filename) {
    const file = await storage.get(layout.mainKey);
    if (!file) return null;
    return {
      key: layout.mainKey,
      file,
      contentType: layout.contentType,
      contentEncoding: layout.contentEncoding,
      displayName: layout.filename,
      originalSize: layout.originalSize,
    };
  }

  const entryPath = wantsDirectory ? `${filePath}${INDEX_FILE}` : filePath;
  const key = layout.entryKey(entryPath);
  const file = await storage.get(key);
  if (!file) return null;
  return {
    key,
    file,
    contentType: file.contentType,
    contentEncoding: file.contentEncoding,
    displayName: entryPath.split("/").pop() || entryPath,
  };
}

/** True when `path` names a directory that has an index file, in any layout. */
async function hasIndex(storage: FileStorage, layouts: Layout[], path: string): Promise<boolean> {
  for (const layout of layouts) {
    if (!layout.archive) continue;
    if (await storage.head(layout.entryKey(`${path}/${INDEX_FILE}`))) return true;
  }
  return false;
}

// File delivery uses a URL-as-capability model by design (ROADMAP "file-layer
// access control (URL visibility) — distinct from service-layer"). Knowing
// the asset ID grants download; confidentiality relies on ID unguessability
// and on enumeration endpoints (list APIs) being scoped to the caller, NOT on
// request-time auth here. Do not add access checks without updating ROADMAP.
export const fileRoutes = new Hono<AppEnv>();

// CORS only on file delivery routes
fileRoutes.use("/*", cors({ origin: "*" }));

// GET /files/:id                 — single-file asset, or an archive's index.html
// GET /files/:id/:filename       — serve single-file asset
// GET /files/:id/path/to/file    — serve extracted file from archive asset
// GET /files/:id/path/to/dir/    — serve path/to/dir/index.html
// HEAD is answered by Hono re-dispatching as GET and dropping the body.
fileRoutes.on("GET", ["/:id", "/:id/", "/:id/:path{.+}"], async (c) => {
  const metadataStore = c.get("metadata");
  const versions = c.get("versions");
  const storage = c.get("storage");
  const id = c.req.param("id");
  const filePath = c.req.param("path") ?? "";
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

  // A URL that names a version ID is pinned: its bytes can never change, so
  // the response may be cached forever. Asset-ID URLs follow the active
  // version and must stay revalidatable (ADR-013 A2).
  //
  // `latest--name` is the exception: the site middleware resolved it to a
  // version ID so the right bytes are served, but the host follows the asset
  // and the version under it moves on the next upload. It says so with the
  // preview header, and the response stays revalidatable (ADR-013 B4).
  const preview = sitePreview(c.req.header(SITE_PREVIEW_HEADER));
  const pinned = version !== null && id === version.id && preview !== "latest";

  // Versioned layout first; assets from before ADR-005 have no version row and
  // live under the legacy prefix, which is also the fallback when the
  // versioned key is missing.
  const layouts = version ? [versionedLayout(asset, version), legacyLayout(asset)] : [legacyLayout(asset)];

  let located: Located | null = null;
  for (const layout of layouts) {
    located = await locate(storage, layout, filePath);
    if (located) break;
  }

  if (!located) {
    // `/files/:id/docs` where `docs/index.html` exists: redirect to the slash
    // form so relative links inside the page resolve against the directory.
    if (filePath !== "" && !filePath.endsWith("/") && (await hasIndex(storage, layouts, filePath))) {
      const url = new URL(c.req.url);
      url.pathname = `${url.pathname}/`;
      return c.redirect(url.toString(), 301);
    }
    return c.json({ error: "File not found" }, 404);
  }

  const res = await serveFile(located, {
    range,
    rangeHeader,
    clientAcceptsGzip,
    ifNoneMatch: c.req.header("If-None-Match"),
    cacheControl: cacheControlFor({ pinned, contentType: located.contentType }),
    storage,
  });

  // A preview host serves the same pages as the production name: same content,
  // several URLs, only one of which should be indexed (ADR-013 B4). That covers
  // the version-ID host (pinned), `v{n}--name` and `latest--name` — the last of
  // which is not pinned and so needs saying separately. Asset-ID hosts and the
  // `/files/…` path form are unaffected.
  if (c.get("siteHost") && (pinned || preview)) res.headers.set("X-Robots-Tag", "noindex");

  return res;
});

async function serveThumbnail(
  storage: FileStorage,
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

interface ServeOptions {
  range: { offset: number; length: number } | null;
  rangeHeader: string | undefined;
  clientAcceptsGzip: boolean;
  ifNoneMatch: string | undefined;
  cacheControl: string;
  storage: FileStorage;
}

async function serveFile(located: Located, opts: ServeOptions): Promise<Response> {
  const { file, key, contentType, contentEncoding, displayName, originalSize } = located;
  const { range, rangeHeader, clientAcceptsGzip, storage } = opts;
  const isGzipStored = contentEncoding === "gzip";
  // Pass the stored gzip bytes through untouched when the client can take
  // them and asked for the whole file; every other path decodes.
  const passthrough = isGzipStored && clientAcceptsGzip && !rangeHeader;

  const etag = representationEtag(file.etag, { transformed: isGzipStored && !passthrough });

  const common: Record<string, string> = {
    "Content-Type": contentType,
    "Cache-Control": opts.cacheControl,
    "Content-Disposition": `inline; filename="${encodeURIComponent(displayName)}"`,
  };
  if (etag) common["ETag"] = etag;
  // The body differs by Accept-Encoding whenever gzip is on disk.
  if (isGzipStored) common["Vary"] = "Accept-Encoding";

  if (etag && etagMatches(opts.ifNoneMatch, etag)) {
    await file.body.cancel().catch(() => {});
    return new Response(null, { status: 304, headers: common });
  }

  // --- Non-gzip file ---
  if (!isGzipStored) {
    const headers: Record<string, string> = { ...common, "Accept-Ranges": "bytes" };
    if (range) {
      // The first read fetched the whole object to learn its metadata; the
      // range itself is a second, bounded read.
      await file.body.cancel().catch(() => {});
      const rangedFile = await storage.get(key, range);
      if (!rangedFile) {
        return new Response(JSON.stringify({ error: "File not found" }), {
          status: 404,
          headers: { "Content-Type": "application/json" },
        });
      }
      if (rangedFile.range) {
        const { offset, length, totalSize } = rangedFile.range;
        headers["Content-Range"] = `bytes ${offset}-${offset + length - 1}/${totalSize}`;
        headers["Content-Length"] = String(length);
        return new Response(rangedFile.body, { status: 206, headers });
      }
      return new Response(rangedFile.body, { status: 200, headers });
    }

    headers["Content-Length"] = String(file.size);
    return new Response(file.body, { status: 200, headers });
  }

  // --- Gzip-stored + client accepts gzip + no range → pass through ---
  if (passthrough) {
    const headers = {
      ...common,
      "Content-Encoding": "gzip",
      "Content-Length": String(file.size),
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
  const headers: Record<string, string> = { ...common, "Accept-Ranges": "bytes" };

  if (!range) {
    if (originalSize) headers["Content-Length"] = String(originalSize);
    return new Response(decompressed, { status: 200, headers });
  }

  // Range on gzip: decompress, skip to offset, stream the range
  const sliced = sliceStream(decompressed, range.offset, range.length, originalSize);
  if (originalSize) {
    const end = Math.min(range.offset + range.length, originalSize) - 1;
    const length = end - range.offset + 1;
    headers["Content-Range"] = `bytes ${range.offset}-${end}/${originalSize}`;
    headers["Content-Length"] = String(length);
  }

  return new Response(sliced, { status: 206, headers });
}
