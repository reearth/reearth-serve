# ADR-020: Delivery Tokens and the Delivery Protocol

- **Status:** Proposed
- **Date:** 2026-11-05
- **Deciders:** @pyshx
- **Related:** [ADR-002](002-auth-sessions-projects.md) (sessions), [ADR-012](012-multi-cloud-portability.md) (ports and composition roots), ADR-013 and ADR-014 (site hosting and access modes, open PR #16), [ADR-016](016-accounts-authorization.md) (accounts authorization)

## Context

`/files/{id}/…` treats the URL as the capability. ADR-014 on open PR #16 adds the `password` mode and plans a `restricted` mode for project members. Its §4 sketches a signed-URL token (`rs_sig`, `SIGNING_SECRET` with a key-ID byte, 1 hour by default, 7 days at most) but leaves the format, the key handling and the wire protocol open.

Browser clients cannot attach a session cookie across origins, and an `<img>` or a tile loader cannot set `Authorization`. Two client libraries settle how a token has to travel:

- CesiumJS copies a resource's query parameters and headers to every 3D Tiles child request, including external tilesets and implicit tiling.
- MapLibre's `transformRequest` does not reach PMTiles Range reads, but the PMTiles source keeps the URL query on every Range request.

So a token must work in the query string and in a header, and it must cover a path prefix, not one file.

A review of PR #16 found four problems that this ADR also decides:

- Credentialed CORS echoes any `Origin` for a protected asset.
- Site hosts under one registrable domain are the same site, so a `SameSite=Lax` cookie flows between sibling sites.
- Every Basic request runs PBKDF2 at 600,000 iterations, and the limiter trusts a client-supplied `X-Forwarded-For`.
- Hono decodes a path parameter once, so decoding it again turns `a%252Fb` into `a/b`.

Serve is a generic DAM. Every capability here must be off or neutral by default and must name no product host.

## Decision

### 1. Token format and MAC label

A token is `base64url(JSON claims) "." base64url(mac)`. The claims are `{ v: 1, kid, assetId, versionId, prefix, exp }`.

- `versionId` is `null` when the token follows the asset's active version, and a version id when the token is pinned to it.
- `prefix` is a decoded path inside the asset with no leading slash. The empty prefix covers the whole asset.
- `exp` is Unix seconds.

Both parts are canonical unpadded base64url. A part with padding, a character outside the alphabet or non-zero trailing bits is malformed, and the claims bytes must be valid UTF-8, so each token has one valid string form.

The MAC input is the ASCII label `serve-delivery-v1`, a newline, and the encoded claims. The access cookie uses its own label (decision 9.5), so no MAC that Serve computes for another purpose passes as a token.

### 2. HMAC-SHA256 behind a port

`core/access/token.ts` defines the `DeliveryTokenCodec` port with `sign(claims)` and `verify(token, now)`. `verify` returns the claims or the first failing reason, checked in this order: decoding and the claims shape (`malformed`), the key id (`unknown_kid`), the MAC (`bad_signature`), then expiry (`expired`). So `expired` is reported only for an authentic token. A WebCrypto adapter implements it with HMAC-SHA256 and imports keys once per isolate. The composition roots supply the keys, per ADR-012 §1.

HMAC verifies in about 2 µs on local workerd and 10 µs on Node. Ed25519 takes about 40 µs and 108 µs. Serve is the only verifier, so HMAC is the default. Ed25519 is an open question. It would let another service verify tokens without holding a key that can also mint them, and it changes only the adapter and the key format.

### 3. Key ring and two-key rotation

`DELIVERY_TOKEN_KEYS` holds the ring as JSON:

```json
{"active":"k2","keys":{"k1":"<base64 secret>","k2":"<base64 secret>"}}
```

Both composition roots parse it with one shared parser into `{ active, inactive | null }`, so a third key cannot be represented. The parser rejects malformed JSON, a secret shorter than 32 bytes, more than two keys, and an `active` id that is not in `keys`. Every error message starts with `DELIVERY_TOKEN_KEYS: `. A rejected ring is a config error under ADR-016 decision 8. Today nothing in `runtime/cloudflare/index.ts` catches a `buildDeps` throw. The ring is the first Worker config error, so the change that adds the ring also adds that catch.

The codec signs with the active `kid` and verifies with any listed `kid`. To rotate, add the new key, make it active, wait the longest token life, then remove the old key.

### 4. Lifetime

The mint route accepts `expiresIn` from 60 to 604,800 seconds and defaults to 3,600. The codec refuses to sign a token whose `exp` is more than 7 days after now. Exactly 7 days is allowed. `verify` accepts a token while `now - exp <= 30`, to absorb clock skew between the isolate that mints and the one that reads.

### 5. `parseAssetPath`

`parseAssetPath(rawPathname)` turns the part of the request path after `/files/<id>/` into the asset path. Its input is the raw, still-encoded path from `new URL(request.url).pathname`, never `c.req.param("path")`. Hono 4 already decodes a path parameter once, so decoding that value again would turn `a%252Fb` into `a/b`. It returns the path, or null when it refuses one.

- It decodes each run of `%XX` escapes once with `decodeURIComponent` and refuses a run that is not valid UTF-8. A `%` that two hex digits do not follow stays a literal `%`, so `100%.png` and `100%25.png` both mean `100%.png`.
- It refuses `.` and `..` segments, backslashes, NUL, and any `%2F` left after decoding. `a%2Fb` becomes `a/b`, and `a%252Fb` is refused.
- It keeps empty segments. `a//b` is neither collapsed nor refused, so it names a different storage key from `a/b`.
- It strips the leading slash. The empty path means the whole asset.

The file handler builds the storage key from this output, so the token match and the storage read use the same string. The mint route normalizes `prefix` with the same segment rules.

### 6. Off by default

With `DELIVERY_TOKEN_KEYS` unset, `Deps.deliveryTokens` is `null` and the mint route answers `501`. A deployment that sets nothing behaves as it did before this ADR.

### 7. Delivery protocol

Any client can implement delivery from this section and the OpenAPI document. The examples use `https://assets.example.com`.

**Mint.** `POST /api/v1/assets/{id}/signed-urls` with the body `{ prefix?, versionId?, expiresIn? }`. The caller must hold `read_asset` on the asset, the same check as a restricted read. The response is `{ token, expiresAt, urlTemplate }`. `urlTemplate` is `<base>/files/<id>/{path}?serve_token=<token>`, where `<base>` is the deployment's resolved base URL. When the body names `versionId`, the template names the version id in place of the asset id, so the URL is pinned.

| Status | When |
|---|---|
| `501` | `DELIVERY_TOKEN_KEYS` is unset |
| `400` | `prefix` fails the path rules, `expiresIn` is out of range, or the asset is in `password` mode |

**Carry.** Send the token as the query parameter `serve_token` or the header `X-Serve-Token`. The query form needs no preflight and works with Cesium `queryParameters` and PMTiles URLs. The header form keeps the token out of URLs and logs. A request that carries both with different values gets `400`.

```http
GET /files/01hx/tiles/3/4/5.b3dm HTTP/1.1
Host: assets.example.com
X-Serve-Token: <token>
```

**Match.** Serve allows the read when the token verifies, `assetId` matches, `versionId` is `null` or equals the resolved version, and `prefix` is a segment-boundary prefix of the parsed path. `tiles/` covers `tiles/3/4/5.b3dm` and not `tiles-old/a.b3dm`. A thumbnail request maps to its source path before the match. A token for another asset counts as no token, and Serve goes on to the bearer. A token whose `assetId` matches but whose version or prefix does not gets `403`, because its holder already knows the asset exists. Tokens open `restricted` assets only. Serve ignores a token on a `password` asset.

**Challenge.** A `401` for a `restricted` asset carries `WWW-Authenticate: Bearer, ServeToken`, so a client knows a minted token would help. Every `/files` response sends `Access-Control-Expose-Headers: WWW-Authenticate`.

**Response.** A token-authorized response sends `Access-Control-Allow-Origin: *` with no credentials header, `Cache-Control: private` with `max-age` no longer than the token's remaining life, and `Referrer-Policy: no-referrer`. A pinned token may add `immutable`. Refusals send `no-store`. Serve strips `serve_token` from the query before any other use and redacts it from logs. The OpenAPI document declares `serve_token` and `X-Serve-Token` as `apiKey` security schemes on `/files`.

### 8. No session on `/files`, and tenancy only for a restricted bearer read

This decision amends ADR-002. The session middleware does not run on `/files`, because anonymous ownership checks run only on `/api/v1/*`, so file delivery never reads or writes a session. A restricted read with an OIDC bearer verifies the token, calls `enterCaller(c, caller)`, then calls `authorizeAsset(ctx, asset, "read_asset")`, as ADR-016 defines them. That branch is the only one on `/files` that binds a caller. Public, password and token reads make no directory call. Token verification is pure computation with no table and no storage read. Serve caches no access decision across requests.

### 9. Changes to ADR-014

ADR-014 and ADR-013 exist only on open PR #16. This ADR lands first, so it records the changes here, and PR #16's rebase folds them into ADR-014's text. Where an item also replaces an ADR-013 B7 rule, the rebase folds it into ADR-013 as well.

1. **§1 Access modes, `restricted`.** A `restricted` asset is readable by project members who hold `read_asset` under ADR-016's policy, with an OIDC bearer or a delivery token as proof. Grants (§2), API keys (§3), grant-bound tokens and the restricted site cookie wait for a later ADR. `PATCH /api/v1/assets/:id` accepts `restricted` for project assets only.
2. **§4 Signed URLs.** Decisions 1 to 7 replace §4. `rs_sig` becomes `serve_token`, and the header form `X-Serve-Token` is new. `DELIVERY_TOKEN_KEYS` replaces `SIGNING_SECRET` for tokens, so tokens and cookies rotate apart. The mint body names `prefix` instead of `scope` and drops `grantId`. The 1-hour default and the 7-day cap stay.
3. **§5 Enforcement, `restricted` branch.** Serve tries a delivery token first, then the OIDC bearer. A denial answers `404` for both not-found and forbidden, through ADR-016's `deniedResponse`, with `no-store`. A tenancy outage answers `503` with `Retry-After: 5`. The 60-second KV cache of grant and key lookups is dropped. Token and bearer responses send `Access-Control-Allow-Origin: *` without credentials, replacing the echoed `Origin`.
4. **§5 and §8, CORS and credentialed reads (ADR-013 B7 CORS).** Only a cookie proof gets credentialed CORS. Serve echoes `Origin` with `Access-Control-Allow-Credentials: true` only when `Origin` equals Serve's own origin or appears exactly in `CREDENTIALED_ORIGINS`. The own origin is `BASE_URL` on the apex and the request host on a site host, never `c.req.url`, which reads `http://` behind a TLS proxy. It never echoes `null`. Every other proof, Basic included, gets `*` with no credentials header. Protected responses send `Vary: Origin`, and cookie-authorized ones add `Cross-Origin-Resource-Policy: same-origin`, which stops no-cors loads from sibling hosts. Preflights and refusals carry no proof. Whatever the asset's mode, they answer an own or allowlisted origin with credentials and every other origin with `*`. Preflights allow the fixed headers `range`, `if-none-match`, `if-modified-since`, `authorization` and `x-serve-token` with `Access-Control-Max-Age: 86400`, instead of echoing the request. A `CREDENTIALED_ORIGINS` entry with a path, a wildcard or `null` fails at start.
5. **§8, cookies (ADR-013 B7 cookie).** The cookie `rs_site_auth` becomes `__Host-serve_access` on a site host, with `Path=/`, no `Domain`, and `Secure` even on plain-http loopback. On the apex, the path-form cookie is `serve_access`. The cookie MAC input gains the label `serve-access-cookie-v1`, so cookies issued before the change stop verifying. On the apex, every `/files` response served as an attachment also sends `Content-Security-Policy: sandbox`, so a document a browser renders anyway cannot read path-scoped cookies.
6. **§8, password cost (ADR-013 B7 password storage and rate limiting).** PBKDF2 stays at 600,000 iterations. Each isolate memoizes successful checks, keyed by `HMAC-SHA256(isolateKey, assetId | password_version | password)` with a 32-byte random `isolateKey`, for 300 seconds and at most 1,000 entries with least-recently-used eviction. The form and Basic share the memo. Unless `TRUST_PROXY=true`, the Node runtime deletes an incoming `CF-Connecting-IP` and sets `X-Forwarded-For` to the socket address before the app runs. On Workers the limiter keeps reading the edge's `CF-Connecting-IP`.
7. **§8, site isolation (ADR-013 B1 and the B7 cookie scope).** Sibling site hosts under one registrable domain are the same site, so cookie scope alone does not isolate one site from another. When `SITE_HOST_SUFFIX` is set, Serve requires `BASE_URL` and `SITE_REGISTRABLE_DOMAIN`. It refuses to start when the suffix host does not end in `.` plus that domain, or when the `BASE_URL` host equals the domain or ends in `.` plus it. The check compares lowercased host names without port or trailing dot. `SITE_DOMAIN_IS_PUBLIC_SUFFIX=true` is the one override, for a domain on the Public Suffix List, and Serve logs it at start. A valid setup puts the API on `api.example.com` and sites under `.sites.example.net`. §8's named-site example moves to that domain.
8. **`nosniff` and an inline allowlist (new in ADR-014).** Every `/files` response sends `X-Content-Type-Options: nosniff`, including thumbnails, the archive 404 page and `401` challenges. On the apex, `Content-Disposition` is `inline` only for a type in `INLINE_TYPES`, compared without parameters or case, and `attachment` for every other type. `isInlineType` is the one test, and the item 5 sandbox applies to the same attachment set. The list holds types a browser shows without running script: `image/png`, `image/jpeg`, `image/gif`, `image/webp`, `image/avif`, `text/plain`, `text/csv`, `application/json`, `application/geo+json`, `model/gltf+json`, `model/gltf-binary`, `application/octet-stream`, `application/x-protobuf`, `application/vnd.mapbox-vector-tile`, `video/mp4`, `video/webm`, `audio/mpeg` and `audio/ogg`. HTML, SVG, XML, JavaScript, PDF and unlisted types download. Site hosts stay `inline`, because a static site needs its HTML to render. A deny list of active types was rejected, because it leaves every unlisted type inline.
9. **Archive `_headers` (ADR-013 C3).** A `_headers` rule may not set `Content-Disposition`, `X-Content-Type-Options` or the apex `Content-Security-Policy` sandbox. They join the denied header list.
10. **Apex site form (ADR-013 A1).** On the apex, HTML is served as an attachment, which replaces ADR-013 A1's apex `/files/:id/` site form. A hosted site renders only on a site host.

### 10. Neutral names

Wire names, env vars, errors and examples name no product host. The wire names are `serve_token`, `X-Serve-Token`, `ServeToken` and `serve_access`. Examples use `example.com` hosts and `.test` hosts for local setups. A deployment's own hosts live in its configuration.

## Alternatives Considered

- **Ed25519 now.** Verify costs about 20 times as much on workerd, and Serve is the only verifier today. It stays an open question behind the same port.
- **A `signing_keys` table.** It adds a database read per token and a second place to rotate. Two keys in a secret cover rotation.
- **One `SIGNING_SECRET` for cookies and tokens, as ADR-013 planned.** The labels already separate the MACs, but one secret ties the two rotations together. A separate ring rotates tokens without logging out password visitors.
- **Grants, API keys and grant-bound tokens now.** Member-only delivery does not need them, and they add tables and endpoints. Short token life and key rotation are the revocation for now.
- **Credentialed CORS for token and bearer reads.** Those proofs travel in the query or a header and need no credentials mode, so `*` keeps every origin working.
- **Keep the `rs_` names.** The prefix reads as a product brand on a generic DAM's wire. No deployment uses the old names, and the cookie label invalidates old cookies anyway.
- **Tokens on `password` assets.** Any member could mint a 7-day URL that skips the password. This stays an open question.
- **Decode Hono's path parameter.** It is already decoded once, so a second decode turns `a%252Fb` into `a/b`.
- **A Public Suffix List entry instead of a separate domain.** It needs maintainer review with no time commitment, and old browsers keep old lists. A separate domain works as soon as DNS and certificates exist. The override still supports a listed domain.
- **Cap PBKDF2 at 100,000 iterations.** ADR-013 B7 mandates at least 600,000. The lower cap comes from workerd's source and was never observed on a deployed Worker.

## Consequences

- A deployment that sets no new variable serves public reads as before, except that file responses no longer carry `X-Session-Id` (decision 8). The mint route answers `501`, and site hosts and credentialed origins stay off.
- Against PR #16, three things change for every deployment. Cookies issued before the rename and label change stop verifying, so password visitors enter the password once more. Credentialed CORS answers only the response's own origin and `CREDENTIALED_ORIGINS`, and every other origin gets `*`. Node replaces a client's `X-Forwarded-For` with the socket address unless `TRUST_PROXY=true`.
- Public reads keep their single branch with no directory call. A token read adds one HMAC verify and no storage read before the decision.
- A `serve_token` in a URL can leak through logs, copy and paste, and absolute child URIs, since Cesium sends the query to child requests on other hosts. Asset and prefix binding, the 7-day cap, log redaction and `no-referrer` bound a leak. The header form avoids it.
- Revoking a token before `exp` means rotating its key, which revokes every token signed with that key.
- Site hosts need a registrable domain separate from the API, or a Public Suffix List entry. A configuration that shares the API's domain fails at start.
- Bearer- and cookie-authorized pinned files keep PR #16's year-long `private` browser cache, so a member who loses access keeps what they already fetched.

## Open questions

- Ed25519 instead of HMAC (decision 2).
- Tokens on `password` assets.
- A Public Suffix List entry against a separate site domain.
- Grants and API keys from ADR-014 §2 and §3.
