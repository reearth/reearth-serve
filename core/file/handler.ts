import { Hono, type Context } from "hono";
import { describeRoute, resolver } from "hono-openapi";
import type { AppEnv } from "../types";
import { decompressStream } from "../asset/compression";
import type { AssetMetadata, AssetVersion, StoredFile } from "../asset/model";
import type { FileStorage } from "../asset/repository";
import { resolveAssetVersion } from "../asset/usecase";
import { legacyThumbKey, versionThumbKey } from "../asset/usecase/shared";
import { cacheControlFor, etagMatches, representationEtag } from "./caching";
import { addVary, applyCors, preflightResponse, type CorsPolicy } from "./cors";
import { dispositionHeaders } from "./disposition";
import { handleAuthSubmit } from "../access/form";
import { AUTH_PATH_SEGMENT, accessModeOf, resolveAccess, type AccessDeps } from "../access/resolve";
import type { BearerDecision } from "../access/restricted";
import type { VerifiedCaller } from "../auth/types";
import { accessCtx, authorizeAsset, deniedResponse } from "../auth/access";
import { enterCaller, tenancyErrorResponse } from "../tenancy/middleware";
import { UnknownAccountError } from "../tenancy/port";
import { SITE_PREVIEW_HEADER, type SitePreview } from "../site/middleware";
import { hostingFor, isControlFile } from "../site/hosting";
import {
  applySiteHeaders, siteRedirect, siteRedirectResponse, targetFilePath,
} from "./site-routing";
import { errorResponseSchema } from "../../shared";
import { parseRange, sliceStream } from "./stream";
import {
  THUMBNAIL_SIZES,
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
 * SPA routes, by contrast, are extensionless (`/about`, `/map/harbor`) or end
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
function serve404Page(located: Located, siteHost: boolean): Response {
  const isGzipStored = located.contentEncoding === "gzip";
  const headers: Record<string, string> = {
    "Content-Type": located.contentType,
    "Cache-Control": "no-store",
    ...dispositionHeaders(located.contentType, located.displayName, siteHost),
  };
  if (!isGzipStored) headers["Content-Length"] = String(located.file.size);
  return new Response(
    isGzipStored ? decompressStream(located.file.body) : located.file.body,
    { status: 404, headers },
  );
}

// File delivery is capability by default; `resolveAccess` when the asset's
// mode says so (ADR-013 B7, ADR-014 §5).
//
// For a `public` asset, knowing the ID grants the download, and
// `resolveAccess` costs one string comparison on a row already in hand. A
// `password` or `restricted` asset is checked here, before any storage I/O,
// on every URL form that reaches this router. Any further access check
// belongs in `core/access/`, behind `resolveAccess`, not inline below.
export const fileRoutes = new Hono<AppEnv>();

// Last on the way out, so no `_headers` rule and no branch below can drop it.
fileRoutes.use("*", async (c, next) => {
  await next();
  c.res.headers.set("X-Content-Type-Options", "nosniff");
});

/** What `resolveAccess` and the auth form need, off the request context. */
function accessDeps(c: Context<AppEnv>, asset: AssetMetadata): AccessDeps {
  return {
    metadata: c.get("metadata"),
    kv: c.get("cache"),
    signingSecret: c.get("signingSecret"),
    // Set by the composition root when it builds the file-only site router, not
    // read from a header: a visitor cannot claim to be on a site host.
    siteHost: c.get("siteHost"),
    verifyBearer: c.get("bearerVerifier"),
    authorize: (caller) => authorizeBearer(c, asset, caller),
  };
}

/**
 * A verified bearer on a restricted asset (ADR-014 §5 step 3.2). The only
 * place `/files` binds a caller, so public and password reads never reach the
 * directory. Every refusal reads like a missing asset, as `deniedResponse`
 * does, except an outage, which the client should retry.
 */
async function authorizeBearer(
  c: Context<AppEnv>,
  asset: AssetMetadata,
  caller: VerifiedCaller,
): Promise<BearerDecision> {
  const refuse = (res: Response): BearerDecision => {
    res.headers.set("Cache-Control", "no-store");
    return { ok: false, response: res };
  };
  try {
    await enterCaller(c, caller);
    const decision = await authorizeAsset(accessCtx(c), asset, "read_asset");
    return decision.ok ? { ok: true } : refuse(deniedResponse(c, decision, { notFound: "File not found" }));
  } catch (err) {
    if (err instanceof UnknownAccountError) return refuse(c.json({ error: "File not found" }, 404));
    const outage = tenancyErrorResponse(err as Error, c);
    if (outage) return refuse(outage);
    throw err;
  }
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
  const res = await handleAuthSubmit(asset, c.req.raw, accessDeps(c, asset));
  // Null means the asset is not protected: there is no auth endpoint on a
  // public asset, and saying so would confirm the ID.
  return res ?? c.json({ error: "File not found" }, 404);
});

/**
 * The origins a cookie read may be credentialed for: Serve's own and
 * `CREDENTIALED_ORIGINS`. The own origin comes from `BASE_URL`, never from
 * `c.req.url`, which reads `http://` behind a TLS-terminating proxy. On a site
 * host it is `BASE_URL`'s scheme with the request's host.
 */
function trustedOrigins(c: Context<AppEnv>): string[] {
  let base: URL;
  try {
    base = new URL(c.get("baseUrl"));
  } catch {
    return [...c.get("credentialedOrigins")];
  }
  const own = c.get("siteHost")
    ? `${base.protocol}//${(c.req.header("Host") ?? new URL(c.req.url).host).toLowerCase()}`
    : base.origin;
  return [own, ...c.get("credentialedOrigins")];
}

function corsPolicy(c: Context<AppEnv>, proof: CorsPolicy["proof"]): CorsPolicy {
  return { proof, origin: c.req.header("Origin") ?? null, trustedOrigins: trustedOrigins(c) };
}

// Preflight. It carries no credentials and proves nothing, so it is answered
// without an access check and without reading the asset (ADR-013 B7).
fileRoutes.on("OPTIONS", ["/:id", "/:id/", "/:id/:path{.+}"], (c) => preflightResponse(corsPolicy(c, null)));

// GET /files/:id                 — single-file asset, or an archive's index.html
// GET /files/:id/:filename       — serve single-file asset
// GET /files/:id/path/to/file    — serve extracted file from archive asset
// GET /files/:id/path/to/dir/    — serve path/to/dir/index.html
// HEAD is answered by Hono re-dispatching as GET and dropping the body.
async function serveRoute(c: Context<AppEnv, "/:id/:path{.+}">): Promise<Response> {
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
  // Errors raised before the asset is known carry no proof, so they take the
  // refusal policy, which discloses nothing about the asset's mode.
  const refusalCors = corsPolicy(c, null);
  if (thumb === "invalid") {
    const res = c.json({ error: "Invalid thumbnail size" }, 400);
    applyCors(res.headers, refusalCors);
    return res;
  }

  // Resolve asset + version
  const resolved = await resolveAssetVersion(metadataStore, versions, id);
  if (!resolved) {
    const res = c.json({ error: "File not found" }, 404);
    applyCors(res.headers, refusalCors);
    return res;
  }

  const { asset, version } = resolved;

  // The access check (ADR-013 B7, ADR-014 §5), before any storage I/O and
  // before the thumbnail branch: a protected asset's thumbnail is as much of a
  // leak as its index page. Every refusal comes back as the resolution's own
  // response; only the CORS headers are added to it, so a browser fetch can
  // read the 401 rather than seeing an opaque network error.
  const access = await resolveAccess(asset, c.req.raw, accessDeps(c, asset));
  if (access.kind === "challenge") {
    applyCors(access.response.headers, refusalCors);
    return access.response;
  }
  const isProtected = access.proof !== "none";
  const restricted = accessModeOf(asset) === "restricted";
  const cors = corsPolicy(c, access.proof);

  /** Everything that leaves this route goes through here. */
  const decorate = (res: Response): Response => {
    if (isProtected) addVary(res.headers, "Cookie", "Authorization");
    // A restricted asset's misses and redirects are not cached even
    // privately (ADR-014 §4 Response).
    if (restricted && res.status >= 300 && res.status !== 304) res.headers.set("Cache-Control", "no-store");
    applyCors(res.headers, cors);
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
  const isArchive = layouts.some((l) => l.archive);

  // `_headers` / `_redirects` (ADR-013 C3). The rules were parsed once, at
  // extraction time; this is all the request pays for them.
  const hosting = isArchive ? hostingFor(asset, version) : null;

  // The control files are the site's configuration, not its content. They are
  // answered as a miss so an archive cannot publish its own rule set — and
  // nothing else changes, including the file list API, which is tooling.
  if (isArchive && isControlFile(filePath)) {
    return decorate(c.json({ error: "File not found" }, 404));
  }

  // A forced rule (`!`) is consulted before the lookup, so it can shadow a file
  // that exists. Ordering matters beyond that: `resolveAccess` already ran, so
  // a protected site's redirect map cannot be probed without the password.
  let servePath = filePath;
  let rewritten = false;
  if (hosting) {
    const forced = siteRedirect(hosting, servePath, "force");
    if (forced) {
      if (forced.status === 200) {
        servePath = targetFilePath(forced.to);
        rewritten = true;
      } else {
        return decorate(siteRedirectResponse(forced, {
          assetId: id, requestUrl: c.req.url, protected: isProtected,
        }));
      }
    }
  }

  let located: Located | null = null;
  for (const layout of layouts) {
    located = await locate(storage, layout, servePath);
    if (located) break;
  }

  // Plain rules apply only to a path that is not a file — Netlify's shadowing
  // semantics — so they are consulted here, after the lookup missed and before
  // the directory probe and C1's fallbacks.
  if (!located && hosting) {
    const fallbackRule = siteRedirect(hosting, servePath, "fallback");
    if (fallbackRule && fallbackRule.status !== 200) {
      return decorate(siteRedirectResponse(fallbackRule, {
        assetId: id, requestUrl: c.req.url, protected: isProtected,
      }));
    }
    // One rewrite, never a chain: a rule whose target is itself rewritten would
    // be a loop with no natural end, and `!rewritten` is the whole guard.
    if (fallbackRule && !rewritten) {
      servePath = targetFilePath(fallbackRule.to);
      rewritten = true;
      for (const layout of layouts) {
        located = await locate(storage, layout, servePath);
        if (located) break;
      }
    }
  }

  if (!located) {
    // `/files/:id/docs` where `docs/index.html` exists: redirect to the slash
    // form so relative links inside the page resolve against the directory.
    if (servePath !== "" && !servePath.endsWith("/") && (await hasIndex(storage, layouts, servePath))) {
      const url = new URL(c.req.url);
      url.pathname = `${url.pathname}/`;
      return decorate(c.redirect(url.toString(), 301));
    }

    // SPA fallback and `404.html` (ADR-013 C1). Both sit here: after the access
    // check, after the A1 lookup and after the directory-redirect probe, so a
    // protected asset is challenged before anything is served and a real
    // directory still redirects rather than rendering the app shell.
    const fallback = await archiveFallback(storage, layouts, servePath, asset.spa === true);
    if (!fallback) return decorate(c.json({ error: "File not found" }, 404));
    if (fallback.kind === "notFound") {
      return decorate(applySiteHeaders(
        serve404Page(fallback.located, c.get("siteHost")), hosting, servePath, c.get("siteHost"),
      ));
    }
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
    siteHost: c.get("siteHost"),
  });

  // `_headers` rules go on first, so everything the handler sets below — and
  // everything `serveFile` already set — wins over a rule that named the same
  // header (ADR-013 C3).
  applySiteHeaders(res, hosting, servePath, c.get("siteHost"));

  // A preview host serves the same pages as the production name: same content,
  // several URLs, only one of which should be indexed (ADR-013 B4). That covers
  // the version-ID host (pinned), `v{n}--name` and `latest--name` — the last of
  // which is not pinned and so needs saying separately. Asset-ID hosts and the
  // `/files/…` path form are unaffected.
  if (c.get("siteHost") && (pinned || preview)) res.headers.set("X-Robots-Tag", "noindex");

  return decorate(res);
}

const stringHeader = (description: string) => ({ description, schema: { type: "string" as const } });
const nosniff = { "X-Content-Type-Options": stringHeader("`nosniff`, on every `/files` response") };
const corsHeaders = {
  "Access-Control-Allow-Origin": stringHeader("`*`, or the request's `Origin` for a cookie-authorized read from Serve's own origin or one listed in `CREDENTIALED_ORIGINS`"),
  "Access-Control-Allow-Credentials": stringHeader("`true`, only alongside an echoed `Origin`"),
  "Access-Control-Expose-Headers": stringHeader("`WWW-Authenticate, Retry-After`, on every `/files` response"),
  Vary: stringHeader("`Accept-Encoding` for a gzip-stored file; `Cookie, Authorization, Origin` for a protected asset"),
};
const fileHeaders = {
  ...nosniff,
  ...corsHeaders,
  "Content-Type": stringHeader("Stored content type of the file (image/webp for thumbnails)"),
  "Content-Length": stringHeader("Body length in bytes. Omitted when a gzip-stored file is decompressed and its original size is unknown"),
  "Content-Encoding": stringHeader("`gzip` when a gzip-stored file is passed through to a client that accepts gzip"),
  "Content-Disposition": stringHeader("`inline; filename=\"<name>\"` on a site host, and on the apex for an inline type (images, text/plain, text/csv, JSON, GeoJSON, glTF, vector tiles, octet-stream, MP4/WebM, MP3/Ogg); `attachment; filename=\"<name>\"` for every other type. Not sent on thumbnails"),
  "Content-Security-Policy": stringHeader("`sandbox` on every `attachment` response"),
  ETag: stringHeader("The stored object's tag; weak (`W/`) when a gzip-stored file is decompressed. Not sent on thumbnails"),
  "Accept-Ranges": stringHeader("`bytes`. Not sent on gzip pass-through responses or thumbnails"),
  "Cache-Control": stringHeader("`public, max-age=31536000, immutable` at a version-ID URL and for thumbnails; `public, max-age=0, must-revalidate` at an asset-ID URL. A password or restricted asset gets `private` in place of `public`"),
  "Cross-Origin-Resource-Policy": stringHeader("`same-origin` on a cookie-authorized read"),
};
const jsonError = (description: string) => ({
  description,
  headers: { ...nosniff, ...corsHeaders },
  content: { "application/json": { schema: resolver(errorResponseSchema) } },
});

// `/:id` and `/:id/` serve an archive's index.html; only the path form is documented.
fileRoutes.on("GET", ["/:id", "/:id/"], serveRoute);
fileRoutes.get("/:id/:path{.+}",
  describeRoute({
    tags: ["Files"],
    summary: "Download a file",
    description: [
      "Permalink for an asset's file. `id` is an asset ID (serves the active version, or the latest when none is set) or a version ID (serves that version).",
      "",
      "For a single-file asset `path` is its filename; for an extracted archive it is the entry path inside the archive and may contain `/`.",
      "`_thumbs/{size}.webp` (or `?thumb={size}` on any path) serves a generated WebP thumbnail.",
      "",
      "Gzip-stored files are sent as-is with `Content-Encoding: gzip` when the request has `Accept-Encoding: gzip` and no `Range`; otherwise they are decompressed on the fly.",
      "",
      "Conditional requests: every file carries an `ETag`, and an `If-None-Match` that matches it answers `304` with no body. `If-Modified-Since` is ignored: no `Last-Modified` is sent.",
      "An unparseable `Range` header is ignored and the full file is returned with `200`.",
      "",
      "Here, on the shared origin, only types a browser shows without running script are `inline`; HTML, SVG, XML, JavaScript, PDF and every other type download as an `attachment` with `Content-Security-Policy: sandbox`. A hosted site renders on its site host only.",
      "",
      "A public asset needs no credentials. A password-protected asset accepts the viewer cookie the password form sets, or `Authorization: Basic` with the password (the username is ignored); without either it answers `401`, and repeated wrong passwords from one client answer `429`.",
      "A restricted asset accepts `Authorization: Bearer <OIDC access token>` from a project member who holds `read_asset`, on the apex host only. Without a valid bearer it answers `401`; a caller who may not read it gets `404`, the same answer as a missing asset. Its misses and redirects are `no-store`.",
      "CORS: `Access-Control-Allow-Origin: *`, except that a cookie-authorized read from Serve's own origin or one in `CREDENTIALED_ORIGINS` gets its `Origin` echoed with `Access-Control-Allow-Credentials: true`.",
    ].join("\n"),
    // Public and password assets need no bearer; a restricted asset needs one.
    // The password proofs are described above.
    security: [{}, { bearerAuth: [] }],
    parameters: [
      { name: "id", in: "path", required: true, schema: { type: "string" }, description: "Asset ID or version ID" },
      { name: "path", in: "path", required: true, schema: { type: "string" }, description: "Filename, or a path inside an extracted archive (may contain `/`, sent raw or escaped as `%2F`)" },
      { name: "thumb", in: "query", required: false, schema: { type: "string", enum: [...THUMBNAIL_SIZES] }, description: "Serve the WebP thumbnail of this size instead of the file. Any other value → 400" },
      { name: "Range", in: "header", required: false, schema: { type: "string", pattern: "^bytes=\\d+-\\d*$" }, description: "Single byte range, `bytes=<start>-` or `bytes=<start>-<end>`. Suffix (`bytes=-N`) and multi-range forms are ignored" },
      { name: "Accept-Encoding", in: "header", required: false, schema: { type: "string" }, description: "If it contains `gzip`, gzip-stored files are passed through compressed (non-Range requests only)" },
      { name: "If-None-Match", in: "header", required: false, schema: { type: "string" }, description: "One or more entity tags, or `*`. Compared weakly against the `ETag`; a match answers `304`" },
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
      301: {
        description: "A directory without its trailing slash; `Location` adds it. An archive's `_redirects` rules may also answer `302`, `307` or `308`",
        headers: { ...nosniff, ...corsHeaders, Location: stringHeader("The same path with a trailing slash") },
      },
      304: {
        description: "`If-None-Match` matched the current `ETag`. No body",
        headers: {
          ...nosniff,
          ...corsHeaders,
          ETag: fileHeaders.ETag,
          "Cache-Control": fileHeaders["Cache-Control"],
          "Content-Disposition": fileHeaders["Content-Disposition"],
        },
      },
      400: jsonError("Invalid thumbnail size"),
      401: {
        description: "Password-protected asset and no valid cookie or Basic password: a browser navigation (`Accept: text/html`) gets the password page and no `WWW-Authenticate`, every other request gets JSON and the Basic challenge. Restricted asset and no valid bearer: JSON for every request, browser navigations included",
        headers: {
          ...nosniff,
          ...corsHeaders,
          "WWW-Authenticate": stringHeader("Password: `Basic realm=\"reearth-serve\", charset=\"UTF-8\"`, on the JSON form only. Restricted: `Bearer, ServeToken`, or `ServeToken` on a site host"),
          "Cache-Control": stringHeader("`no-store`"),
        },
        content: {
          "application/json": { schema: resolver(errorResponseSchema) },
          "text/html": { schema: { type: "string" } },
        },
      },
      404: jsonError("Asset, file, or thumbnail not found, or a restricted asset the bearer's caller may not read. An archive with a root `404.html` answers with that page instead"),
      429: {
        ...jsonError("Too many wrong passwords from this client for this asset; wait for `Retry-After`"),
        headers: { ...nosniff, ...corsHeaders, "Retry-After": stringHeader("Seconds until the window rolls over") },
      },
      503: {
        ...jsonError("The asset is password-protected but the deployment has no `SIGNING_SECRET`, or its protection is misconfigured; or the authorization service is unavailable for a restricted read"),
        headers: { ...nosniff, ...corsHeaders, "Retry-After": stringHeader("`5`, when the authorization service is unavailable") },
      },
    },
  }),
  serveRoute,
);

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
  siteHost: boolean;
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
    ...dispositionHeaders(contentType, displayName, opts.siteHost),
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
