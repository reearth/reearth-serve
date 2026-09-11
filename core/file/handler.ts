import { Hono, type Context } from "hono";
import type { AppEnv } from "../types";
import { decompressStream } from "../asset/compression";
import type { AssetMetadata, AssetVersion, StoredFile } from "../asset/model";
import type { FileStorage } from "../asset/repository";
import { resolveAssetVersion } from "../asset/usecase";
import { legacyThumbKey, versionThumbKey } from "../asset/usecase/shared";
import { cacheControlFor, etagMatches, representationEtag } from "./caching";
import { addVary, applyCors, preflightResponse, type CorsPolicy } from "./cors";
import { handleAuthSubmit } from "../access/form";
import {
  accessModeOf, AUTH_PATH_SEGMENT, resolveAccess, type AccessDeps,
} from "../access/resolve";
import { SITE_PREVIEW_HEADER, type SitePreview } from "../site/middleware";
import { parseRange, sliceStream } from "./stream";
import {
  isThumbnailSize,
  thumbnailFilename,
  THUMBNAIL_CONTENT_TYPE,
  type ThumbnailSize,
} from "../thumbnail/sizes";

const INDEX_FILE = "index.html";
const NOT_FOUND_FILE = "404.html";

/**
 * Does this missing path name a file rather than a client-side route?
 *
 * A 200 HTML body in place of a missing `.js` chunk, `.json` manifest or
 * `.b3dm` tile is worse than the 404 it replaces: a bundler's dynamic import
 * fails with a syntax error and a 3D Tiles viewer tries to parse HTML as a tile.
 * SPA routes, by contrast, are extensionless (`/about`, `/map/kawasaki`) or end
 * in a slash. So the fallback is withheld from anything whose last segment ends
 * in a short, file-like extension.
 *
 * This is a refinement of ADR-013 C1, which described the fallback without it.
 * The `404.html` branch is unaffected — it answers *with* status 404, so it
 * cannot mislead a loader the way a 200 can.
 */
export function looksLikeAssetPath(filePath: string): boolean {
  return /\.[a-z0-9]{1,8}$/.test(filePath.toLowerCase());
}

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

/** Locate a file at the archive root, in whichever layout holds it. */
async function locateRootFile(
  storage: FileStorage,
  layouts: Layout[],
  name: string,
): Promise<Located | null> {
  for (const layout of layouts) {
    if (!layout.archive) continue;
    const found = await locate(storage, layout, name);
    if (found) return found;
  }
  return null;
}

/**
 * What an archive miss falls back to (ADR-013 C1), after the A1 lookup and the
 * directory-redirect probe have both missed.
 *
 * At most **one** extra storage read: `spa` is checked first and, when it is on
 * and the path is not file-shaped, `404.html` is never looked for. A hit costs
 * nothing new — this runs only on a miss.
 */
async function archiveFallback(
  storage: FileStorage,
  layouts: Layout[],
  filePath: string,
  spa: boolean,
): Promise<{ kind: "spa" | "notFound"; located: Located } | null> {
  if (!layouts.some((l) => l.archive)) return null;

  if (spa && !looksLikeAssetPath(filePath)) {
    const index = await locateRootFile(storage, layouts, INDEX_FILE);
    if (index) return { kind: "spa", located: index };
    return null;
  }

  const page = await locateRootFile(storage, layouts, NOT_FOUND_FILE);
  return page ? { kind: "notFound", located: page } : null;
}

/**
 * The archive's own `404.html`, served with status 404 (ADR-013 C1).
 *
 * No `ETag` and no `Cache-Control` but `no-store`: a 404 body is not a
 * representation of the requested URL, so caching or revalidating it would
 * attach the error page's identity to a path that may exist tomorrow.
 */
function serve404Page(located: Located): Response {
  const isGzipStored = located.contentEncoding === "gzip";
  const headers: Record<string, string> = {
    "Content-Type": located.contentType,
    "Cache-Control": "no-store",
  };
  if (!isGzipStored) headers["Content-Length"] = String(located.file.size);
  return new Response(
    isGzipStored ? decompressStream(located.file.body) : located.file.body,
    { status: 404, headers },
  );
}

// File delivery is **capability by default, access mode when the asset asks
// for it** (ADR-013 B7; ADR-014 §5 generalises it).
//
// For a `public` asset — every asset unless someone protects it — nothing has
// changed: knowing the ID grants the download, confidentiality rests on ID
// unguessability and on the list APIs being scoped to the caller, and
// `resolveAccess` costs one string comparison on a row already in hand. An
// asset whose `access` is `password` is checked here, before any storage I/O,
// on every URL form that reaches this router. Any *further* access check
// belongs in `core/access/`, behind `resolveAccess`, not inline below.
export const fileRoutes = new Hono<AppEnv>();

/** What `resolveAccess` and the auth form need, off the request context. */
function accessDeps(c: Context<AppEnv>): AccessDeps {
  return {
    metadata: c.get("metadata"),
    kv: c.get("cache"),
    signingSecret: c.get("signingSecret"),
    // Set by the composition root when it builds the file-only site router, not
    // read from a header: a visitor cannot claim to be on a site host.
    siteHost: c.get("siteHost"),
  };
}

// POST …/_serve/auth — the password form's endpoint (ADR-013 B7).
//
// Registered ahead of the catch-all and for POST only, which is what stops an
// archive that happens to contain a file named `_serve/auth` from shadowing it:
// that file is still served on GET, and file lookup never sees a POST. On a
// site host the visitor posts to `/_serve/auth` and the site middleware
// rewrites it to exactly this path.
fileRoutes.post(`/:id/${AUTH_PATH_SEGMENT}`, async (c) => {
  const asset = await c.get("metadata").find(c.req.param("id"));
  if (!asset) return c.json({ error: "File not found" }, 404);
  const res = await handleAuthSubmit(asset, c.req.raw, accessDeps(c));
  // Null means the asset is not protected: there is no auth endpoint on a
  // public asset, and saying so would confirm the ID.
  return res ?? c.json({ error: "File not found" }, 404);
});

// Preflight. It carries no credentials and proves nothing, so it is answered
// without an access check — but the policy it announces still depends on the
// asset's mode, which costs one metadata read.
fileRoutes.on("OPTIONS", ["/:id", "/:id/", "/:id/:path{.+}"], async (c) => {
  // The same resolution the GET route does, so a version-ID URL announces the
  // policy of the asset it belongs to rather than falling back to public.
  const resolved = await resolveAssetVersion(c.get("metadata"), c.get("versions"), c.req.param("id"));
  return preflightResponse(c.req.raw, {
    protected: !!resolved && accessModeOf(resolved.asset) === "password",
    origin: c.req.header("Origin") ?? null,
  });
});

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
  // Errors raised before the asset is known cannot know its mode, so they take
  // the public policy: they disclose nothing, and a cross-origin caller should
  // still be able to read the status.
  const anonymousCors: CorsPolicy = { protected: false, origin: null };
  if (thumb === "invalid") {
    const res = c.json({ error: "Invalid thumbnail size" }, 400);
    applyCors(res.headers, anonymousCors);
    return res;
  }

  // Resolve asset + version
  const resolved = await resolveAssetVersion(metadataStore, versions, id);
  if (!resolved) {
    const res = c.json({ error: "File not found" }, 404);
    applyCors(res.headers, anonymousCors);
    return res;
  }

  const { asset, version } = resolved;

  // The access check (ADR-013 B7), before any storage I/O and before the
  // thumbnail branch — a protected asset's thumbnail is as much of a leak as
  // its index page. A challenge, a 429 or the fail-closed 503 all come back as
  // the resolution's own response; only the CORS headers are added to it, so a
  // browser fetch can read the 401 rather than seeing an opaque network error.
  const access = await resolveAccess(asset, c.req.raw, accessDeps(c));
  const corsPolicy: CorsPolicy = {
    protected: accessModeOf(asset) === "password",
    origin: c.req.header("Origin") ?? null,
  };
  if (access.kind === "challenge") {
    applyCors(access.response.headers, corsPolicy);
    return access.response;
  }
  const isProtected = access.protected;

  /** Everything that leaves this route goes through here. */
  const decorate = (res: Response): Response => {
    if (isProtected) addVary(res.headers, "Cookie", "Authorization");
    applyCors(res.headers, corsPolicy);
    return res;
  };

  if (thumb) {
    return decorate(await serveThumbnail(storage, asset, version, thumb, isProtected));
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
      return decorate(c.redirect(url.toString(), 301));
    }

    // SPA fallback and `404.html` (ADR-013 C1). Both sit here: after the access
    // check, after the A1 lookup and after the directory-redirect probe, so a
    // protected asset is challenged before anything is served and a real
    // directory still redirects rather than rendering the app shell.
    const fallback = await archiveFallback(storage, layouts, filePath, asset.spa === true);
    if (!fallback) return decorate(c.json({ error: "File not found" }, 404));
    if (fallback.kind === "notFound") return decorate(serve404Page(fallback.located));
    // The SPA case rejoins the normal path below, so the index is served by
    // exactly the code a direct hit on `/index.html` takes: gzip passthrough,
    // ETag, conditional requests, the A2 cache policy and `noindex` on a
    // preview host all come from there rather than being restated here.
    located = fallback.located;
  }

  const res = await serveFile(located, {
    range,
    rangeHeader,
    clientAcceptsGzip,
    ifNoneMatch: c.req.header("If-None-Match"),
    cacheControl: cacheControlFor({
      pinned,
      contentType: located.contentType,
      protected: isProtected,
    }),
    storage,
  });

  // A preview host serves the same pages as the production name: same content,
  // several URLs, only one of which should be indexed (ADR-013 B4). That covers
  // the version-ID host (pinned), `v{n}--name` and `latest--name` — the last of
  // which is not pinned and so needs saying separately. Asset-ID hosts and the
  // `/files/…` path form are unaffected.
  if (c.get("siteHost") && (pinned || preview)) res.headers.set("X-Robots-Tag", "noindex");

  return decorate(res);
});

async function serveThumbnail(
  storage: FileStorage,
  asset: { id: string },
  version: { id: string } | null,
  size: ThumbnailSize,
  isProtected: boolean,
): Promise<Response> {
  const filename = thumbnailFilename(size);
  const key = version
    ? versionThumbKey(asset.id, version.id, filename)
    : legacyThumbKey(asset.id, filename);
  const file = await storage.get(key, undefined);
  // A thumbnail is derived from the asset, so it follows the asset's mode
  // (ADR-014 §1): protected assets get `private` here too.
  const scope = isProtected ? "private" : "public";
  if (!file) {
    return new Response(JSON.stringify({ error: "Thumbnail not available" }), {
      status: 404,
      headers: { "Content-Type": "application/json", "Cache-Control": `${scope}, max-age=30` },
    });
  }

  return new Response(file.body, {
    status: 200,
    headers: {
      "Content-Type": THUMBNAIL_CONTENT_TYPE,
      "Content-Length": String(file.size),
      "Cache-Control": `${scope}, max-age=31536000, immutable`,
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
