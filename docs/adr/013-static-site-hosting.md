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

The extractor container used to be `FROM scratch`, so `mime.TypeByExtension`
only knew Go's built-in table (`.html .css .js .mjs .json .svg .wasm .pdf`
and a few image types). Two layers fix that:

1. **Explicit table.** `DetectContentType` in `manifest.go` gains entries
   for fonts (`woff woff2 ttf otf eot`), `.map`, `.webmanifest`, `.ico`,
   `.txt`, `.md`, `.csv`, `.yaml/.yml`, `.xhtml`, `.bmp`, `.apng` and common
   media (`mp4 webm mp3 ogg wav`). Text types carry `charset=utf-8`. This
   table is the source of truth for every type Serve promises, and the
   unit test pins it; it is consulted before any system table.
2. **`/etc/mime.types` in the image.** The builder installs Alpine's
   `mailcap` package and the final stage copies its `mime.types`
   (~2,300 lines). Go's `mime` package reads it lazily on first use, so
   the long tail (`.ktx2`, `.glsl`, `.epub`, …) resolves without growing
   the table. Extensions in neither the table nor the file remain
   `application/octet-stream`. Note that for extensions only the file
   knows, the value is the distribution's choice, not ours — e.g. `.ico`
   would be `image/vnd.microsoft.icon` there, which is why the table pins
   `image/x-icon` to match the CLI.

The final stage also moves from `scratch` to
`gcr.io/distroless/static-debian12:nonroot`: CA certificates and tzdata
maintained upstream instead of copied from the builder, a non-root UID,
`/tmp`, and a Debian package database that vulnerability scanners can read
(a scan reports "0 findings" rather than "nothing to scan" — relevant to
the procurement conversations in ROADMAP Phase 6). The extractor writes
nothing to local disk, so non-root needs no volume. Image size is ~12.6 MB,
essentially the binary.

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

**Zone-side work.** The wildcard is not only a `wrangler.toml` line. On the
`reearth.land` zone: a `*.serve` DNS record (proxied) and a certificate
that covers `*.serve.reearth.land` — a wildcard on the apex certificate
covers only one level (`*.reearth.land`), so `serve` needs its own
Advanced Certificate or Total TLS. Both are one-time console/Terraform
steps and belong in `docs/deploy`, not in code. Locally and on the Node
runtime, `SITE_HOST_SUFFIX` (e.g. `.serve.reearth.land`, or
`.localhost:8787` for `lvh.me`-style dev) configures the suffix the
middleware strips; unset disables site hosts entirely.

**Nothing but the site on a site host.** A site host answers file delivery
and nothing else. The middleware rewrites *every* path on
`{id}.serve.reearth.land` into `/files/{id}/…`, so `/api/v1/assets` on a
site host is looked up as a file named `api/v1/assets` inside the archive
and 404s. Without this rule the API would be reachable from every hosted
origin, and the isolation in the previous bullet would be cosmetic. The
same rule keeps `/files/{otherId}/…` on a site host from reaching another
asset. CORS `*` on file responses is unchanged — cross-origin *reads* of
public files are the product; what isolation removes is same-origin
*ambient* access.

**Cache keys.** Cloudflare caches by full URL, so `abc.serve.reearth.land/x`
and `serve.reearth.land/files/abc/x` are separate cache entries for the
same bytes. Acceptable: the site host is the canonical URL once this
lands, and the path form stays for API clients and tiles.

Until this lands, the README instructs users to build with a relative base
(Vite `base: './'`).

### 5b. User-chosen subdomains (proposed)

An ID-shaped host (`3f9a1c…serve.reearth.land`) is correct but not
something a municipality prints on a poster. Let a project member name the
site:

```
https://kawasaki-flood-map.serve.reearth.land/   → asset 3f9a1c…
```

**Model.** A `site_hosts` table, one row per hostname, generalising the
custom-domain idea in §7 so both share one resolver:

| column | notes |
|--------|-------|
| `hostname` | primary key, lowercase, full host (`kawasaki-flood-map.serve.reearth.land` or `map.city.example.jp`) |
| `asset_id` | target; `ON DELETE CASCADE` |
| `project_id` | for listing and quota |
| `kind` | `subdomain` \| `custom` |
| `verified_at` | null for `subdomain` (nothing to verify); the TXT check for `custom` |
| `created_at`, `created_by` | audit |
| `released_at` | set instead of deleting; see reuse below |

**Resolution.** The middleware takes the host label (or the full host for
`custom`) and decides in this order, before any I/O:

1. Label matches `^[0-9a-f]{16}$` → asset or version ID. Direct.
2. Otherwise → `site_hosts` lookup. Hit → rewrite to `/files/{asset_id}/…`.
3. Miss → 404 with a plain-text body (no JSON error, no listing).

Step 1 before step 2 means slugs and IDs can never collide: slugs are
forbidden from matching the ID pattern at creation time (a 16-character
lowercase hex slug is rejected). The lookup is one indexed D1 read per
request; put a KV cache in front (`host:{hostname}` → asset ID, short TTL)
and delete the entry on any change to the row. Version IDs are never
sluggable — a slug names the moving target (the asset), not a snapshot.

**Validation** at creation:

- DNS label: 3–63 characters, `[a-z0-9-]`, no leading/trailing hyphen, no
  `--` at positions 3–4 (reserved for IDNA `xn--`). Lowercased on input.
- Not ID-shaped (above).
- Not reserved. A static list in code: `www api app admin dashboard
  login auth files static assets cdn mail ftp ns1 ns2 status docs help
  support reearth eukarya plateau serve untiled` and every current or
  planned first-party subdomain. Reserved words are also blocked as
  prefixes/suffixes with a hyphen (`api-v2`, `login-reearth`) — cheap, and
  it removes the obvious phishing shapes.
- Unique across the table, including released rows inside their cooldown.

**Who may.** Project `editor` or above on the asset's project (same rule
as `asset update`). **Only project assets**: demo-mode assets expire in an
hour and must not hold names. Per-project quota (default 20 hosts) to keep
squatting bounded; raise per plan later.

**Reuse and takeover.** Releasing a slug does not delete the row; it sets
`released_at`. For 30 days the name resolves to a 410 page ("this site has
moved or been removed") and cannot be claimed by another project. After
that the row is purged by the cleanup cron and the name is free. This
closes the classic subdomain-takeover path where a stale link on the
city's website starts serving someone else's content the day after the
name is dropped. Renaming an asset's slug is "create new, release old" —
the old name 410s rather than redirecting, because a redirect from a name
the project no longer controls is exactly the thing we are preventing.

**Multiple names per asset** are allowed (a short one and a formal one);
one asset per name is enforced by the primary key.

**API.**

```
GET    /api/v1/assets/:id/hosts               list hosts for the asset
POST   /api/v1/assets/:id/hosts   {hostname}  claim (subdomain) / register (custom)
DELETE /api/v1/assets/:id/hosts/:hostname     release
GET    /api/v1/projects/:id/hosts             list across the project
```

CLI: `asset host add <id> <name>`, `asset host list <id>`,
`asset host remove <id> <name>`; `upload --site --name <slug>` claims in one
step and prints the site URL. Errors are specific: `name is reserved`,
`name is taken`, `name was recently released and is on cooldown until …`,
`name must be 3–63 lowercase letters, digits or hyphens`.

**Event log.** Host claim/release are events (ADR-007) with actor
attribution — a name change on a public site is the kind of thing an
audit asks about.

**Custom domains (§7) become the `custom` kind of the same table.** The
only differences are the verification step (TXT record
`_reearth-serve-verify.<host>` containing a token) and certificate
issuance (Cloudflare for SaaS custom hostnames, or the platform's
equivalent on other clouds per ADR-012). Resolution, quota, release
cooldown and API are shared.

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
- Custom domains: the `custom` kind of the `site_hosts` table in §5b —
  same resolver, plus TXT verification and a Cloudflare for SaaS custom
  hostname for the certificate.
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

### F. Rely on `/etc/mime.types` alone, without the explicit table

The file covers more, but its values are whatever the distribution chose
and differ between Alpine, Debian and the macOS table local `go test`
reads. Types Serve documents and tests stay in code; the file is the
fallback. See §4.

### G. Slugs as a path prefix (`serve.reearth.land/s/kawasaki-flood-map/`)

No zone work, but it inherits every problem §5 exists to solve: absolute
paths break and every site is same-origin with the API. Rejected.

### H. Slugs as the asset ID itself (user-chosen IDs)

Would remove the lookup, but IDs are used as storage prefixes, job IDs and
capability tokens (URL-as-capability); making them guessable and renamable
touches every layer. A separate name → ID mapping keeps IDs opaque and
lets one asset carry several names.

### I. Redirect a released slug to its successor

Convenient for renames, harmful for takeover: whoever holds the old name's
target after release would control where a still-published link lands.
Released names 410 for the cooldown and then disappear.

### J. `distroless/base` for the thumbnail container too

That image needs libvips and its shared-library tree; copying it into a
libc-only base is fragile for no size win. It stays on
`debian:bookworm-slim`.

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
   base" into "works with any build". Needs the wildcard DNS record and
   certificate on the zone, `SITE_HOST_SUFFIX`, and a `Host` rewrite
   middleware that serves nothing but files on site hosts.
2. §5b user-chosen subdomains — `site_hosts` table, reserved list,
   release cooldown, `asset host` CLI.
3. §6 SPA fallback / `404.html`.
4. §7 CLI `upload <dir>`, then custom domains as the `custom` kind of
   `site_hosts`, and `_headers` / `_redirects`.
5. Migrate `S3FileStorage` (when it exists) to return `etag`.
