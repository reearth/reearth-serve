# ADR-014: Asset Access Control for File Delivery

- **Status:** Accepted (amended 2026-11-09)
- **Date:** 2026-09-11 (revised 2026-11-06)
- **Deciders:** @rot1024, @pyshx
- **Related:** [ADR-002](002-auth-sessions-projects.md) (auth, sessions,
  projects), ADR-007 (events, webhooks), [ADR-012](012-multi-cloud-portability.md)
  (ports), ADR-013 B1 and B7 (site hosts, password-protected sites),
  ADR-016 (accounts authorization)

## Amendment 2026-11-09: Mint and read details

Settles what the restricted read and the mint route left open, folded into
§1, §4, §5, §6 and Consequences: the mint route's ID, check order, CORS
and `expiresAt`; the prefix rule; token and bearer order; the challenge on
site hosts; two-deploy key rotation; and a client contract.

## Context

File delivery (`/files/{id}/…`) is URL-as-capability: knowing an asset ID
grants download, and nothing is checked at request time. ROADMAP Phase 2
calls this "file-layer access control (URL visibility)", and it has served
the public-data use case well: PLATEAU tilesets, open GeoJSON, hosted
sites anyone may open. Three demands now need something stronger, and they
are one problem wearing three coats:

1. **Private datasets.** A project uploads data that only its members, its
   viewer scenes and its pipelines may read. Today the only protection is
   that the ID is unguessable, which stops working the moment a URL is
   pasted into a ticket.
2. **Password-protected sites.** A staging build or an internal dashboard
   behind a shared password. ADR-013 B7 designs this for browsers and
   leaves the general mechanism to this ADR.
3. **Data sales.** Partner companies want to sell datasets: a purchaser,
   who is not a member of the seller's workspace, is granted access to
   specific assets for a period and loses it on refund or expiry. The
   seller's storefront is theirs; Serve must offer the grant, the proof,
   the revocation and the audit trail.

The common shape: an asset carries an **access mode**; a request carries a
**proof**; the handler decides. What differs is *who* may be granted
(members, arbitrary accounts, machines) and *how they prove it* (login,
key, signed link, cookie). ADR-013 B7 already fixed the parts that must
be identical for every mode: access as an asset property enforced on
every URL form, `private` caching, and CORS by proof (§8).

Browser clients cannot attach a cookie across origins, and an `<img>` or
a tile loader cannot set `Authorization`. Two client libraries settle how
a link proof has to travel:

- CesiumJS copies a resource's query parameters and headers to every
  3D Tiles child request, including external tilesets and implicit tiling.
- MapLibre's `transformRequest` does not reach PMTiles Range reads, but
  the PMTiles source keeps the URL query on every Range request.

So a token must work in the query string and in a header, and it must
cover a path prefix, not one file.

This ADR decides demand 1 for project members: the `restricted` mode and
signed URLs. Grants to non-members, machine credentials and the storefront
flow for demand 3 wait for a later ADR; Follow-ups keep their outline.

What Serve is **not** becoming: a store. No catalogue, no pricing, no
payment. A partner sells; Serve enforces what was sold.

## Decision

### 1. Access modes

`access` on the asset (the `hosting.access` field of ADR-013 B7 is this
field; B7 names it from the hosting side):

> **Implemented since ADR-013 B7:** the flat `access` field exists on the
> asset row and the API with `public` and `password`; `restricted` is still
> this ADR's to add. Setting `password` is currently limited to archive
> (site) assets; general asset protection is this ADR's work.

| Mode | Who may read | Proof accepted |
|------|--------------|----------------|
| `public` (default) | anyone with the URL | none |
| `password` | anyone with the shared password | cookie or `Authorization: Basic` (ADR-013 B7) |
| `restricted` | project members who hold `read_asset` under ADR-016's policy | delivery token (§4) or OIDC bearer |

Modes are exclusive. `password` is kept as its own mode rather than
modelled as "a grant to whoever knows a secret" because its proof, threat
model and audience are different and the simpler UI matters to the
hosting use case.

Mode is settable on **project assets only**: `PATCH /api/v1/assets/:id`
refuses `restricted` elsewhere. `restricted` applies to single files and
archives; `password` stays limited to archives (ADR-013 B7). Demo-mode
assets are always `public` (no owner, no project, one-hour TTL). Changing
the mode is an `asset.access.changed` event once the event log (ADR-007)
exists.

**Derived assets** (ADR-006) default to the most restrictive mode among
their sources at creation and record that they inherited it; an explicit
override is allowed and logged. This waits for derived assets (ADR-006).
Thumbnails always follow their asset.

### 2. Grants (deferred)

Member-only delivery needs no grant table. Grants to non-members wait for
a later ADR (Follow-up 3).

### 3. Machine credentials (deferred)

API keys wait for a later ADR (Follow-up 4). ADR-016's service identity
covers machine callers that hold an OIDC client.

### 4. Signed URLs: proof inside the link

For a browser page or a Cesium scene that must load a restricted tileset,
neither a cookie (wrong origin) nor a bearer header (not settable on
`<img>`/`<script>`, awkward for tile requests) fits. A **delivery token**
carries the proof in the link.

**Format.** `base64url(JSON claims) "." base64url(mac)`, with claims
`{ v: 1, kid, assetId, versionId, prefix, exp }`. `versionId` is `null`
for a token that follows the active version, or a version ID that pins
it. `prefix` is a decoded path inside the asset with no leading slash; the
empty prefix covers the whole asset. `exp` is Unix seconds. Both parts are
canonical unpadded base64url and the claims are valid UTF-8, so a token
has one valid string form. The MAC input is the label `serve-delivery-v1`,
a newline, and the encoded claims. The access cookie has its own label
(§8), so no other MAC Serve computes passes as a token.

**Codec.** `core/access/token.ts` defines the `DeliveryTokenCodec` port
with `sign(claims)` and `verify(token, now)`. `verify` returns the claims
or the first failing reason, in the order `malformed`, `unknown_kid`,
`bad_signature`, `expired`, so `expired` is reported only for an
authentic token. A WebCrypto adapter implements it with HMAC-SHA256 and
imports keys once per isolate; the composition roots supply the keys
(ADR-012 §1). HMAC verifies in about 2 µs on local workerd and 10 µs on
Node, against 40 µs and 108 µs for Ed25519, and Serve is the only
verifier.

**Keys.** `DELIVERY_TOKEN_KEYS` holds the ring as JSON:

```json
{"active":"k2","keys":{"k1":"<base64 secret>","k2":"<base64 secret>"}}
```

Both composition roots parse it with one shared parser into
`{ active, inactive | null }`, so a third key cannot be represented. The
parser rejects malformed JSON, a secret shorter than 32 bytes, more than
two keys, and an `active` ID missing from `keys`, each with a message that
starts `DELIVERY_TOKEN_KEYS: `. A rejected ring is a config error under
ADR-016 decision 8, so the change that adds the ring also makes the
Worker catch a `buildDeps` throw. The codec signs with the active key and
verifies with either. To rotate, add the new key as the inactive one and
deploy, then make it active and deploy, wait the longest token life, and
remove the old key. The first deploy lets every instance verify the new
key before any instance signs with it. The cookie secret is separate,
so tokens rotate without logging out password visitors.

**Lifetime.** `expiresIn` is 60 to 604,800 seconds, 3,600 by default. The
codec refuses to sign an `exp` more than 7 days ahead; exactly 7 days is
allowed. `verify` accepts a token while `now - exp <= 30`, to absorb clock
skew between the isolate that mints and the one that reads.

**Paths.** `parseAssetPath(rawPathname)` turns the part of the request
path after `/files/<id>/` into the asset path, or null to refuse it. Its
input is the raw, still-encoded path from `new URL(request.url).pathname`,
never `c.req.param("path")`: Hono already decodes a path parameter once,
and decoding again would turn `a%252Fb` into `a/b`.

- Each run of `%XX` escapes decodes once with `decodeURIComponent`, and a
  run that is not valid UTF-8 is refused. A `%` that two hex digits do not
  follow stays literal, so `100%.png` and `100%25.png` both mean
  `100%.png`.
- `.` and `..` segments, backslashes, NUL, and any `%2F` left after
  decoding are refused. `a%2Fb` becomes `a/b`; `a%252Fb` is refused.
- Empty segments stay. `a//b` names a different storage key from `a/b`.
- The leading slash is stripped; the empty path is the whole asset.

The storage key is built from this output, so the token match and the
storage read use the same string. The mint route normalizes `prefix` with
the same segment rules.

**Off by default.** With `DELIVERY_TOKEN_KEYS` unset,
`Deps.deliveryTokens` is `null` and the mint route answers `501`.

**Mint.** `POST /api/v1/assets/{id}/signed-urls` with
`{ prefix?, versionId?, expiresIn? }`. `id` is an asset ID or a version
ID, resolved the way `/files/{id}` resolves it, so a client can mint with
whatever ID its URL holds. A version ID pins the token, and a body
`versionId` must then be absent or the same ID.

The route answers the first failing check, in this order:

1. No codec is `501`.
2. A body that fails validation is `400`. `expiresIn` must be an integer.
3. A caller without `read_asset` on the asset is `404` through
   `deniedResponse`, the same answer as a missing ID.
4. A `password` asset is `400`.
5. A `versionId` that is not a version of the asset is `400`.

Public and restricted assets mint, so a token minted before a switch to
`restricted` works after it. The response is
`{ token, expiresAt, urlTemplate }`. `expiresAt` is Unix milliseconds,
like every timestamp in the API, and equals `exp` times 1000.
`urlTemplate` is `<BASE_URL>/files/<id>/{path}?serve_token=<token>`, with
the version ID in place of the asset ID when the token is pinned. `{path}`
stands for the whole path inside the asset, prefix included, with each
segment percent-encoded as in any `/files` URL.

`prefix` is a decoded path, never percent-encoded. One leading `/` is
stripped. A `.` or `..` segment, a backslash or NUL is `400`. Empty
segments and a trailing `/` stay as sent, and the token stores the
result.

Every response from the route, middleware errors included, carries
`Access-Control-Allow-Origin: *`, no credentials header, and
`Access-Control-Expose-Headers: Retry-After`. Its preflight is answered
before auth and allows `POST`, `authorization` and `content-type`. The
proof is a bearer the caller attaches, so no origin gains anything a
cookie would give it.

**Carry.** The query parameter `serve_token` or the header
`X-Serve-Token`. The query form needs no preflight and works with Cesium
`queryParameters` and PMTiles URLs; the header form keeps the token out of
URLs and logs. Serve reads them on `restricted` assets only. Every
non-empty `serve_token` value and the header count, and more than one
distinct value is `400` with `no-store`. An empty header counts as
absent. `Authorization` never carries a
delivery token.

```http
GET /files/01hx/tiles/3/4/5.b3dm HTTP/1.1
Host: assets.example.com
X-Serve-Token: <token>
```

**Match.** Serve allows the read when the token verifies, `assetId`
matches, `versionId` is `null` or equals the resolved version, and
`prefix` covers the parsed path. A `null` version covers every version of
the asset at any URL form; deleting a version is how its bytes stop being
served. A prefix covers a path when the prefix is empty, when the path
equals it, when the prefix ends in `/` and the path starts with it, or
when the path starts with the prefix plus `/`. So `tiles` covers `tiles`
and `tiles/a`, `tiles/` covers `tiles/a` and `tiles/` but not `tiles`, and
neither covers `tiles-old/a`.

The match uses the request path. Both thumbnail forms map to the asset's
filename first. A single-file asset is matched on the request path too,
though it serves the same bytes at any path. A `_redirects` rewrite, the
SPA fallback and `404.html` serve what the site maps under a covered
path, so a rewrite rule opens its target to tokens for its source.

A token that fails `verify`, for any reason, or names another asset counts
as no token, and Serve goes on to the bearer. A verified token for this
asset with the wrong version or an uncovered path does not decide either.
When the request carries a bearer, the bearer's answer stands (§5).
Without one, Serve answers `403` with `no-store`. That status is not a
`deniedResponse` denial: the holder already knows the asset exists. Tokens
open `restricted` assets only; Serve ignores and strips a token on a
public or `password` asset.

**Response.** `Access-Control-Allow-Origin: *` with no credentials
header, `Cache-Control: private` with a `max-age` no longer than the
token's remaining life (`immutable` only at a version-ID URL),
`Referrer-Policy: no-referrer`, and `X-Serve-Token` added to `Vary`.
Redirects and misses on a restricted asset are `no-store`. Serve strips
`serve_token` from the query before any other use, except that the
redirects it builds inside the asset (the directory redirect and
`_redirects`) keep it, with a path-only `Location`. Serve's own logs
redact it. The OpenAPI document
declares `serve_token` and `X-Serve-Token` as `apiKey` security schemes
on `/files`.

**Names.** Wire names, env vars, errors and examples name no product
host: `serve_token`, `X-Serve-Token`, `ServeToken`, `serve_access`.
Examples use `example.com` hosts, and `.test` hosts for local setups.

**Clients.** This section and §5 are the whole delivery protocol. A client
mints with the empty prefix unless it knows a narrower one. It mints again
before `expiresAt`, or once after a `401` whose challenge names
`ServeToken`, and passes a second `401` through. It treats a `403` as
final. From the mint route, `501` means tokens are off, `404` means no
access, `401` means the bearer needs renewing, and `503` means retry after
`Retry-After`. It parses
`WWW-Authenticate` as an RFC 9110 challenge list, compares scheme names
without case, and accepts parameters and schemes Serve may add. A `401`
names no asset ID, so on a named site host only a client that already
knows the ID can mint.

### 5. Enforcement in the file handler

One function, `resolveAccess(asset, request)`, before any storage I/O:

> **Implemented since ADR-013 B7:** `resolveAccess` exists in
> `core/access/resolve.ts`, is called from the file handler before any
> storage I/O, and decides steps 1 and 2 below. Step 3 is this ADR's to add
> to the same switch.

1. `public` → allow. Zero extra I/O; the common path is untouched.
2. `password` → ADR-013 B7 (cookie, then Basic).
3. `restricted` → try proofs in this order, stop at the first that
   decides:
   1. A delivery token (§4) that covers the read. Pure computation, with
      no table and no storage read.
   2. `Authorization: Bearer <jwt>`, on the apex only. The auth
      middleware skips `/files`, because `Authorization: Basic` is a
      credential there (ADR-013 B7), so this branch verifies the token
      itself with the auth middleware's verifier, then calls
      `enterCaller(c, caller)` and
      `authorizeAsset(ctx, asset, "read_asset")` (ADR-016). This is the only
      branch on `/files` that binds a caller; public, password and token
      reads make no directory call, and `/files` runs no session
      (ADR-002, 2026-11-05 amendment).
   3. Nothing valid → a JSON `401` with `WWW-Authenticate: Bearer,
      ServeToken` on the apex and `ServeToken` on a site host, whether or
      not the deployment has a key ring, so a client knows a minted token
      would help. Browser navigations get the same JSON; a sign-in page
      waits for Follow-up 6. Every `/files` response sends
      `Access-Control-Expose-Headers: WWW-Authenticate, Retry-After`.

A site host runs no auth middleware and binds no tenancy (ADR-013 B1), so
a restricted asset there accepts a delivery token only and ignores a
bearer. Members read with a bearer through the apex `/files` path.

A denial answers `404` for both not-found and forbidden, through ADR-016's
`deniedResponse`. A bearer that fails verification, a JWKS fetch failure
included, is the `401` above. A verified caller the directory does not
know is `404` like a non-member, where the API answers `401`, so every
failed membership on `/files` reads as `deniedResponse` does. A tenancy
outage answers `503` with `Retry-After: 5`. The handler answers all of
these itself, with the refusal CORS headers of §8. Refusals send
`Cache-Control: no-store`. Serve caches no access decision across
requests. Responses from restricted assets carry `Cache-Control: private`
(A2 policy otherwise unchanged), and token and bearer responses send
`Access-Control-Allow-Origin: *` without credentials.

The `/files/` handler's "no access checks" note becomes: *capability by
default; `resolveAccess` when the asset's mode says so.*

### 6. API and CLI

```
PATCH  /api/v1/assets/:id                 {"access": "restricted"}
POST   /api/v1/assets/:id/signed-urls     {prefix?, versionId?, expiresIn?}
```

CLI: `asset protect <id> --restricted`, beside the existing
`--password` and `--off`, and `asset sign <id> [prefix] [--expires 24h]
[--version <versionId>]`, which prints the token, `expiresAt` and the URL
template. `file cp` and `file sync` send the CLI's login
JWT, so a member downloads a restricted asset with the same commands.

### 7. The marketplace flow (deferred)

The storefront flow needs grants and waits with them (Follow-up 5).

### 8. Interaction with ADR-013

- B7 `password` is mode two of this ADR; its Basic fallback, rate limiter
  and `private` caching are unchanged.
- **CORS by proof.** Only a cookie proof gets credentialed CORS. Serve
  echoes `Origin` with `Access-Control-Allow-Credentials: true` only when
  it equals Serve's own origin or appears exactly in
  `CREDENTIALED_ORIGINS`. The own origin is `BASE_URL` on the apex and the
  request host on a site host, never `c.req.url`, which reads `http://`
  behind a TLS proxy. Serve never echoes `null`. Every other proof, Basic
  included, gets `*` with no credentials header. Protected responses send
  `Vary: Origin`, and cookie-authorized ones add
  `Cross-Origin-Resource-Policy: same-origin`, which stops no-cors loads
  from sibling hosts. Preflights and refusals carry no proof, so whatever
  the mode they answer an own or listed origin with credentials and every
  other origin with `*`. Preflights allow the fixed headers `range`,
  `if-none-match`, `if-modified-since`, `authorization` and
  `x-serve-token`, with `Access-Control-Max-Age: 86400`. A
  `CREDENTIALED_ORIGINS` entry with a path, a wildcard or `null` fails at
  start.
- **Cookies.** B7's `rs_site_auth` becomes `__Host-serve_access` on a
  site host (`Path=/`, no `Domain`, `Secure` even on plain-http loopback)
  and `serve_access` for the apex path form. The cookie MAC input gains
  the label `serve-access-cookie-v1`, so cookies issued before the change
  stop verifying. On the apex, every `/files` response served as an
  attachment also sends `Content-Security-Policy: sandbox`, so a document
  a browser renders anyway cannot read path-scoped cookies.
- **Site isolation (B1).** Sibling site hosts under one registrable
  domain are the same site, so cookie scope alone does not isolate one
  site from another. When `SITE_HOST_SUFFIX` is set, Serve requires
  `BASE_URL` and `SITE_REGISTRABLE_DOMAIN`. It refuses to start when the
  suffix host does not end in `.` plus that domain, or when the
  `BASE_URL` host equals the domain or ends in `.` plus it. Hosts compare
  lowercased, without port or trailing dot. `SITE_DOMAIN_IS_PUBLIC_SUFFIX=true`
  is the one override, for a domain on the Public Suffix List, and Serve
  logs it at start. A valid setup puts the API on `api.example.com` and
  sites under `.sites.example.net`.
- B7's deferred `members` mode is `restricted` viewed from a site host. It
  needs the restricted site cookie, which waits for a later ADR
  (Follow-up 6).
- Named sites (B2) can be `restricted`. Preview hosts (B4) follow the
  asset's mode like every other URL form.

## Alternatives Considered

**A. Keep URL-as-capability; tell users to keep IDs secret.** Fails
demand 1 at the first pasted link and cannot express demand 3 at all.

**B. Cloudflare Access / Zero Trust.** Per-seat pricing that a
marketplace cannot pass on, IdP-only (no grants to arbitrary buyers
without adding them to the tenant), and Cloudflare-only against
ADR-012.

**C. Per-file signed URLs only (S3 presigned style).** Works for one
download, unusable for tilesets: a viewer would need a URL per tile.
Prefix signing covers both.

**D. Encrypt restricted objects with per-buyer keys.** Real protection at
rest but breaks Range, gzip passthrough, thumbnails and every
zero-CPU delivery property in ADR-011. The threat this ADR addresses is
access, not a compromised bucket.

**E. Push all authorization to the tile service layer.** Files that are
not tiles (GeoJSON, glTF, CityGML, hosted sites) never pass through it.
Both layers need it.

**F. Session state for signed URLs (a token table, or a `signing_keys`
table).** Stateless HMAC tokens need no writes, no cleanup and no read per
token. Two keys in one secret cover rotation.

**G. Ed25519 tokens now.** Verify costs about 20 times as much on
workerd, and Serve is the only verifier today. It would let another
service verify without holding a key that can mint. It changes only the
adapter and the key format, so it stays open behind the port.

**H. One `SIGNING_SECRET` for cookies and tokens.** The labels already
separate the MACs, but one secret ties the two rotations together.

**I. Credentialed CORS for token and bearer reads.** Those proofs travel
in the query or a header and need no credentials mode, so `*` keeps every
origin working.

**J. A Public Suffix List entry instead of a separate site domain.** It
needs maintainer review with no time commitment, and old browsers keep
old lists. A separate domain works as soon as DNS and certificates exist.
The override still supports a listed domain.

**K. Tokens on `password` assets.** Any member could mint a 7-day URL that
skips the password.

## Consequences

- Public assets pay nothing: `resolveAccess` returns on the first branch
  with no I/O. A token read adds one HMAC verify and no storage read
  before the decision; a bearer read adds ADR-016's directory call.
- A deployment that sets no new variable serves as before: the mint route
  answers `501`, and site hosts and credentialed origins stay off.
- Credentialed CORS answers only the response's own origin and
  `CREDENTIALED_ORIGINS`. Delivery tokens keep `*`, so they are the
  recommended integration for browser viewers, and the docs say so.
- One secret (`DELIVERY_TOKEN_KEYS`), one optional allowlist
  (`CREDENTIALED_ORIGINS`), one handler branch, one endpoint, no new
  tables.
- A `serve_token` in a URL can leak through logs, copy and paste, and
  absolute child URIs, since Cesium sends the query to child requests on
  other hosts. Asset and prefix binding, the 7-day cap, log redaction and
  `no-referrer` bound a leak. The header form avoids it.
- Revoking a token before `exp` means rotating its key, which revokes
  every token signed with that key.
- Cookies issued before the rename and the label stop verifying, so
  password visitors enter the password once more.
- Site hosts need a registrable domain separate from the API, or a Public
  Suffix List entry. A configuration that shares the API's domain fails at
  start.
- Bearer- and cookie-authorized pinned files keep the year-long `private`
  browser cache, so a member who loses access keeps what they already
  fetched.
- Revoking a leaked token's key skips the two-deploy rotation: remove
  the key at once, and clients re-mint after one failed read.
- A token's prefix bounds request paths, not bytes. A `null`-version token
  reaches old versions, whose own `_redirects` rewrites and SPA fallback
  apply under a covered path.
- Restricting an asset does not recall what shared caches already hold.
  Version-ID URLs of a public asset were served `public, immutable` for a
  year, so an asset that must stay private is restricted before its URLs
  are shared.
- The start check covers `SITE_HOST_SUFFIX` only. A custom domain (ADR-013
  B5) under the API's registrable domain shares the API's site, and no
  check refuses it.

## Follow-ups

1. `restricted` with OIDC bearer and membership (§5 step 3.2). Unlocks
   demand 1 for CLI users.
2. Delivery tokens (§4), `asset sign`, and a viewer integration note.
3. **Grants** (later ADR). An `asset_grants` row says "this principal may
   read this target until this time". The target is an asset or a
   project; the principal is an OIDC subject, a verified email (so the
   OIDC middleware must check `email_verified`), or an API key.
   `expires_at` is planned and `revoked_at` is an act, and both are
   events. The `Authorizer` port evaluates grants, and `CerbosAuthorizer`
   receives them as resource attributes. A grant-bound token names its
   grant, and the handler re-checks it, so revoking the grant kills
   outstanding tokens.
4. **API keys** (later ADR). Workspace-scoped, with a role and an optional
   project list, stored as `SHA-256(key)`, sent as a bearer and told from
   a JWT by prefix, created and revoked by workspace `admin`+.
5. **Storefront integration** (later ADR). Batch and project grants, the
   purchase, delivery and refund flow, and grant webhook types. Serve holds
   no money and no catalogue; a grant's `ref` column is the only trace of
   the partner's order model.
6. **Restricted site cookie.** B7's `members` mode on site hosts: the
   `401` page offers sign-in, and the OIDC return on the site host mints
   the cookie.
7. Per-principal transfer metering (with ROADMAP Phase 6). `resolveAccess`
   returns the principal for it.
8. Open questions: Ed25519 instead of HMAC (§4), tokens on `password`
   assets, and a Public Suffix List entry instead of a separate domain.
