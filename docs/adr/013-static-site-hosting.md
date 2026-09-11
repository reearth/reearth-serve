# ADR-013: Static Site Hosting from Archive Assets

- **Status:** Accepted — Parts A–C implemented (B7 `members` deferred)
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

## Part B — Site hosts (B1–B5 implemented; B6 apart from its event log; B7's `password` mode implemented, `members` deferred)

Part B introduces one new concept, the **site host**: a hostname under the
service's wildcard suffix (or a customer's own domain) that serves exactly
one asset's files at `/`. Everything else in this part — IDs, names,
publish state, previews, custom domains — is a rule for how a hostname
resolves to an asset and a version.

### B1. Per-asset origin (implemented)

Root-relative paths and origin isolation are one problem with one fix:
serve each asset from its own hostname.

```
https://{assetId}.serve.reearth.land/           → /files/{assetId}/
https://{versionId}.serve.reearth.land/         → /files/{versionId}/   (pinned)
```

- **Routing.** `core/site/middleware.ts`, registered first in `core/app.ts`
  — before the OIDC and session middlewares and before every route. When
  the request's `Host` ends with the configured suffix, it takes the
  leading label, resolves it to an asset (and optionally a version) per
  B2–B4, and dispatches the request, path rewritten to `/files/{id}{path}`
  and query string intact, into a second Hono instance that carries file
  delivery *and nothing else*. A file-only router rather than a path guard
  on the main app: "no API route can match here" is then a property of the
  router, not a rule to remember when adding a route. The resolver is a
  seam (`SiteHostResolver`) so B2's table lookup and B4's `--` split slot in
  without the middleware growing a branch per host kind. Nothing below it
  changes, except that the file handler adds `X-Robots-Tag: noindex` when a
  site host resolved to a version ID (B4) — it already knows whether the URL
  is pinned, so this costs no second lookup — and the middleware strips the
  `/files/{id}` prefix back out of the directory-redirect `Location` (A1).
  Each runtime entrypoint routes by path before the app sees the request
  (`/api/*` and `/files/*` on both; `/internal/cron` on Node, React Router
  SSR on the Worker), so both also send everything on a site host to the
  app — otherwise the UI would answer at `{assetId}.serve.reearth.land/`.
- **Configuration.** `SITE_HOST_SUFFIX` (e.g. `.serve.reearth.land`;
  `.localhost:8787` for local development) names the suffix, in both
  composition roots. It must start with a dot — without one,
  `notserve.reearth.land` would match a suffix of `serve.reearth.land` —
  and it is compared against the `Host` header verbatim, port included. A
  suffix without the dot fails at startup rather than silently disabling
  the feature. Unset disables site hosts entirely, so the Node runtime and
  tests opt in explicitly. On Cloudflare the variable stays commented out
  in `wrangler.toml` until the zone-side work below is done: a `siteUrl`
  that does not resolve is worse than no `siteUrl`.
- **Anything else on the host is `404`.** A label that is not ID-shaped
  gets `404` with `Content-Type: text/plain`, the body `Not found` and
  `Cache-Control: no-store` — no JSON error (there is no API here) and
  nothing cached, since B2 can make the name resolvable at any moment.
- **No session on a site host.** The OIDC and session middlewares are
  skipped there, as they are for `/api/internal/*`: a hosted page is pure
  file delivery, and minting an anonymous session per page view would burn
  a KV write for an identity nothing reads.
- **Zone-side work.** On the `reearth.land` zone: a proxied `*.serve` DNS
  record, a certificate covering `*.serve.reearth.land`, and a Worker route
  for `*.serve.reearth.land/*` (`routes` in `wrangler.toml` stays
  apex-only, so a half-configured wildcard never serves TLS errors to
  visitors). A wildcard on the apex certificate covers one level only
  (`*.reearth.land`), so `serve` needs its own Advanced Certificate or
  Total TLS. One-time console/Terraform steps, listed in the commented-out
  `SITE_HOST_SUFFIX` block in `wrangler.toml`, not in code. The one-level
  limit is also why every host form below is a single label — see B4 for
  the `--` separator that follows from it.
- **Absolute paths resolve.** `/assets/app.js` on `abc.serve.reearth.land`
  is `/files/abc/assets/app.js`. Where site hosts are not enabled, the
  README still instructs users to build with a relative base (Vite
  `base: './'`).
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
- **Upload response** gains a `siteUrl` next to `url` — only for archive
  assets, and only where `SITE_HOST_SUFFIX` is set; the scheme follows
  `BASE_URL`. The CLI prints it as a second line (`Site: …`), leaving the
  file URL first so existing scripts keep working. IDs are 16 lowercase hex
  characters and therefore valid DNS labels as-is; the resolver requires
  exactly that shape, which is what lets B2 test the ID form before
  touching the table (B6).
- **Cache keys.** Cloudflare caches by full URL, so
  `abc.serve.reearth.land/x` and `serve.reearth.land/files/abc/x` are
  separate entries for the same bytes. Acceptable: the site host is the
  canonical URL once this lands; the path form stays for API clients and
  tiles.

### B2. Named sites: user-chosen subdomains (implemented)

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

**Implementation notes.**

- Migration `0004_add_site_hosts.sql`, the table exactly as above plus an
  index on `released_at` the B3 purge needs. `core/site/repository.ts` is the
  port, `adapters/sql/site-hosts.ts` the SQLite implementation (D1 and
  `node:sqlite` both), `core/site/names.ts` the pure validation, and
  `core/site/usecase.ts` everything that needs the table.
- **Only archives may be named.** The ADR said "project assets"; a name on a
  single-file asset would promise a site that does not exist (B1 already
  withholds `siteUrl` from one), so a non-archive is `400 "names require an
  archive asset"`.
- **Claiming needs `SITE_HOST_SUFFIX`.** Rows store the full host, so with no
  suffix configured there is no host to store: `POST` answers `503 "site
  hosts are not enabled on this server"`. Reading and listing work either
  way, so enabling the feature later does not lose rows.
- **`kind: "custom"` is refused** with `400 "custom domains are not supported
  yet"` until B5.
- The authorization action is `manage-hosts` on the `asset` kind
  (`core/auth/roles.ts`), owner/admin/editor — the bar the ADR names. A
  caller who fails it gets `404`, matching the rest of the asset API rather
  than confirming the asset exists.
- `hostname` is accepted as either the bare label or the full host, and
  reported as the full host.
- Validation order is shape first, then reserved. ID-shaped and `v{n}` names
  report `name is reserved` rather than the format error: they are
  well-formed labels the system has taken for itself.

### B3. Publish state: enabled, disabled, released (implemented)

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

**Implementation notes.**

- All three states are implemented. `DELETE …/hosts/:hostname` sets
  `released_at`, nulls `asset_id` and drops the cache entry; `PATCH
  …/hosts/:hostname {disabled}` sets or clears `disabled_at` and drops the
  same key, so the switch takes effect on the next request rather than when
  the 60 s resolution cache expires.
- **The disabled page also carries `Retry-After: 3600`**, which the table
  above does not list. `no-store` keeps the outage out of caches and
  `noindex` out of indexes, but neither tells a crawler when to come back;
  an hour is long enough to stop it hammering a host whose owner has
  deliberately taken it down.
- **A released name cannot be disabled or enabled: `409`.** It has no asset
  and is living out its cooldown, so the state change would be one nobody
  could observe — and answering `404` would say the name is free, which is
  the one thing release exists not to say. Ownership of a released row is
  judged by its `project_id` (its `asset_id` is null); a released row
  belonging to another project is still a `404`, so the endpoint never
  confirms a name the caller cannot act on.
- **Disable outranks nothing; release outranks disable.** The resolver
  checks `released_at` first, so a name that was disabled and then released
  answers `410`, not `503`.
- The cleanup cron purges released rows past the cooldown
  (`purgeReleasedSiteHosts`, 100 per tick). A claim that arrives after the
  cooldown has run out but before the cron sweeps also purges the stale row,
  so a free name is claimable immediately rather than on the cron's
  schedule.
- **Asset deletion releases.** `deleteAsset` releases the asset's names
  before dropping its row, in one `UPDATE … RETURNING` so a concurrent claim
  cannot slip between a read and a write.
- Releasing frees a slot against the per-project quota immediately, even
  though the row is still held.

### B4. Preview hosts: `v{n}--name` and `latest--name` (implemented)

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

**Implementation notes.**

- **Both forms resolve to a version ID**, not to the asset, so the file
  handler serves exactly those bytes with the layout it already has.
  `v{n}--` is then pinned for free (A2: an ID that is a version's ID is
  immutable). `latest--` is the exception the contract had to grow for:
  the bytes are one version's but the *host* follows the asset, so the
  response must stay revalidatable. `SiteTarget` gained
  `preview?: "pinned" | "latest"`, and the middleware passes it to the
  file router in an internal request header (`x-reearth-site-preview`) —
  the rewritten request is a fresh `Request` dispatched into a separate
  Hono app, so there is no context to carry it on. The middleware deletes
  that header off the incoming request before setting it, or a visitor
  could choose their own cache policy by sending it.
- **`noindex` covers every preview**, `latest--` included, which the
  version-ID host's `pinned && siteHost` rule did not: the condition is now
  `siteHost && (pinned || preview)`.
- **The left side is checked before any I/O.** `v{n}` is
  `^v([1-9][0-9]*)$` — `v0` is not a version (ADR-005 numbers from 1) and
  `v01` would be a second hostname for the same page — and anything that is
  neither that nor `latest` is `404` without touching the table, so a
  made-up left side cannot probe it.
- **A name and its previews share one row, one cache entry and one state.**
  The cached resolution carries `previews`, so `v3--name` costs no read the
  bare name has not already paid for, and the `PATCH` that toggles the flag
  drops the single key both forms are answered from. A disabled name's
  previews are `503` and a released name's `410`, the same as the name.
- **`custom` rows never have previews**, whatever their flag says (B5: `v{n}--`
  has no meaning on a customer's domain). The resolver folds `kind` into the
  cached `previews` value rather than caching the kind separately.
- `VersionStore` gained `findByAssetAndNumber(assetId, n)`; paging
  `findByAssetId` to find version 1 would read every newer version first.

### B5. Custom domains (implemented)

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

**Implementation notes.**

- **Two new ports, both in `core/`** (ADR-012 §2), because both answers are
  platform-specific and neither belongs in the domain:
  - `DnsResolver` (`core/site/dns.ts`), one method, `lookupTxt`. The adapter
    is **DNS-over-HTTPS** (`adapters/doh/dns.ts`, `SITE_DNS_RESOLVER_URL`,
    default `https://cloudflare-dns.com/dns-query`), not `node:dns`: DoH is a
    `fetch` and a JSON body, so the identical implementation runs on Workers
    and on Node, and there is no reason to carry two versions of one lookup.
    `adapters/memory/dns.ts` is the fake.
  - `CustomHostnameProvisioner` (`core/site/provisioner.ts`) — `provision`,
    `status`, `deprovision`. `adapters/cloudflare/custom-hostnames.ts` is
    Cloudflare for SaaS (`POST/GET/DELETE /zones/{zone}/custom_hostnames`,
    `ssl: {method: "http", type: "dv"}`), built **only when both
    `CF_API_TOKEN` and `CF_ZONE_ID` are set**: a half-configured provisioner
    would fail every verification with a 403 that reads to the customer as
    "my DNS is wrong". Otherwise the composition root injects
    `NoopProvisioner`, which reports `active` and says to CNAME at the apex or
    the fallback origin — the truth on a deployment that terminates TLS some
    other way, which the **Node runtime always does**. The token lives only in
    a per-call `Authorization` header and is never logged.
- **HTTP DV, not TXT DV**, for the certificate: by the time issuance starts
  the customer has already pointed their CNAME at us, so the challenge is
  served by the very deployment the certificate is for and there is nothing
  further for them to publish.
- **Migration `0005_site_hosts_verification.sql`** adds `verification_token`
  and `certificate_status` to `site_hosts`. 0004 is applied in production and
  was not edited; SQLite adds a nullable column without rewriting the table.
  `verified_at` was already there from 0004.
- **The apex is now the only host that is never a site.** B1–B4 could
  recognise a site host from the suffix; `map.city.example.jp` cannot be
  recognised from its name at all, so the rule is inverted in both runtime
  entrypoints and in the middleware: `Host` equal to the apex keeps today's
  UI / API split, and **every other host goes to the app**, whose middleware
  does the `site_hosts` lookup. A hostname with no row gets the middleware's
  plain-text 404 rather than the UI — which is the right answer anyway: a
  domain somebody pointed at us must not serve the dashboard. Three hostnames
  count as the apex: the host of `BASE_URL`, the suffix without its leading
  dot (the wildcard's own parent), and loopback (so a local run and the unit
  suite are not site hosts). With no `SITE_HOST_SUFFIX` configured the whole
  rule is off and the old path-based split applies unchanged.
- **The apex must never pay for the lookup**, and a test asserts it with a
  store that throws when read.
- **An unverified `custom` row resolves to nothing — 404, not 503.** Until the
  customer has proved they own the domain, the service must not admit that
  anyone registered it here. The miss is cached like any other (60 s), and
  verification drops the key so the domain comes up at once.
- **Verification is idempotent**: an already-verified row answers `200` and
  refreshes its certificate status, because "is it live yet?" is answered by
  running verify again. **One matching TXT record among the domain's many is
  the proof** — a real domain has SPF and other vendors' records at the same
  name. Attempts are rate limited to 10 per hostname per hour through the
  `KeyValue` port; a fixed-window counter, deliberately minimal, since the
  port has no atomic increment to build anything stronger on.
- **A provider outage never blocks the domain.** The TXT check is what
  verification *means*, so a `provision` that throws stores `pending` and the
  single-row `GET` retries `status` while it is not `active`; a `deprovision`
  that throws is logged and the release proceeds.
- **`POST …/hosts/:hostname/verify`** and **`GET …/hosts/:hostname`** are the
  two new routes; the 409 from verify repeats the record to publish, since the
  caller is standing at their DNS console. The instructions are withheld once
  the row is verified — the token has served its purpose and echoing it back
  on every read would spread a secret for nothing. `verified_at` and
  `certificate_status` are now shown on the row (B6 said `verified_at` stayed
  internal; it is how a custom domain reports whether it resolves, so it had
  to come out). The token itself never appears as a column.
- **`PATCH {previews: true}` on a `custom` row is `400`**, not a silently
  ignored flag: the API would otherwise claim previews are on for hosts that
  will never answer. `{previews: false}` is allowed — it is already the truth.
  B4's resolver already forced `previews` off for `custom` rows.
- **Deviations.** (1) Registering a custom domain still requires
  `SITE_HOST_SUFFIX`, like B2's claim: the suffix is what the "not one of
  ours" check and the CNAME target are derived from, and it is also the switch
  that turns the middleware on at all. (2) Validation is its own rule set
  (`core/site/custom.ts`), not `names.ts`: a label under our suffix is ours to
  reserve words in and `api.city.example.jp` is not. (3) No events —
  `core/` still has no event store, so the verify emit point is an
  `// ADR-007:` comment beside the others.

### B6. Resolution order, API and CLI (implemented apart from the event log)

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

**Implementation notes.**

- The resolver is `core/site/resolver.ts`, composed once in `core/app.ts` and
  handed to B1's `SiteHostResolver` seam. `SiteTarget` grew a discriminant so
  it can say "gone" as well as "found"; a miss stays `null`.
- **Step 2 never falls through to step 3.** A `--` label that does not resolve
  as a preview is a `404`, not a name lookup: without that rule `v3--name`
  would serve the production site whenever the left side were unreadable.
- The cache is the `KeyValue` port (ADR-012 §2), reached through a new
  `cache` dependency — Cloudflare KV on the Worker, the `kv` table on Node.
  Key `host:{hostname}`, 60 s, and **misses are cached too**, so an
  unclaimed name costs no database read per request; every claim and release
  drops the key. A cache that is down or holding junk falls through to the
  table rather than taking the site down.
- **`PATCH …/hosts/:hostname`** takes `{disabled?, previews?}` and requires at
  least one of them: an empty body is a no-op the caller did not mean, so it
  is a `400`. It answers `200 {host, siteUrl}`, the same envelope as `POST`.
  Both switches may be sent in one request.
- CLI: `asset host add|list|remove|disable|enable|update`, with `--json`.
  `asset host list` prints the state (enabled / disabled / released) and
  whether previews are on beside the hostname. `upload --site --name <slug>`
  is C2.
- The API shows a row without `verified_at` (B5) or `created_by`, plus the
  site `url`; `POST` answers `201 { host, siteUrl }`.
- No events: `core/` has no event store yet. The two emit points are marked
  with `// ADR-007:` comments in `core/site/usecase.ts`.

### B7. Viewer authentication: password-protected sites (`password` implemented; `members` deferred)

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

**Implementation notes.**

- **The field is flat `access`, not `hosting.access`.** ADR-014 §1 declares
  the flat field canonical and says the two names are the same field; it is
  implemented as `access` on the asset row and on `AssetMetadata`, with
  `PATCH /api/v1/assets/:id {"access": "password", "password": "…"}`. Nesting
  it under `hosting` would have to be undone when ADR-014's `restricted`
  lands, which applies to assets that are not sites at all.
- **Limited to archive assets for now; general asset protection is deferred
  to ADR-014 by decision on 2026-09-11.** Setting `password` on a single-file
  asset is `400 "protection is available for site (archive) assets only"` —
  the same rule named sites already apply (B2). Unprotecting is always
  allowed, whatever the type. The field and the `resolveAccess` seam are
  general, so lifting the restriction is one condition in
  `core/asset/usecase/set-access.ts`.
- **Project assets only**, as specified: a demo asset is `400 "protection
  requires a project asset"`. Authorization is the existing asset `update`
  action, so `owner`/`admin`/`editor` may protect and a `viewer` may not.
- **`resolveAccess(asset, request, deps)`** lives in `core/access/resolve.ts`
  and is called from `core/file/handler.ts` before any storage I/O, once, for
  every path that serves bytes — files, index resolution, directory
  redirects, thumbnails (`_thumbs/` and `?thumb=`), ranges, `HEAD` — and
  therefore for every host form, since they all end in that handler. `public`
  costs one string comparison on a row already loaded and no extra store
  read; the unit suite asserts that with a counting fake.
- **The browser heuristic.** A request whose `Accept` contains `text/html` is
  treated as a browser navigation: it gets the `401` HTML page and
  *deliberately no* `WWW-Authenticate`, so the browser renders our page
  instead of stacking its native credential dialog on it. Everything else
  gets `401` JSON `{"error":"authentication required"}` with
  `WWW-Authenticate: Basic realm="reearth-serve", charset="UTF-8"`, which is
  what makes `curl -u`, QGIS and `file cp --password` work. It fails in the
  harmless direction: a client that sends `Accept: text/html` sees a form it
  can ignore in favour of Basic.
- **Cookie `rs_site_auth`**, value
  `base64url(assetId · passwordVersion · exp · HMAC-SHA256(secret, the same three))`,
  `HttpOnly; SameSite=Lax; Max-Age` 7 days, `Secure` except on plain-http
  loopback (where a browser would drop it and local development would be
  impossible). `Path=/` on a site host, `Path=/files/{assetId}` on the apex.
- **`POST /_serve/auth`** on a site host, `POST /files/{assetId}/_serve/auth`
  on the apex — the same route, because the site middleware rewrites the
  former into the latter. It is registered ahead of the catch-all and for
  `POST` only, so an archive containing a real file named `_serve/auth`
  cannot shadow it: that file is still served on `GET`, and file lookup never
  sees a `POST`. `next` is honoured only when it is a rooted same-origin path
  (an absolute URL, `//host` and the backslash forms fall back), since an
  open redirect on a password form is the classic phishing primitive. The
  middleware now carries a request body through the rewrite, capped at 64 KB.
- **Which requests are "on a site host"** is read from the context variable
  the composition root sets when it builds the file-only router, never from a
  request header — the same discipline the middleware applies to
  `x-reearth-site-preview`, which it deletes off every incoming request
  before setting it. A visitor cannot claim to be on a site host and move the
  cookie's `Path` to `/`.
- **`SIGNING_SECRET`** is the secret's name — the one ADR-014 §4 reserves for
  signed URLs, so cookie and future signed URLs share one secret and one
  rotation. It is set in both composition roots. Unset, `PATCH` to `password`
  is `503` and a protected asset answers `503 "SIGNING_SECRET not
  configured"` rather than serving its bytes.
- **Password storage.** PBKDF2-SHA256 via WebCrypto, 600 000 iterations,
  16-byte random salt, both base64. The work factor is encoded *inside* the
  stored hash (`pbkdf2-sha256$600000$…`) so it can be raised without a
  migration and old hashes still verify; the unit suite injects a low count
  for speed and therefore exercises the same code path. The hash and salt are
  deliberately **not** on `AssetMetadata` — they are read by their own
  statement, for protected assets only — which makes "never in an API
  response" a property of the store rather than a rule to remember at each
  route. `password_version` starts at 0 and is incremented by the store's own
  statement, so a rotation cannot hand back a version an outstanding cookie
  still names.
- **Rate limiting** counts failures per `(assetId, client IP)` in the
  `KeyValue` port over 15 minutes; the eleventh attempt in a window is `429`
  with `Retry-After`, for the form and for Basic alike, and the check runs
  *before* the PBKDF2. The IP is `CF-Connecting-IP`, else the first hop of
  `X-Forwarded-For`. With neither, all visitors of the asset share one bucket
  with a deliberately looser limit (100), so one anonymous client cannot lock
  a site's form for everyone.
- **The OIDC middleware no longer runs on `/files/*`.** It rejects every
  `Authorization` header that is not a Bearer token with `401`, so `curl -u`
  against a protected asset never reached the file handler. Those requests
  already bypassed it on a site host (B1: a hosted page is pure file
  delivery) and the apex path form should not differ.
- **CORS moved into the handler.** The blanket `cors()` middleware could not
  express a policy that depends on the asset, because it runs before the row
  is read. Public assets keep `Access-Control-Allow-Origin: *`; protected
  ones echo `Origin` with `Access-Control-Allow-Credentials: true` and
  `Vary: Origin`. Preflight is answered without an access check (it carries
  no credentials) but announces the mode's policy, which costs one metadata
  read.
- **Not implemented here:** the ADR-007 event on a mode or password change
  (there is still no event store — same gap as B6). `upload --password`
  landed with C2. `members` mode waits on the OIDC integration as specified.

## Part C — Site behaviour and tooling (implemented)

### C1. SPA fallback and `404.html` (implemented)

An archive asset may opt in via a system-recognised key in `userMeta`,
e.g. `{"hosting": {"spa": true}}`, set at upload or with `asset update`.
When set and an archive lookup misses (and no directory redirect applies),
the handler serves the root `index.html` with status `200` and the HTML
cache policy. Without the flag, a miss checks for a root `404.html` and
serves it with status `404` before falling back to the JSON error.

Opt-in rather than default: a 3D Tiles viewer requesting a missing tile
must see `404`, not a `200` HTML body. `_redirects` (C3) is the more
general mechanism and is not a prerequisite.

**Implementation notes.**

- **The field is a flat `spa` column, not a key in `userMeta`.** The ADR
  proposed `userMeta.hosting.spa`; B7 had already chosen a flat `access`
  column over `hosting.access` and the same argument applies with more
  force here. `userMeta` is **caller-owned**: `PATCH {userMeta}` replaces
  the whole object, so any client that round-trips its own metadata would
  silently turn a system flag off, and nothing in the API contract would
  say it had. Migration `0007_asset_spa.sql` adds
  `spa INTEGER NOT NULL DEFAULT 0`; it surfaces as `spa: boolean` on
  `AssetMetadata` and is set with `PATCH /api/v1/assets/:id {"spa": true}`
  under the asset `update` action — the same authorization as any other
  field of that route. Like `access`, it is carried through
  `ASSET_UPSERT_SQL` by subquery, so a job-status mirror write cannot reset
  it.
- **Archive assets in a project only**, the rule named sites (B2) and
  protection (B7) already apply: `400 "SPA fallback is available for site
  (archive) assets only"` and `400 "SPA fallback requires a project
  asset"`. A single-file asset has no root `index.html` to fall back to,
  and a demo asset that expires in an hour has no owner for a hosting
  decision. **Turning it off is always allowed**, whatever the asset — a
  row must never be stuck with a flag because it fails a check the on-path
  applies. The rule lives in `core/asset/usecase/set-spa.ts`.
- **A refinement of the rule above: file-shaped paths never fall back.**
  A missing path whose last segment matches `\.[a-z0-9]{1,8}$` (`.js`,
  `.json`, `.png`, `.b3dm`, …) keeps its `404` even with the flag on. The
  opt-in alone is not enough, because the *same site* that wants `/about`
  to render also loads hashed chunks and, often, tiles: a `200` HTML body
  in place of a missing chunk fails inside a bundler's loader with a syntax
  error rather than the network error it knows how to report, and a tile
  viewer parses the shell as geometry. Client-side routes are extensionless
  or end in a slash, so nothing the fallback exists for is lost. The check
  is case-insensitive (`/Logo.PNG` is a file too).
- **`404.html` answers with status `404`,** which is why it is *not* subject
  to that refinement: an error page cannot mislead a loader the way a `200`
  can, so a missing `.js` gets the archive's page rather than the JSON
  error. It is sent with `Cache-Control: no-store` and **no `ETag`** — a
  `404` body is not a representation of the URL that was asked for, so
  neither storing it nor revalidating against it is meaningful, and a path
  that does not exist today may exist after the next upload.
- **Order and cost.** Both probes live in the file handler after
  `resolveAccess` (so a protected asset is challenged before any fallback
  is considered — the shell is content too), after the A1 lookup, and after
  the directory-redirect probe (so a real directory still redirects rather
  than rendering the app shell). `spa` is checked *first*, so at most one
  extra storage read happens on a miss: `index.html` **or** `404.html`,
  never both. A hit costs nothing new.
- **The SPA case rejoins the normal serving path** rather than building its
  own response, so gzip passthrough, the `ETag`, `If-None-Match`, the A2
  cache policy (moving at an asset URL, pinned at a version URL) and B4's
  `noindex` on a preview host all come from the code a direct hit on
  `/index.html` already takes. No robots header is added: the shell is the
  app's real content, not a soft error.
- **One implementation covers every host form**, because they all end in
  this handler: `/files/{id}/about`, `{id}.serve…/about`,
  `{name}.serve…/about`. A preview host (`v{n}--`, `latest--`) resolves to
  a version ID, so it falls back to *that* version's `index.html`.
- **Tested in unit, not e2e.** The Node e2e runtime has no extraction
  container (`CONTAINER_LAUNCHER=none`), so no archive there ever has an
  `index.html` inside it to fall back to — which is also why
  `e2e/site-host.test.ts` serves the archive itself. Delivery is therefore
  covered in `core/file/spa.test.ts` against the real app and the real
  handler; `e2e/spa.test.ts` covers what unit tests cannot — the column
  through real SQL, the route's validation rules and the CLI flag.

### C2. CLI directory upload (implemented)

`upload <dir>`: when the argument is a directory, the CLI zips it (stored,
not deflated — the extractor transmuxes deflate anyway and the local step
should stay fast) into a temp file and uploads that. `--site` sets
`hosting.spa`; `--name <slug>` claims a name (B6). This is the "one
command from `dist/` to URL" experience.

**Implementation notes.**

- **The writer is ours** (`cli/zip.ts`, ~250 lines): Node ships no zip, and
  storing rather than deflating makes the format small enough that a
  dependency would cost more than it saves. Local file headers plus a
  central directory, CRC-32 from `zlib.crc32` where the runtime has it
  (Node ≥ 22.2, which is what CI pins) and a 256-entry table otherwise, so
  the command does not depend on a patch version.
- **Each file is read twice** — once for its CRC, once for its bytes. A
  local header carries the CRC *before* the data, and the alternative, a
  trailing data descriptor, asks more of every reader (including the Go
  extractor) for no benefit. Both passes stream in 1 MiB chunks, so peak
  memory is one chunk however large a file is, and the second read is
  served from the page cache.
- **ZIP64 is refused, not attempted.** Past 4 GiB or 65 535 entries the
  command errors with "zip it yourself and upload the zip" rather than
  growing an end-of-central-directory locator for a case this command does
  not exist for. The check runs on declared sizes, before a byte is
  written.
- **Skip list**: `.DS_Store`, `Thumbs.db`, `.git`, `node_modules`, matched
  on the entry's own name at any depth. **Symbolic links are skipped and
  reported**, never followed: a link out of the tree would upload something
  the user did not mean to publish, and a link inside it would be silently
  duplicated. Empty directories are dropped and no directory entries are
  written at all — delivery looks paths up whole. Entries are sorted and
  the DOS timestamp is fixed at the 1980 epoch, so the same directory
  always produces the same bytes.
- **The upload itself is unchanged.** The temp zip goes through the same
  presigned-or-direct path as any other file, so the result is an ordinary
  archive asset that extracts as usual. The temp directory is removed in a
  `finally`.
- **The filename is `<dirname>.zip`**, taken from the *resolved* path, so
  `upload .` names the project directory rather than producing `..zip`.
- **`--site`, `--password` and `--name` run after the upload**, and the
  first two go in **one** `PATCH` — they are one write on the server and
  two requests would leave a half-configured site behind if the second
  failed. All three are project-only (C1, B7, B2), so a demo upload prints
  a note naming the flags and the fix (`project use <id>`) instead of
  relaying a 400 the user cannot act on. The upload is never rolled back
  when a later step fails: the asset exists and its URL works, and deleting
  it because a name was taken would throw away what the user just paid for.
  API errors otherwise pass through verbatim (`name is reserved`, …).
- **`--password` takes no value**, like `asset protect`: a password in
  `argv` is visible in `ps`, in shell history and in CI logs. It prompts
  twice, or reads `REEARTH_SERVE_SITE_PASSWORD` for unattended runs.
- **The flags are registered once** and attached to both `upload` and its
  `asset create` alias, so the alias cannot quietly lack one.
- **`--site` sets the flat `spa` field**, not `hosting.spa` — see C1's
  notes.

### C3. `_headers` and `_redirects` (implemented)

Netlify-style files read from the archive root at extraction time and
stored on the version as `meta.hosting`: `_headers` for per-path response
headers (CSP, `X-Frame-Options`), `_redirects` for path rules. Applied in
the handler; bounded in size and rule count. Rules cannot set
`Cache-Control` or `ETag` (A2/A3 own those) or point outside the asset.

**Implementation notes.**

- **The Worker parses, not the container.** ADR-011's extractor streams
  entries and must keep doing exactly that; teaching it a second file
  format would put a header denylist and a rule-count cap in the one
  process with no idea what a header means. The two files are extracted
  like any other entry — verified: nothing in `worker.go` filters on a
  name, and the root-folder prefix is already stripped by the time an
  entry is written, so they land at the files root — and the Worker reads
  them back from storage in `core/site/hosting.ts` when the internal
  job-status route sees `completed`. That route is the **only** place a
  job becomes `completed` (the Node runtime's only launcher is `none`, and
  the cleanup cron can only fail a job), so the hook has one caller. No Go
  change was needed.
- **Where the rules live.** `hosting` is a key in the existing system
  `meta` JSON column (ADR-005's system/user split), so there is **no
  migration**: `asset_versions.meta` and `assets.meta` already exist and
  `rowToModel` already merges them into the model. It surfaces as
  `version.hosting` rather than `version.meta.hosting` because that is how
  every other system-meta field (`fileCount`, `jobId`, `contentEncoding`)
  already surfaces; the storage location is exactly what the ADR named.
- **Deviation: the asset row is a second home.** A *first* upload creates
  no version row — versions start at the second (`POST /api/v1/assets/:id`)
  — and that first upload is precisely the `upload ./dist` path C3 exists
  for. So the hook writes to the version when the job names one and to the
  asset otherwise, and `hostingFor(asset, version)` reads
  `version.hosting ?? asset.hosting`: the same "versioned first, legacy
  second" order `locate()` already uses for the bytes. The asset-row case
  rides the same atomic write as the status mirror; the version case is a
  second statement immediately after, since `saveJob` carries a job and an
  asset and nothing else.
- **Order in the handler.** After `resolveAccess` — a protected site's
  redirect map must not be probeable without the password — then: the two
  control files answer `404`; forced (`!`) redirects; the A1 lookup; plain
  redirects (Netlify's shadowing semantics: a rule only fires when `from`
  is not a file); the directory-redirect probe; C1's fallbacks. A `200`
  rule is a rewrite and rejoins the normal lookup, guarded to **one**
  rewrite so a pair of rules cannot loop. `/* /index.html 200` is
  therefore equivalent to C1's `spa` flag, and the two coexist.
- **Handler wins, by construction.** Rule headers are applied to the
  response the moment it is built, *before* the handler sets
  `X-Robots-Tag`, `Vary` and CORS — so anything delivery decides overwrites
  a rule that tried to decide it too. Everything already on the response by
  then (`Cache-Control`, `ETag`, `Content-Type`, the framing headers) is on
  the parser's denylist, along with `Set-Cookie`, `WWW-Authenticate` and
  the whole `access-control-*` family (B7 owns CORS). `X-Robots-Tag` is
  deliberately *allowed*: a production site may set its own robots policy,
  and a preview host still wins because `noindex` goes on afterwards.
  `Content-Type` is denied too — the extractor assigned it from the entry's
  name (A4) and a rule that disagreed would make the same bytes mean two
  things.
- **Redirect targets are internal only.** Netlify allows an external
  target because the name belongs to the site's owner either way; here a
  site lives under `serve.reearth.land`, and letting an uploaded zip bounce
  visitors off that name is a phishing primitive. `to` must be a rooted
  path, not `//host`, no scheme, no backslash. A deliberate limit — if
  external redirects are ever wanted they need a per-site opt-in, not a
  line in a file anyone with upload rights can write.
- **Caps.** 64 KB per file, 100 header rules, 20 headers per rule, 2 KB per
  value, 500 redirect rules, 256 KB of stored JSON. Exceeding a *size or
  count* cap ignores the whole file with one warning — a half-applied rule
  set is worse than none, because the author cannot tell which half
  survived. A single bad or denied line only costs that line. Every warning
  is stored alongside the rules and is visible in
  `GET /api/v1/assets/:id/versions/:vid` and in `asset version show`
  (`Hosting: n header rule(s), m redirect rule(s)` plus one line per
  warning) — a refused rule is invisible on the site itself, so this is the
  only place it can be noticed.
- **Responses that do not get rule headers:** the B7 auth page, the JSON
  `404`, and the `410`/`503` site pages (which the middleware answers
  before the handler runs). The C1 `index.html` fallback and the archive's
  `404.html` *do* get them — they are the site's own content — and they are
  matched against the path the visitor asked for, not the file that was
  read, so a rule written for `/about` applies when `/about` is answered by
  the shell.
- **Tested in unit, not e2e**, for C1's reason: the Node e2e runtime has no
  extraction container, so no archive there can contain a control file.
  `core/site/rules.test.ts` covers the two grammars and every rejection,
  `core/file/site-rules.test.ts` the delivery path against the real app,
  and `core/site/hosting.test.ts` the completion hook through the real
  internal route. No e2e was added: a version cannot be created with `meta`
  directly, so there is nothing an e2e could set up that the unit suite
  does not already exercise.

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

1. ~~**B1** per-asset origin~~ — done: `SITE_HOST_SUFFIX`, the `Host`
   rewrite middleware that serves nothing but files on site hosts, and
   `siteUrl` on archive uploads. Remaining and deliberately outside the
   code: the wildcard DNS record, the certificate and the Worker route on
   the zone, after which the variable is uncommented in `wrangler.toml`.
2. ~~**B2, B3** named sites with publish state~~ — done: `site_hosts`
   table, validation and reserved list, disable/enable, release cooldown,
   hosts API and `asset host` CLI. **B6** is done apart from the `--`
   preview branch (B4) and the event-log entries, which wait on an event
   store (ADR-007); the emit points are marked in `core/site/usecase.ts`.
3. ~~**B4** preview hosts~~ — done: `v{n}--` / `latest--`, the per-name
   `previews` flag (off by default), `noindex` on every preview.
4. **B7** `password` access mode — form + cookie, Basic fallback, PBKDF2
   hash, rate limiter, `private` caching, credentialed CORS. Depends on B1
   for origin-scoped cookies.
5. ~~**C1** SPA fallback / `404.html`~~ — done: a flat `spa` column
   (`0007_asset_spa.sql`), the extensionless-miss rule, the root `404.html`
   with `no-store`, and `asset update --spa on|off`. ~~**C2** CLI
   `upload <dir>`~~ — done: a dependency-free stored-zip writer
   (`cli/zip.ts`), the skip list, symlinks skipped, ZIP64 refused, and
   `--site` / `--name` / `--password` applied after the upload.
6. ~~**B5** custom domains~~ — done. ~~**C3** `_headers` / `_redirects`~~ —
   done: Worker-side parsing at job completion, `meta.hosting` on the
   version (or the asset, for a one-version site), the header denylist,
   internal-only redirect targets, `200` rewrites and `!` forcing, the
   caps, and warnings surfaced in the version API and the CLI. No
   migration.
7. **B7** `members` access mode, once OIDC integration lands.
8. Migrate `S3FileStorage` (when it exists) to return `etag`.
