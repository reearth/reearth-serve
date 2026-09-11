# ADR-013: Static Site Hosting from Archive Assets

- **Status:** Accepted — Part A implemented; Parts B and C proposed
- **Date:** 2026-09-11
- **Deciders:** @rot1024
- **Related:** ADR-014 (asset access control: `restricted` mode, grants, signed URLs, API keys)

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
| Content types from a `FROM scratch` container | Go's `mime` package had no `/etc/mime.types` to read; fonts, source maps, `.webmanifest`, `.txt`, `.ico` came out as `application/octet-stream`. |
| Sites live under `/files/{id}/` on the API's origin | Root-relative references (`/assets/app.js`, the default output of every bundler) break, and any hosted page runs same-origin with the API and with every other hosted page. |
| Sites have no name and no publish state | An ID-shaped URL is not something a city prints on a poster; the only way to take a site down is to delete the asset. |
| No way to restrict who can view a site | File delivery is URL-as-capability with no request-time check; the "public/private toggle" ROADMAP Phase 2 lists applies to the management API, not to `/files/`. A staging site or an internal dashboard cannot be password-protected. |
| No SPA fallback | Client-side routes (`/files/{id}/about`) 404 on reload. |
| CLI uploads one file | The user zips `dist/` by hand. |

This ADR is in three parts. **Part A** records the delivery semantics that
make an extracted archive behave like a static site; it is implemented.
**Part B** designs site hosts — per-asset origins, user-chosen names,
publish state, previews, custom domains, viewer authentication. **Part C** covers behaviour inside
a site and the tooling around it. B and C are proposed and ordered in
"Follow-ups".

## Decision

## Part A — Delivery semantics (implemented)

### A1. Index file resolution and directory redirects

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

### A2. Cache policy

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
gone from them. The same two policies apply to the site hosts in Part B:
a host that resolves to a fixed version is pinned, a host that follows the
asset is not.

### A3. `ETag`, `If-None-Match`, `Vary`, `HEAD`

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

### A4. Content types and the extractor image

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
   `application/octet-stream`. For extensions only the file knows, the
   value is the distribution's choice, not ours — e.g. `.ico` would be
   `image/vnd.microsoft.icon` there, which is why the table pins
   `image/x-icon` to match the CLI.

The final stage also moves from `scratch` to
`gcr.io/distroless/static-debian12:nonroot`: CA certificates and tzdata
maintained upstream instead of copied from the builder, a non-root UID,
`/tmp`, and a Debian package database that vulnerability scanners can read
(a scan reports "0 findings" rather than "nothing to scan" — relevant to
the procurement conversations in ROADMAP Phase 6). The extractor writes
nothing to local disk, so non-root needs no volume. Image size is ~12.6 MB,
essentially the binary.

## Part B — Site hosts (proposed)

Part B introduces one new concept, the **site host**: a hostname under the
service's wildcard suffix (or a customer's own domain) that serves exactly
one asset's files at `/`. Everything else in this part — IDs, names,
publish state, previews, custom domains — is a rule for how a hostname
resolves to an asset and a version.

### B1. Per-asset origin

Root-relative paths and origin isolation are one problem with one fix:
serve each asset from its own hostname.

```
https://{assetId}.serve.reearth.land/           → /files/{assetId}/
https://{versionId}.serve.reearth.land/         → /files/{versionId}/   (pinned)
```

- **Routing.** A middleware in `core/app.ts` runs before the router. When
  the request's `Host` ends with the configured suffix, it takes the
  leading label, resolves it to an asset (and optionally a version) per
  B2–B4, and rewrites the path to `/files/{id}{path}`. Nothing below the
  middleware changes.
- **Configuration.** `SITE_HOST_SUFFIX` (e.g. `.serve.reearth.land`;
  `.localhost:8787` for local development) names the suffix. Unset
  disables site hosts entirely, so the Node runtime and tests opt in
  explicitly.
- **Zone-side work.** On the `reearth.land` zone: a proxied `*.serve` DNS
  record and a certificate covering `*.serve.reearth.land`. A wildcard on
  the apex certificate covers one level only (`*.reearth.land`), so
  `serve` needs its own Advanced Certificate or Total TLS. One-time
  console/Terraform steps, documented under `docs/deploy`, not in code.
  The one-level limit is also why every host form below is a single
  label — see B4 for the `--` separator that follows from it.
- **Absolute paths resolve.** `/assets/app.js` on `abc.serve.reearth.land`
  is `/files/abc/assets/app.js`. Until this lands, the README instructs
  users to build with a relative base (Vite `base: './'`).
- **Isolation.** Each hosted site is its own origin: a page can read its
  own `localStorage` and nothing else. The API and the future Web UI stay
  on the apex. This removes the standing hazard that any uploaded HTML runs
  same-origin with the management surface — today mitigated only by the
  API using bearer tokens rather than cookies.
- **Nothing but the site on a site host.** The middleware rewrites *every*
  path on a site host into `/files/{id}/…`, so `/api/v1/assets` on a site
  host is looked up as a file named `api/v1/assets` inside the archive and
  404s. Without this rule the API would be reachable from every hosted
  origin and the isolation above would be cosmetic. The same rule keeps
  `/files/{otherId}/…` on a site host from reaching another asset. CORS
  `*` on file responses is unchanged — cross-origin *reads* of public
  files are the product; what isolation removes is same-origin *ambient*
  access.
- **ID hosts are always on.** An ID host exposes exactly what
  `/files/{id}/` already exposes, under the same URL-as-capability model,
  so it has no publish switch. Publish state belongs to names (B3). What
  ID hosts *do* honour is the asset's access mode (B7): a
  password-protected asset is protected on every URL form, or it is not
  protected at all.
- **Upload response** gains a `siteUrl` next to `url`; the CLI prints it
  for archive uploads. IDs are 16 lowercase hex characters and therefore
  valid DNS labels as-is.
- **Cache keys.** Cloudflare caches by full URL, so
  `abc.serve.reearth.land/x` and `serve.reearth.land/files/abc/x` are
  separate entries for the same bytes. Acceptable: the site host is the
  canonical URL once this lands; the path form stays for API clients and
  tiles.

### B2. Named sites: user-chosen subdomains

An ID-shaped host is correct but not printable. A project member names the
site:

```
https://kawasaki-flood-map.serve.reearth.land/   → asset 3f9a1c…
```

**Model.** A `site_hosts` table, one row per hostname. Custom domains (B5)
are the same table, so one resolver serves both.

| column | notes |
|--------|-------|
| `hostname` | primary key, lowercase, full host (`kawasaki-flood-map.serve.reearth.land` or `map.city.example.jp`) |
| `asset_id` | target; nullable only for released rows whose asset is gone (B3) |
| `project_id` | for listing and quota |
| `kind` | `subdomain` \| `custom` |
| `verified_at` | null for `subdomain` (nothing to verify); the TXT check for `custom` (B5) |
| `disabled_at` | non-null ⇒ the name is held but not serving (B3) |
| `previews` | boolean; whether `v{n}--` / `latest--` hosts resolve (B4). Default `false`. |
| `released_at` | set instead of deleting; starts the cooldown (B3) |
| `created_at`, `created_by` | audit |

**Validation** at creation:

- DNS label: 3–63 characters, `[a-z0-9-]`, no leading/trailing hyphen.
  Lowercased on input.
- **No `--` anywhere.** IDNA already forbids it at positions 3–4; B4 uses
  `--` as the preview separator, so it must never appear inside a name.
- **Not ID-shaped.** A name matching `^[0-9a-f]{16}$` is rejected, which is
  what lets the resolver test the ID shape first without ever consulting
  the table (B6).
- **Not reserved.** A static list in code: `www api app admin dashboard
  login auth files static assets cdn mail ftp ns1 ns2 status docs help
  support latest reearth eukarya plateau serve untiled` plus every current
  or planned first-party subdomain. Reserved words are also blocked as
  hyphen-delimited parts (`api-v2`, `login-reearth`) — cheap, and it
  removes the obvious phishing shapes. `latest` is reserved because B4
  gives it meaning; `v` followed by digits is rejected for the same
  reason.
- **Unique** across the table, including released rows inside their
  cooldown.

**Who may.** Project `editor` or above on the asset's project — the same
rule as `asset update`. **Only project assets**: demo-mode assets expire in
an hour and must not hold names. Per-project quota (default 20 hosts) keeps
squatting bounded; raised per plan later.

**Several names per asset** are allowed (a short one and a formal one); one
asset per name is enforced by the primary key. Names point at assets, never
at versions: a name is the moving target, and B4 is how a fixed version is
addressed through it.

### B3. Publish state: enabled, disabled, released

A named site has three states. Claiming a name publishes it; the other two
are the answers to "take it down for a while" and "give the name up".

| State | Row | Response on the host | Name held? |
|-------|-----|----------------------|------------|
| **enabled** | `disabled_at` null | the site | yes |
| **disabled** | `disabled_at` set | `503`, a plain page "This site is temporarily unavailable", `Cache-Control: no-store`, `X-Robots-Tag: noindex` | yes |
| **released** | `released_at` set | `410`, a plain page "This site has moved or been removed", for 30 days; then the row is purged by the cleanup cron and the name is free | for 30 days |

- **Disabled is `503`, not `404`.** A `404` would read as "this name is
  unclaimed"; `503` says "exists, not serving", which is true and does
  not invite a claim.
- **Release is not delete.** The 30-day cooldown closes the classic
  subdomain-takeover path where a stale link on the city's website starts
  serving someone else's content the day after the name is dropped.
- **Renaming is claim-new then release-old.** The old name `410`s rather
  than redirecting: a redirect from a name the project no longer controls
  is exactly the thing being prevented (Alternative I).
- **Asset deletion releases, it does not cascade.** Deleting an asset sets
  `released_at` on each of its names and nulls `asset_id`; the rows live
  out their cooldown and are purged with it. A plain `ON DELETE CASCADE`
  would reopen the takeover window the cooldown exists to close.
- **Whole-asset switch.** Disabling every name of an asset at once is a
  loop over its rows in the CLI (`asset host disable <id> --all`); there is
  no separate asset-level flag, so there is one source of truth.

ID hosts (B1) and the `/files/{id}/` path are unaffected by any of these
states: they are capability URLs and stay reachable while the asset exists.

### B4. Preview hosts: `v{n}--name` and `latest--name`

Netlify's `deploy-preview-12--site.netlify.app` uses `--` because a
wildcard certificate covers one label; a second level
(`v3.site.serve.reearth.land`) would need another certificate per site.
Same constraint here, same answer.

```
kawasaki-flood-map.serve.reearth.land            active version (production)
v3--kawasaki-flood-map.serve.reearth.land        version 3, pinned, immutable
latest--kawasaki-flood-map.serve.reearth.land    newest version, ignoring the active pin
{versionId}.serve.reearth.land                   B1: pinned by ID, unguessable, always on
```

- **Resolution.** Split the label on the first `--`. The right side is the
  name; the left side is `v{n}` (the asset's per-version number, ADR-005)
  or `latest`. Anything else on the left is `404`. Names cannot contain
  `--` (B2), so the split is unambiguous.
- **Cache.** `v{n}--` hosts are pinned (A2: immutable, one year).
  `latest--` and the bare name follow the asset (revalidating).
- **`X-Robots-Tag: noindex`** on every preview response. The production
  name and its previews serve the same pages; only one URL should be
  indexed.
- **Off by default.** Version numbers are sequential, so with previews on,
  `v1--name` shows the public site's history to anyone who guesses. For
  the target segment — a city replacing a map it no longer stands behind —
  that is the wrong default. `previews` is a per-name flag (`asset host
  update <id> <name> --previews on`), and the ID-form hosts (B1) keep
  serving unguessable pinned previews regardless, so turning the flag off
  never blocks the review workflow. Netlify defaults previews on; we
  differ deliberately.
- **Branch/PR previews are out of scope.** Netlify's `deploy-preview-{pr}`
  depends on a Git integration Serve does not have. Versions are the unit
  here, and `v{n}` names them. If labelled versions arrive later (e.g.
  from Re:Earth Flow), `{label}--name` is the natural extension.

### B5. Custom domains

The `custom` kind of `site_hosts`. Differences from `subdomain`:

- **Verification.** A `TXT` record `_reearth-serve-verify.<host>` carrying
  a token issued at registration; `verified_at` is set when the check
  passes, and the host does not resolve before that.
- **Certificate.** Cloudflare for SaaS custom hostnames on Cloudflare; the
  platform's equivalent on other clouds (ADR-012). The customer CNAMEs
  their host to `{name}.serve.reearth.land` or to the SaaS fallback
  origin.
- **No previews.** `v{n}--` has no meaning on a customer's domain; use the
  subdomain form.

Resolution, publish state, quota, release cooldown, API and CLI are
shared with B2–B3.

### B6. Resolution order, API and CLI

The middleware decides in this order, before any I/O:

1. Label matches `^[0-9a-f]{16}$` → asset or version ID (B1). Direct.
2. Label contains `--` → split; right side must be a `subdomain` row,
   left side `v{n}` or `latest` (B4). Requires `previews` on and the row
   enabled.
3. Otherwise → `site_hosts` lookup by full hostname (B2, B5). Apply B3
   state.
4. Miss → `404` with a plain-text body (no JSON error, no listing).

Steps 2–3 are one indexed D1 read each; a KV cache in front
(`host:{hostname}` → row, short TTL) is invalidated on any change to the
row.

**API.**

```
GET    /api/v1/assets/:id/hosts                      list hosts for the asset
POST   /api/v1/assets/:id/hosts   {hostname, kind}   claim (subdomain) / register (custom)
PATCH  /api/v1/assets/:id/hosts/:hostname            {disabled, previews}
DELETE /api/v1/assets/:id/hosts/:hostname            release (starts cooldown)
GET    /api/v1/projects/:id/hosts                    list across the project
```

**CLI.** `asset host add|list|remove <id> [<name>]`, `asset host
disable|enable <id> <name> [--all]`, `asset host update <id> <name>
--previews on|off`; `upload --site --name <slug>` claims in one step and
prints the site URL. Errors are specific: `name is reserved`, `name is
taken`, `name was recently released and is on cooldown until …`, `name
must be 3–63 lowercase letters, digits or hyphens and may not contain
"--"`.

**Event log.** Claim, disable, enable, release and preview toggles are
events (ADR-007) with actor attribution — a name change on a public site
is the kind of thing an audit asks about.

### B7. Viewer authentication: password-protected sites

"Put a password on it, like Basic auth" is the first thing a staging site
or an internal dashboard needs. The requirement has three parts that are
easy to conflate: *who* may view (a shared secret vs. named accounts),
*how the browser proves it* (a challenge vs. a form and a cookie), and
*where the check applies* (one hostname vs. the asset).

**Where: the asset, not the name.** Protection is a property of the asset
(`hosting.access`), enforced by the file handler on every URL form —
`/files/{id}/…`, `{id}.serve…`, `{name}.serve…`, `v{n}--name`, thumbnails.
Protecting only the named host while `/files/{id}/` stays open would be
theatre; the ID is in every `siteUrl` we print. This is the first
request-time access check on file delivery, and it replaces the handler's
"URL-as-capability, do not add access checks" note with: capability by
default, access mode when the asset asks for it.

**Project assets only.** `hosting.access` can be set only on project
assets. Demo-mode assets (anonymous, one-hour TTL) are always `public`:
there is no accountable owner to hold a password, no project to rate
limit against, and nothing that lives long enough to be worth protecting.
The API rejects the field on a demo asset with `400`, and the CLI says
"protection requires a project (`project use <id>`)".

**Modes.**

| `hosting.access` | Who | Proof |
|------------------|-----|-------|
| `public` (default) | anyone with the URL | none |
| `password` | anyone with the shared password | password form → signed cookie (browsers); `Authorization: Basic` (tools) |
| `members` (later) | signed-in members of the asset's project | OIDC login → signed cookie |

**How: a form and a cookie, with Basic accepted as a fallback.** Pure
HTTP Basic is what people ask for by name, and it works in `curl` and in
Cesium's `Resource` headers; but in a browser it means a native dialog
with no branding, no logout, credentials retransmitted on every request,
and `401` pages that cannot be styled. Netlify, Vercel and Cloudflare
Pages all use a password page that sets a cookie. We do both:

1. A browser request without a valid cookie gets a `401` HTML page (a
   minimal branded form, `Cache-Control: no-store`, `X-Robots-Tag:
   noindex`) that `POST`s the password to `/_serve/auth` on the same host.
   On success the response sets the cookie and `303`s back to the
   requested path.
2. A request carrying `Authorization: Basic <any-user>:<password>` is
   accepted without a cookie. The user part is ignored. This is what
   makes `curl`, QGIS, and `file cp` work, and it is why the mode is
   still honestly called "Basic auth" to users.
3. Any request with a valid cookie is served normally.

**Cookie.** `HttpOnly; Secure; SameSite=Lax`, value =
`HMAC(secret, assetId · passwordVersion · exp)`, lifetime 7 days. On a
site host (B1) the cookie is `Path=/` and scoped to that origin — one
site's cookie cannot reach another's. On the path form
(`serve.reearth.land/files/{id}/…`) the cookie is `Path=/files/{id}`; path
scoping is a weaker boundary than origin scoping, which is one more
reason B1 comes first. `passwordVersion` increments on every password
change, so rotating the password logs everyone out without server-side
session state. The HMAC secret is a deployment secret alongside
`INTERNAL_API_SECRET`.

**Password storage.** `hosting.passwordHash` on the asset as PBKDF2-SHA256
(WebCrypto, available on every runtime per ADR-012) with a per-asset salt
and ≥ 600k iterations — checked once per form submit or Basic header, not
per file; the cookie carries the result. The hash is stripped from every
API response.

**Rate limiting.** Failed submits counted per `(assetId, client IP)` in
KV with a 15-minute window; over 10 failures the form answers `429` for
the rest of the window. Shared passwords are low-entropy by nature; the
limiter is what keeps them from being guessable.

**Caching.** Responses from a protected asset carry `private` in
`Cache-Control` (A2 policies otherwise unchanged) so no shared cache
stores them, and `Vary: Cookie, Authorization`. Cloudflare does not cache
Worker responses by default, so this is defence in depth.

**CORS.** `Access-Control-Allow-Origin: *` cannot be combined with
credentials. For protected assets the handler echoes the request's
`Origin` and sets `Access-Control-Allow-Credentials: true`; a viewer
embedding a protected tileset must fetch with `credentials: "include"` (or
send Basic). Public assets keep `*`. This is the one place protection
changes how an asset is consumed, and the API response says so
(`hosting.access` is visible to the caller).

**API and CLI.**

```
PATCH /api/v1/assets/:id   {"hosting": {"access": "password", "password": "…"}}
PATCH /api/v1/assets/:id   {"hosting": {"access": "public"}}
```

`asset protect <id> --password` (prompts; never on the command line),
`asset protect <id> --off`, `upload --site --password`. Changing the mode
or password is an event (ADR-007). Requires `editor` on the project.

**`members` mode** is the real answer for "internal to the city" and is
deferred until the OIDC integration listed open in ROADMAP Phase 2 lands:
the `401` page becomes a redirect into the IdP with the site host as the
return URL, and the cookie is minted after `canAccessAsset` passes. The
cookie, caching and CORS rules are identical, which is why they are
specified here rather than per mode.

**What this does not do.** It does not hide the asset's *existence*: a
protected URL answers `401`, not `404`. It does not protect the
management API, which already has its own checks. And it is not a
substitute for not publishing: a shared password is a speed bump for
staging, not a control for sensitive data.

**Scope boundary.** B7 specifies the *hosting* flavour of file-delivery
access control: a shared password for a site a person opens in a browser.
The general requirement — private datasets consumed by Re:Earth
Visualizer, untiled and CLI pipelines, with member identity or machine
credentials rather than a shared secret — changes the delivery model for
every asset, not just hosted sites, and is deliberately left to a
separate ADR, [ADR-014](./014-asset-access-control.md), whose `restricted` mode
and grants also cover purchasers of sold datasets.
The pieces B7 fixes now — access mode as an asset property enforced on
every URL form, cookie/Basic proof, `private` caching, credentialed CORS
— are written so that ADR can add modes without redesigning the check.

## Part C — Site behaviour and tooling (proposed)

### C1. SPA fallback and `404.html`

An archive asset may opt in via a system-recognised key in `userMeta`,
e.g. `{"hosting": {"spa": true}}`, set at upload or with `asset update`.
When set and an archive lookup misses (and no directory redirect applies),
the handler serves the root `index.html` with status `200` and the HTML
cache policy. Without the flag, a miss checks for a root `404.html` and
serves it with status `404` before falling back to the JSON error.

Opt-in rather than default: a 3D Tiles viewer requesting a missing tile
must see `404`, not a `200` HTML body. `_redirects` (C3) is the more
general mechanism and is not a prerequisite.

### C2. CLI directory upload

`upload <dir>`: when the argument is a directory, the CLI zips it (stored,
not deflated — the extractor transmuxes deflate anyway and the local step
should stay fast) into a temp file and uploads that. `--site` sets
`hosting.spa`; `--name <slug>` claims a name (B6). This is the "one
command from `dist/` to URL" experience.

### C3. `_headers` and `_redirects`

Netlify-style files read from the archive root at extraction time and
stored on the version as `meta.hosting`: `_headers` for per-path response
headers (CSP, `X-Frame-Options`), `_redirects` for path rules. Applied in
the handler; bounded in size and rule count. Rules cannot set
`Cache-Control` or `ETag` (A2/A3 own those) or point outside the asset.

## Alternatives Considered

### Delivery (Part A)

**A. Serve the index at the slash-less directory URL instead of
redirecting.** Simpler, but `href="style.css"` inside `docs/index.html`
served at `/files/x/docs` resolves to `/files/x/style.css`. Every static
host redirects; so do we.

**B. One `Cache-Control` for all file URLs.** Either everything is
immutable (redeploys invisible) or nothing is (pinned version URLs lose the
free CDN caching they deserve). The URL already tells us which case we are
in.

**C. Revalidate everything at asset-ID URLs.** Correct but wasteful for
tile pyramids: a Cesium viewer would issue a conditional request per tile
on every session. Hashed bundler output and tiles are both safe for an
hour; HTML is the one file whose name does not change when its content
does.

**D. Rely on `/etc/mime.types` alone, without the explicit table.** The
file covers more, but its values are whatever the distribution chose and
differ between Alpine, Debian and the macOS table local `go test` reads.
Types Serve documents and tests stay in code; the file is the fallback.

**E. `distroless/base` for the thumbnail container too.** That image needs
libvips and its shared-library tree; copying it into a libc-only base is
fragile for no size win. It stays on `debian:bookworm-slim`.

### Site hosts (Part B)

**F. Rewrite absolute paths in HTML at extraction time.** Fixes
`/assets/app.js` in HTML but not in JS (`import("/chunks/x.js")`), CSS
`url(/fonts/a.woff2)` or fetches of `/data.json`, and leaves every site
same-origin with the API. B1 fixes all of these without touching user
content.

**G. Names as a path prefix (`serve.reearth.land/s/name/`).** No zone
work, but it inherits every problem B1 exists to solve.

**H. Names as the asset ID itself.** Would remove the lookup, but IDs are
storage prefixes, job IDs and capability tokens; making them guessable and
renamable touches every layer. A separate name → ID mapping keeps IDs
opaque and lets one asset carry several names.

**I. Redirect a released name to its successor.** Convenient for renames,
harmful for takeover: whoever holds the old name's target after release
would control where a still-published link lands. Released names `410` for
the cooldown and then disappear.

**J. `404` for a disabled site.** Indistinguishable from an unclaimed name
and an invitation to claim it. `503` says what is true.

**K. Previews on by default (Netlify's choice).** Sequential version
numbers make a public site's history guessable. Off by default; the
unguessable ID-form previews remain for the review workflow.

**L. Second-level preview hosts (`v3.name.serve.reearth.land`).** Needs a
certificate per site. `--` costs nothing.

**N. HTTP Basic auth only.** Works everywhere, but the browser experience
is a native dialog with no branding or logout, and `401` bodies cannot be
styled. Accepted *as well as* the cookie flow, not instead of it.

**O. Protect the named host only, leave `/files/{id}/` open.** The ID is
printed in every upload response and `siteUrl`; protecting one door of
two is no protection. Access is an asset property.

**P. Cloudflare Access / Zero Trust in front of site hosts.** Per-seat
pricing, Cloudflare-only (ADR-012), and it authenticates against an IdP
rather than a shared password — it is the `members` mode by another
route, and it cannot do the `password` mode at all.

**Q. Signed URLs (token in the query string) instead of cookies.** Fine
for one file, unusable for a site: every relative link in the HTML would
need the token appended. Kept in mind for embedding a single protected
file elsewhere.

### Site behaviour (Part C)

**M. Default SPA fallback for every archive.** Breaks the primary use
case: tile viewers and data consumers rely on `404` for missing entries.

## Consequences

### From Part A (now)

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
- The extractor image is non-root and scanner-readable; no runtime change.
- No directory listing, by design.

### From Parts B and C (when built)

- One new table (`site_hosts`), one middleware, one zone-side setup. The
  file handler itself does not change: hosts rewrite into paths it already
  serves.
- The `/files/{id}/` path form remains forever as the API/tile URL; the
  site host becomes the URL people share.
- A hosted page can no longer reach the API or another site's storage
  same-origin. Anything in the future Web UI that assumed same-origin file
  access must use CORS reads instead — which file responses already allow.
- B7 introduces the first request-time access check on file delivery.
  The handler's note that file URLs are pure capabilities becomes
  "capabilities unless the asset sets an access mode"; the check is one
  HMAC verification per request for protected assets and nothing for
  public ones.
- Protected assets lose `Access-Control-Allow-Origin: *`; consumers must
  send credentials. Documented on the asset (`hosting.access`).
- Name governance (reserved list, cooldown, quota) is product surface that
  will need occasional human decisions (a disputed name). The event log
  gives those decisions a record.
- ROADMAP Phase 1 now reflects what exists; Parts B and C are Phase 1.5.

## Follow-ups

1. **B1** per-asset origin — the one change that turns "works with a
   relative base" into "works with any build". Wildcard DNS record and
   certificate on the zone, `SITE_HOST_SUFFIX`, `Host` rewrite middleware
   that serves nothing but files on site hosts.
2. **B2, B3, B6** named sites with publish state — `site_hosts` table,
   validation and reserved list, disable/enable, release cooldown, hosts
   API and `asset host` CLI, event-log entries.
3. **B4** preview hosts — `v{n}--` / `latest--`, `previews` flag,
   `noindex`.
4. **B7** `password` access mode — form + cookie, Basic fallback, PBKDF2
   hash, rate limiter, `private` caching, credentialed CORS. Depends on B1
   for origin-scoped cookies.
5. **C1** SPA fallback / `404.html`; **C2** CLI `upload <dir>`.
6. **B5** custom domains; **C3** `_headers` / `_redirects`.
7. **B7** `members` access mode, once OIDC integration lands.
8. Migrate `S3FileStorage` (when it exists) to return `etag`.
