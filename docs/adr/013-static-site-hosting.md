# ADR-013: Static Site Hosting from Archive Assets

- **Status:** Accepted (§1–§4 implemented; §5–§7 proposed)
- **Date:** 2026-09-11
- **Deciders:** @rot1024

## Context

Municipal and enterprise teams — Serve's highest-priority segment (ROADMAP
"Target Users") — increasingly generate small frontend applications with AI
coding tools: a map viewer around a PLATEAU tileset, a dashboard over a
GeoJSON export, a one-page report. The output is a `dist/` folder of HTML,
JS, CSS and assets. Those teams have nowhere to put it: Netlify, Vercel and
Cloudflare Pages are not on their procurement lists, and standing up a web
server for a static folder is out of proportion to the task.

Serve already does most of the work. An uploaded zip is extracted
(ADR-001, ADR-010, ADR-011) and every entry is served from
`/files/{assetId}/{path}` with CORS `*`, Range support and gzip
passthrough. Re-uploading creates a new version behind the same URL
(ADR-005), and a version ID in the URL addresses a fixed snapshot — a
preview URL for free. Before this ADR the gap to "upload a zip, get a site"
was:

| Gap | Effect |
|-----|--------|
| No index file resolution | `/files/{id}/` was 404; users had to type `/files/{id}/index.html`. ROADMAP Phase 1 claimed this was done. |
| `Cache-Control: max-age=3600, immutable` on every response | A redeploy under the same asset ID was invisible for an hour; nothing revalidated because nothing had an ETag. |
| No `ETag` / `If-None-Match`, no `HEAD` | Every load was a full transfer. |
| Content types from a `FROM scratch` container | Go's `mime` package has no `/etc/mime.types` to read; fonts, source maps, `.webmanifest`, `.txt`, `.ico` came out as `application/octet-stream`. |
| Sites live under `/files/{id}/` on the API's origin | Root-relative references (`/assets/app.js`, the default output of every bundler) break, and any hosted page runs same-origin with the API and with every other hosted page. |
| No SPA fallback | Client-side routes (`/files/{id}/about`) 404 on reload. |
| CLI uploads one file | The user zips `dist/` by hand. |

This ADR records the delivery semantics that make an extracted archive
behave like a static site, the cache policy that makes redeploys visible,
and the design for the remaining items.

## Decision

### 1. Index file resolution and directory redirects

`core/file/handler.ts` accepts `/files/:id`, `/files/:id/` and
`/files/:id/:path{.+}` and maps the path onto storage as follows.

| Request path | Archive asset | Single-file asset |
|--------------|---------------|-------------------|
| empty or trailing `/` | `{dir}index.html` | the uploaded file |
| equals the archive filename | the archive itself | — |
| anything else | the extracted entry at that path | the uploaded file (unchanged: the tail has never been checked) |

When an archive lookup misses and `{path}/index.html` exists, the response
is `301` to `{path}/` (query string preserved). Serving the index directly
at the slash-less URL would make the page's relative links resolve one
directory too high; the redirect is what nginx, Apache and every static
host do.

Resolution runs against the versioned layout first and the pre-ADR-005
legacy layout second, exactly as file lookup did before.

**Directory listing is deliberately not provided.** Hosted sites should not
expose their file tree, and the file list already exists as an API
(`GET /api/v1/assets/:id/files`) for tooling.

### 2. Cache policy

Two kinds of URL reach the same bytes and get different policies
(`core/file/caching.ts`):

| URL | `Cache-Control` | Why |
|-----|-----------------|-----|
| `/files/{versionId}/…` (pinned) | `public, max-age=31536000, immutable` | A version never changes. |
| `/files/{assetId}/…`, `text/html` or `application/xhtml+xml` | `public, max-age=0, must-revalidate` | HTML is the entry point; a redeploy must show on the next load. |
| `/files/{assetId}/…`, anything else | `public, max-age=3600` | Bundlers emit content-hashed filenames, so a stale copy within the hour is harmless; ETag revalidation takes over afterwards. |
| Thumbnails | unchanged (`immutable`, 1 year) | Derived, keyed by version. |

The previous blanket `immutable` was simply wrong for asset-ID URLs —
`immutable` tells browsers to skip revalidation even on reload — and is
gone from them.

### 3. `ETag`, `If-None-Match`, `Vary`, `HEAD`

- `FileStorage.get` now returns the store's ETag (`StoredFile.etag`). R2
  supplies `httpEtag`; the memory adapter its MD5.
- Every file response carries `ETag`. When the stored bytes go out
  untouched (plain files; gzip passthrough) the tag is strong. When the
  Worker decodes gzip on the fly, or slices a range out of the decoded
  stream, the wire bytes differ from the stored bytes and the tag is weak
  (`W/"…"`) — same content, different representation, which is precisely
  what weak tags mean.
- `If-None-Match` is evaluated with weak comparison (RFC 9110 §8.8.3.2)
  before any body work; a hit is `304` with `ETag`, `Cache-Control` and
  `Vary`, and the storage body is cancelled.
- Gzip-stored files send `Vary: Accept-Encoding`, since the representation
  depends on it.
- `HEAD` needs no code: Hono re-dispatches it as `GET` and drops the body,
  so `Content-Length`, `ETag` and `Cache-Control` come back for free. A
  test pins that behaviour.

### 4. Content types for web payloads

The extractor container is `FROM scratch`, so `mime.TypeByExtension` only
knows Go's built-in table (`.html .css .js .mjs .json .svg .wasm .pdf` and a
few image types). `DetectContentType` in `manifest.go` gains explicit
entries for fonts (`woff woff2 ttf otf eot`), `.map`, `.webmanifest`,
`.ico`, `.txt`, `.md`, `.csv`, `.yaml/.yml`, `.xhtml`, `.bmp`, `.apng` and
common media (`mp4 webm mp3 ogg wav`). Text types carry
`charset=utf-8`. Installing a `mime.types` file into the image was rejected:
it is a distro-dependent 2,000-line file whose behaviour would silently
differ between local Go and the container.

### 5. Per-asset origin (proposed)

Root-relative paths and origin isolation are one problem with one fix:
serve each asset from its own hostname.

```
https://{assetId}.serve.reearth.land/           → /files/{assetId}/
https://{versionId}.serve.reearth.land/         → /files/{versionId}/   (pinned preview)
```

- **wrangler**: add `*.serve.reearth.land` as a route (wildcard custom
  hostname on the `reearth.land` zone). Node runtime: `Host`-header
  dispatch, same code.
- **Routing**: a small middleware in `core/app.ts` recognises a hostname of
  the form `{id}.{baseHost}` and rewrites the request path to
  `/files/{id}{path}` before the router runs. Nothing below it changes.
- **Absolute paths** now resolve: `/assets/app.js` on
  `abc.serve.reearth.land` is `/files/abc/assets/app.js`.
- **Isolation**: each hosted site is its own origin. A page can read its own
  `localStorage` and nothing else. The API and the future Web UI stay on the
  apex. This removes the standing hazard that any uploaded HTML runs
  same-origin with the management surface — today mitigated only by the
  API using bearer tokens rather than cookies.
- **Upload response** gains a `siteUrl` next to `url`; the CLI prints it for
  archive uploads.
- IDs are 16 lowercase hex characters, so they are valid DNS labels as-is.

Until this lands, the README instructs users to build with a relative base
(Vite `base: './'`).

### 6. SPA fallback and `404.html` (proposed)

An archive asset may opt in via a system-recognised key in `userMeta`,
e.g. `{"hosting": {"spa": true}}`, set at upload or with
`asset update`. When set and an archive lookup misses (and no directory
redirect applies), the handler serves the root `index.html` with status
`200` and the HTML cache policy. Without the flag, a miss checks for a
root `404.html` and serves it with status `404` before falling back to the
JSON error.

Opt-in rather than default: a 3D Tiles viewer requesting a missing tile
must see `404`, not a 200 HTML body. Reading a Netlify-style `_redirects`
file from the archive is a later, more general mechanism (§7) and is not a
prerequisite.

### 7. CLI directory upload, custom domains, `_headers` / `_redirects` (proposed)

- `upload <dir>`: when the argument is a directory, the CLI zips it (stored,
  not deflated — the extractor transmuxes deflate anyway and the local zip
  step should stay fast) into a temp file and uploads that. A `--site`
  flag sets `hosting.spa`. This is the "one command from `dist/` to URL"
  experience.
- Custom domains: a `domains` table mapping hostname → asset ID, validated
  by a `TXT` record, resolved in the same middleware as §5. Cloudflare for
  SaaS (custom hostnames) issues the certificate.
- `_headers` (per-path CSP, `X-Frame-Options`) and `_redirects` read from
  the archive root at extraction time and stored on the version as
  `meta.hosting`. Applied in the handler; bounded in size and rule count.

## Alternatives Considered

### A. Serve the index at the slash-less directory URL instead of redirecting

Simpler, but `href="style.css"` inside `docs/index.html` served at
`/files/x/docs` resolves to `/files/x/style.css`. Every static host
redirects; so do we.

### B. Keep one `Cache-Control` for all file URLs

Either everything is immutable (redeploys invisible) or nothing is
(pinned version URLs lose the free CDN caching they deserve). The URL
already tells us which case we are in.

### C. Revalidate everything at asset-ID URLs (`max-age=0` for all types)

Correct but wasteful for tile pyramids: a Cesium viewer would issue a
conditional request per tile on every session. Hashed bundler output and
tiles are both safe for an hour; HTML is the one file whose name does not
change when its content does.

### D. Rewrite absolute paths in HTML at extraction time

Fixes `/assets/app.js` in HTML but not in JS (`import("/chunks/x.js")`),
CSS `url(/fonts/a.woff2)`, or fetches of `/data.json`. It also leaves every
site same-origin with the API. §5 fixes all of these without touching
user content.

### E. Default SPA fallback for every archive

Breaks the primary use case: tile viewers and data consumers rely on `404`
for missing entries. Opt-in.

### F. Ship `/etc/mime.types` in the container image

See §4.

## Consequences

- `/files/{id}/` and `/files/{id}/dir/` work; the `dir` → `dir/` redirect
  costs one storage `HEAD` per layout on a miss and nothing on a hit.
- Redeploying under an asset ID is visible on the next page load. Clients
  that cached `immutable` responses under the old policy keep them until
  their hour expires; no migration is needed.
- Every file response is one storage `GET` as before; `304` responses
  still perform that `GET` and cancel the body, because R2's `get` is the
  call that returns metadata and body together. A `HEAD`-first path for
  conditional requests would add a round-trip on every miss and was not
  taken.
- `StoredFile` grows an optional `etag`. Both `FileStorage` adapters set
  it; a future S3 adapter (ADR-012) should map `ETag` through.
- ROADMAP Phase 1 now reflects what exists; the remaining hosting work is
  Phase 1.5.
- No directory listing, by design.

## Follow-ups

1. §5 per-asset origin — the one change that turns "works with a relative
   base" into "works with any build". Needs the wildcard route on the zone
   and a `Host` rewrite middleware.
2. §6 SPA fallback / `404.html`.
3. §7 CLI `upload <dir>`, then custom domains and `_headers` /
   `_redirects`.
4. Migrate `S3FileStorage` (when it exists) to return `etag`.
