# ADR-014: Asset Access Control for File Delivery

- **Status:** Proposed
- **Date:** 2026-09-11
- **Deciders:** @rot1024
- **Related:** ADR-002 (auth, projects, roles), ADR-007 (events, webhooks),
  ADR-013 B7 (password-protected sites)

## Context

File delivery (`/files/{id}/…`) is URL-as-capability: knowing an asset ID
grants download, and nothing is checked at request time. ROADMAP Phase 2
calls this "file-layer access control (URL visibility)" and it has served
the public-data use case well — PLATEAU tilesets, open GeoJSON, hosted
sites anyone may open. Three demands now need something stronger, and they
are one problem wearing three coats:

1. **Private datasets.** A project uploads data that only its members, its
   Re:Earth Visualizer scenes and its pipelines may read. Today the only
   protection is that the ID is unguessable — which stops working the
   moment a URL is pasted into a ticket.
2. **Password-protected sites.** A staging build or an internal dashboard
   behind a shared password. ADR-013 B7 designs this for browsers and
   leaves the general mechanism to this ADR.
3. **Data sales.** Partner companies want to sell datasets: a purchaser —
   who is not a member of the seller's workspace — is granted access to
   specific assets for a period, and loses it on refund or expiry. The
   seller's storefront is theirs; Serve must offer the grant, the proof,
   the revocation and the audit trail.

The common shape: an asset carries an **access mode**; a request carries a
**proof**; the handler decides. What differs is *who* may be granted
(members, arbitrary accounts, machines) and *how they prove it* (login,
key, signed link, cookie). ADR-013 B7 already fixed the parts that must
be identical for every mode — access as an asset property enforced on
every URL form, `private` caching, credentialed CORS. This ADR fixes the
rest and adds the marketplace-shaped pieces: grants to non-members,
machine credentials, signed URLs, and an API a storefront can drive.

What Serve is **not** becoming: a store. No catalogue, no pricing, no
payment. A partner sells; Serve enforces what was sold.

## Decision

### 1. Access modes

`access` on the asset (the `hosting.access` field of ADR-013 B7 is this
field; B7 names it from the hosting side):

| Mode | Who may read | Proof accepted |
|------|--------------|----------------|
| `public` (default) | anyone with the URL | none |
| `password` | anyone with the shared password | cookie or `Authorization: Basic` (ADR-013 B7) |
| `restricted` | principals holding a **grant** (§2), including project members by role | signed URL (§4), API key (§3), OIDC bearer, site cookie |

Modes are exclusive. `restricted` is the general mode; `password` is kept
as its own mode rather than modelled as "a grant to whoever knows a
secret" because its proof, threat model and audience are different and
the simpler UI matters to the hosting use case.

Mode is settable on **project assets only**. Demo-mode assets are always
`public` (no owner, no project, one-hour TTL). Changing the mode is an
`asset.access.changed` event.

**Derived assets** (ADR-006) default to the most restrictive mode among
their sources at creation and record that they inherited it; an explicit
override is allowed and logged. Thumbnails always follow their asset.

### 2. Grants: who may read a restricted asset

A **grant** is a row saying "this principal may read this target until
this time". Project membership is an implicit grant — every member with
`viewer` or above reads every asset in the project, as the role table in
ADR-002 already says. Explicit grants exist for everyone else.

```
asset_grants
  id            text pk
  target_kind   'asset' | 'project'
  target_id     text            -- asset ID or project ID
  principal_kind 'user' | 'email' | 'api_key'
  principal_id  text            -- OIDC subject, lowercase email, or key ID
  expires_at    integer null    -- null = until revoked
  source        text            -- 'manual' | 'purchase' | 'share' | …
  ref           text null       -- caller's reference (order ID, contract ID)
  granted_by    text            -- actor
  created_at    integer
  revoked_at    integer null
unique (target_kind, target_id, principal_kind, principal_id) where revoked_at is null
```

- **Targets.** An asset, or a project (= every asset in it, present and
  future). A seller who organises one project per product grants the
  project once per purchaser; a seller with mixed projects grants assets.
  Serve does not model "products" or "bundles" — the storefront maps
  product → targets and issues the grants (bulk endpoint, §6).
- **Principals.**
  - `user`: an OIDC subject on the configured IdP (the Re:Earth account).
  - `email`: for purchasers who have not signed in yet. The grant is
    matched against the verified `email` claim at request time; the first
    login that matches converts nothing — the row simply keeps working.
    Emails are lowercased and compared exactly.
  - `api_key`: a machine credential (§3).
- **Expiry and revocation** are separate: `expires_at` is planned,
  `revoked_at` is an act (refund, contract ended, key leaked). Both are
  events. Revoked rows are kept for the audit trail and purged with the
  event-log cold archive (ADR-007).
- **Evaluation** goes through the `Authorizer` port: `SimpleAuthorizer`
  checks membership then grants; `CerbosAuthorizer` receives the grant
  set as resource attributes so a policy bundle can add conditions
  (region, time window) without code changes.

### 3. Machine credentials: API keys

Pipelines, untiled and a partner's backend are not people with browsers.

- **Shape.** `rs_live_<24 random bytes, base32>`; the server stores only
  `SHA-256(key)`, shows the plaintext once at creation. Sent as
  `Authorization: Bearer rs_live_…`; the auth middleware tells keys from
  JWTs by prefix, so both share one header.
- **Scope.** A key belongs to a workspace and carries a role
  (`viewer` by default; `editor` for pipelines that upload) and an
  optional project list. Keys are principals: a `restricted` asset in the
  key's projects is readable by role; an asset elsewhere needs an explicit
  `api_key` grant.
- **Lifecycle.** Created by workspace `admin`+, listed with last-used
  time, rotated by create-then-revoke, revoked immediately (KV cache
  invalidation, §5). Events for all four.
- **untiled** reads Serve as a service account: one key per untiled
  deployment, `viewer` on the projects it serves. Untiled applies its own
  service-layer authorization to *its* callers (ROADMAP boundary); Serve
  only needs to know untiled may read. Purchasers who consume tiles rather
  than files are therefore untiled's concern, backed by the same grant
  table if untiled chooses to consult it.

### 4. Signed URLs: proof inside the link

For a browser page or a Cesium scene that must load a restricted tileset,
neither a cookie (wrong origin) nor a bearer header (not settable on
`<img>`/`<script>`, awkward for tile requests) fits. A signed URL carries
the proof in the query string.

```
GET /files/{id}/tiles/3/4/5.b3dm?rs_sig=<token>
token = base64url( exp · scope · [grantee] · HMAC-SHA256(secret, id · scope · exp · grantee) )
```

- **Prefix-scoped.** `scope` is a path prefix inside the asset (`/` for
  the whole asset). One token covers every tile under it, so a viewer
  attaches it once (`Resource.queryParameters` in Cesium, `transformRequest`
  in MapLibre) and the browser sends it with each tile. Per-file signing
  would make tilesets unusable.
- **Short-lived by default** (1 hour; maximum 7 days). Issued by
  `POST /api/v1/assets/:id/signed-urls` to any caller who can read the
  asset — a member, an API key, or a purchaser with a grant. A storefront
  typically issues a 24-hour download link on the order page.
- **Optional grantee binding.** A token may embed the grant ID it was
  issued under; revoking the grant then invalidates outstanding tokens
  without a blacklist (the handler re-checks the grant on tokens that name
  one). Unbound tokens are pure bearer tokens and expire on schedule.
- **Secret and rotation.** One deployment secret, `SIGNING_SECRET`, with a
  key-ID byte in the token so two secrets can overlap during rotation.
- **CORS stays `*`.** The proof is in the URL, not in credentials, so
  signed-URL responses keep `Access-Control-Allow-Origin: *` — the one
  proof that does not force consumers into credentialed fetches. This is
  why signed URLs, not cookies, are the recommended integration for
  Visualizer.
- **Caching.** `private`; the token is part of the cache key anyway.
  Version-pinned signed URLs may be `immutable` within their lifetime.

### 5. Enforcement in the file handler

One function, `resolveAccess(asset, request)`, before any storage I/O:

1. `public` → allow. Zero extra I/O; the common path is untouched.
2. `password` → ADR-013 B7 (cookie, then Basic).
3. `restricted` → try proofs in this order, stop at the first that
   decides:
   1. `rs_sig` query token — pure computation; grant re-check only if the
      token is grantee-bound.
   2. `Authorization: Bearer rs_live_…` — key lookup (KV-cached hash →
      key row), then role/grant.
   3. `Authorization: Bearer <jwt>` — existing OIDC middleware, then
      membership → `user` grant → `email` grant.
   4. Site cookie (ADR-013 B7 shape, minted after an OIDC login on the
      site host) — for `members`-style browsing of a restricted hosted
      site.
   5. Nothing valid → `401` (no proof) or `403` (proof, no grant). Both
      `Cache-Control: no-store`.

Grant and key lookups are D1 reads behind a KV cache
(`grant:{target}:{principal}`, `key:{hash}`, 60 s TTL) invalidated on
write; a revocation is visible within the TTL at worst and immediately
for the writer's region. Responses from restricted assets carry
`Cache-Control: private` (A2 policy otherwise unchanged) and, when the
proof was a credential, `Vary: Authorization, Cookie` with the request
`Origin` echoed and `Access-Control-Allow-Credentials: true` (ADR-013 B7).

The `/files/` handler's "no access checks" note becomes: *capability by
default; `resolveAccess` when the asset's mode says so.*

### 6. API and CLI

```
PATCH  /api/v1/assets/:id                         {"access": "restricted"}
GET    /api/v1/assets/:id/grants
POST   /api/v1/assets/:id/grants                  {principal, expiresAt?, source?, ref?}
POST   /api/v1/projects/:id/grants                (project target; same body)
POST   /api/v1/grants:batch                       [{target, principal, …}] up to 500
DELETE /api/v1/grants/:grantId                    revoke
GET    /api/v1/projects/:id/grants?principal=…    what does this buyer hold?
POST   /api/v1/assets/:id/signed-urls             {scope?, expiresIn?, grantId?}
GET    /api/v1/workspaces/:id/api-keys            list (hash, role, projects, lastUsedAt)
POST   /api/v1/workspaces/:id/api-keys            create → plaintext once
DELETE /api/v1/workspaces/:id/api-keys/:keyId     revoke
```

Grant management requires `editor` on the target's project; key
management requires workspace `admin`. CLI: `asset access <id>
public|password|restricted`, `asset grant add|list|revoke`, `asset
sign <id> [path] [--expires 24h]`, `workspace api-key create|list|revoke`.
`file cp` and `file sync` send the CLI's login JWT or a configured API
key, so a purchaser with an account downloads with the same commands as a
member.

### 7. The marketplace flow, end to end

A partner runs a storefront (their own site, their own payments). The
integration is four calls and two webhooks:

1. **Setup.** Partner creates a workspace API key (`editor`, scoped to the
   product projects). Their storefront holds it server-side.
2. **Purchase.** Storefront `POST /api/v1/projects/{productProject}/grants`
   with `{principal: {kind: "email", id: buyer@example.jp}, expiresAt:
   <licence end>, source: "purchase", ref: <order id>}`. Serve emits
   `asset.grant.created` (webhook to the partner if subscribed).
3. **Delivery.** The order page shows either (a) "sign in with your
   Re:Earth account to download" — the buyer logs in, `file cp`/Visualizer
   work because the `email` grant matches their claim — or (b) a 24-hour
   signed URL the storefront fetched via `POST …/signed-urls` bound to the
   grant. For large datasets (a) is preferable: signed URLs are for
   embedding and one-off downloads, not for 200 GB pulls.
4. **Refund / expiry.** `DELETE /api/v1/grants/{id}` or the clock.
   Grantee-bound signed URLs die with the grant; the buyer's next request
   is `403`. `asset.grant.revoked` / `asset.grant.expired` events.
5. **Reporting.** Per-grantee transfer volume rides on the usage metering
   in ROADMAP Phase 6 (the handler already knows the principal at the
   moment it serves bytes), enabling per-download or metered pricing on
   the partner's side later. Not built here; the hook is that
   `resolveAccess` returns the principal.

Serve holds no money and no catalogue; the `ref` column is the only trace
of the partner's order model.

### 8. Interaction with ADR-013

- B7 `password` is mode two of this ADR; its cookie, Basic fallback,
  rate limiter, `private` caching and credentialed CORS are unchanged.
- B7's deferred `members` mode is `restricted` viewed from a site host:
  the `401` page offers "sign in" instead of a password field, the OIDC
  return lands on the site host, and proof 3.4 mints the cookie.
- Named sites (B2) can be `restricted`: a purchaser who was granted the
  asset opens `kawasaki-flood-map.serve.reearth.land`, signs in, and is
  in. Preview hosts (B4) follow the asset's mode like every other URL
  form.

## Alternatives Considered

**A. Keep URL-as-capability; tell users to keep IDs secret.** Fails
demand 1 at the first pasted link and cannot express demand 3 at all.

**B. Cloudflare Access / Zero Trust.** Per-seat pricing that a
marketplace cannot pass on, IdP-only (no grants to arbitrary buyers
without adding them to the tenant), and Cloudflare-only against
ADR-012.

**C. Per-file signed URLs only (S3 presigned style), no grants.** Works
for one download, unusable for tilesets and for "the buyer may read this
for a year": the storefront would become a URL-signing proxy. Prefix
signing plus grants covers both.

**D. Model products and bundles in Serve.** One step from a catalogue,
two from payments. The partner already has an order model; `target_kind`
+ `ref` is enough to connect the two.

**E. Grants only to registered users (no `email` principal).** Forces the
buyer to create an account *before* checkout so the storefront can learn
their subject. Email grants let the storefront sell first and let the
account come later.

**F. Encrypt restricted objects with per-buyer keys.** Real protection at
rest but breaks Range, gzip passthrough, thumbnails and every
zero-CPU delivery property in ADR-011. The threat this ADR addresses is
access, not a compromised bucket.

**G. Push all authorization to untiled (service layer).** Files that are
not tiles — GeoJSON, glTF, CityGML, hosted sites — never pass through
untiled. Both layers need it; untiled reads Serve as a service account
(§3).

**H. Session state for signed URLs (a token table).** Stateless HMAC
tokens need no writes and no cleanup; grantee binding gives revocation
for the cases that need it.

## Consequences

- Public assets pay nothing: `resolveAccess` returns on the first branch
  with no I/O. Restricted assets pay one KV read (or none for unbound
  signed URLs).
- Restricted assets served with credentials lose `Access-Control-Allow-
  Origin: *`; signed URLs are the way to keep `*`, and the docs say so.
- Two new tables (`asset_grants`, `api_keys`), one secret
  (`SIGNING_SECRET`), one handler function, four event types, ~10
  endpoints. The `Authorizer` port gains resource attributes but no new
  method.
- Serve gains the vocabulary a data marketplace needs (grant, principal,
  expiry, revocation, signed link) without gaining a store.
- The `email` principal makes the IdP's email verification a security
  dependency: only verified `email` claims may match. The OIDC middleware
  must check `email_verified`.
- Auditing improves for everyone: who was granted what, by whom, and when
  it ended is in the event log.

## Follow-ups

1. `access` field, `restricted` mode, `resolveAccess` with OIDC bearer
   and membership only (no new tables). Unlocks demand 1 for CLI users.
2. `asset_grants` with `user` and `email` principals; grants API; events.
3. Signed URLs (prefix-scoped, grantee-bound); `asset sign`; Visualizer
   integration note.
4. API keys; untiled service account; `file cp` with a key.
5. Batch grants endpoint, project-level grants, webhook types — the
   storefront integration (§7).
6. ADR-013 B7 `members` mode on site hosts (proof 3.4).
7. Per-principal transfer metering (with ROADMAP Phase 6).
