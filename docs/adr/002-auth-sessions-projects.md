# ADR-002: Authentication, Anonymous Sessions & Project Model

- **Status:** Accepted
- **Date:** 2026-03-12
- **Deciders:** @rot1024

## Context

Re:Earth Serve's Phase 0 and Phase 1 provide ephemeral asset hosting with no user identity, no access control, and no project-based organization. All APIs are publicly accessible.

To support multi-tenant usage, the system needs:
- User authentication via external identity providers
- Anonymous session tracking for demo-mode users
- A project model for scoping assets and jobs
- Role-based access control (to be implemented in a subsequent step)

## Decision

### JWT Authentication Middleware (OIDC)

Authentication is handled by validating OIDC-compliant JWTs in a Hono middleware using the `jose` library. The system supports any OAuth2/OIDC-compliant IdaaS (Auth0, Okta, Keycloak, etc.) via environment variables.

**Flow:**
1. Check `Authorization: Bearer <token>` header
2. Token present → `jose.jwtVerify()` using JWKS from `{issuer}/.well-known/jwks.json`
3. Valid → extract user identity (`sub`, `email`, `name`) into request context
4. No token → proceed as demo mode (`user = null`)
5. Invalid token → 401 Unauthorized

**Key design decisions:**
- **OIDC not required**: When `OIDC_ISSUER_URL` is not configured, all requests proceed as demo mode. This preserves backward compatibility and allows local development without an IdP.
- **JWKS caching**: `jose.createRemoteJWKSet` caches internally per Workers isolate. Since Workers isolates are short-lived, JWKS may be re-fetched across isolate recycling. KV-based caching is a future optimization if latency becomes an issue.
- **No session cookies**: The Worker is stateless. Authentication state is carried entirely in the JWT.

**Environment variables:**

| Variable | Required | Description |
|----------|----------|-------------|
| `OIDC_ISSUER_URL` | No | OIDC Issuer URL (e.g., `https://your-tenant.auth0.com/`) |
| `OIDC_AUDIENCE` | No | JWT audience claim for token validation |
| `OIDC_CLIENT_ID` | No | OAuth2 Client ID (also used for CLI build-time embedding) |

### Anonymous Session Tracking

Demo-mode users (not logged in) receive a temporary session ID so they can track their own uploads and jobs.

**Flow:**
1. If `X-Session-Id` header is present → validate against KV
2. If absent → generate a new session ID, store in KV with asset TTL, return in `X-Session-Id` response header
3. Record `sessionId` in asset metadata
4. Authenticated users (`user != null`) skip session creation — `sessionId = null`

**KV key pattern:**
```
session:{id}  →  { id, createdAt, expiresAt }  TTL: 3600s (same as asset TTL)
```

Sessions are ephemeral and auto-expire via KV TTL, consistent with the ephemeral asset model.

### Project Domain Model

Projects provide logical grouping of assets with per-project settings and access control.

**Model:**
```typescript
Project {
  id: string;
  name: string;
  createdAt: number;
  updatedAt: number;
  ownerId: string;
}
```

**KV key patterns:**
```
project:{id}           →  Project JSON
project_list:{ownerId} →  [id, id, ...]  (JSON array of project IDs)
```

KV lacks range queries, so `project_list:{ownerId}` stores a JSON array of project IDs, updated atomically on project create/delete. This is acceptable for the expected cardinality (tens of projects per user, not thousands).

**Asset and Job scoping:**

Both `AssetMetadata` and `Job` schemas include an optional `projectId` field. When a user is authenticated and operating within a project, `projectId` is set. Demo-mode assets have no `projectId`.

**R2 key design decision:** R2 keys remain `assets/{assetId}/` — no project ID in R2 paths. R2 does not support object rename, so adding project ID to R2 keys would require copying all objects on project assignment changes. Only KV metadata carries `projectId`.

### Role Model

Four roles are defined for future authorization:

| Role | Project | Asset | Job |
|------|---------|-------|-----|
| owner | CRUD + delete + manage members | CRUD | view, retry |
| admin | read + manage members (except owner) | CRUD | view, retry |
| editor | read | create, read, delete | view, retry |
| viewer | read | read only | view |

Role definitions are in the shared Zod schema (`roleSchema`). Authorization enforcement is deferred to a subsequent implementation step (Cerbos integration).

## Middleware ordering

Middleware is registered in the following order on the Hono app:

1. **Auth middleware** — extracts `user` from JWT (or sets `null`)
2. **Session middleware** — generates/validates anonymous session (skipped if `user` is set)
3. **DI middleware** — injects repository instances into request context

This ordering ensures that the session middleware can inspect the `user` set by auth middleware.

## Alternatives considered

### Cookie-based sessions for anonymous tracking

Rejected because: Workers are stateless and the API is used by CLI clients, CI/CD pipelines, and AI agents where cookies are inconvenient. An explicit `X-Session-Id` header is more portable and transparent.

### Project ID in R2 keys

Rejected because: R2 does not support object rename/move. Changing an asset's project would require copying all R2 objects. Keeping R2 keys project-agnostic (`assets/{assetId}/`) avoids this problem entirely.

### D1 for project storage

Deferred. KV is sufficient for the current cardinality (tens of projects per user). D1 would be needed if projects require complex queries (filtering, sorting, pagination across all users), which is a future concern.

### Worker-side OIDC discovery caching in KV

Deferred. `jose.createRemoteJWKSet` handles in-memory caching per isolate. If JWKS fetch latency becomes an issue across isolate recycling, a KV-based cache with TTL can be added without changing the middleware interface.

## Consequences

- Existing APIs continue to work without authentication (demo mode)
- Authenticated users are identified by their JWT `sub` claim
- Anonymous users can track their uploads via `X-Session-Id` header
- Assets and jobs carry optional `projectId` for future project-scoped queries
- The role model is defined but not yet enforced — authorization is a separate step
- No data migration is needed — all new fields are optional and additive
