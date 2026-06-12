# ADR-002: Authentication, Anonymous Sessions & Project Model

- **Status:** Accepted (Revised 2026-04-17)
- **Date:** 2026-03-12
- **Deciders:** @rot1024

## Revision 2026-04-17 — Tenant scoping hardening

The original decision made `projectId` on assets/jobs optional for
authenticated callers. A security scan surfaced that this allowed any
authenticated user to enumerate every row via `GET /api/v1/assets` and
`GET /api/v1/jobs`, and that `canAccessAsset`/`canAccessJob` returned `true`
for any authenticated caller when the resource had no `projectId`.

The hardening makes project scope mandatory for the authenticated track:

- `POST /api/v1/assets`, `POST /api/v1/assets/uploads`, and
  `POST /api/v1/assets/uploads/:id/complete` require the `X-Project-Id`
  header when the caller is authenticated; the server verifies workspace
  membership before accepting the upload. Anonymous callers continue to
  upload with session-id binding.
- `canAccessAsset` / `canAccessJob` no longer treat "authenticated + no
  projectId" as allowed — the resource must be project-scoped and the
  caller must be a member of the project's workspace.
- `GET /api/v1/assets` and `GET /api/v1/jobs` scope to the caller:
  anonymous requests to their own session, authenticated requests to the
  projects reachable via workspace membership. `?projectId=` and
  `?workspaceId=` narrow further, with membership re-verified on each
  call.

File delivery (`/files/:id/:path`) is unchanged by design — see the
banner in `worker/file/handler.ts`. The file layer is URL-as-capability;
confidentiality comes from unguessable IDs and from list endpoints being
scoped, not from per-request auth at the file edge.

Additionally, the session middleware no longer silently accepts any
client-asserted `X-Session-Id`. The header is now only honored when the
ID already exists in KV (i.e. the server issued it earlier). Unknown
well-formed IDs are ignored — a fresh session is minted and returned in
the response header. This closes the replay path where a leaked session
ID (from logs, shared URLs, or prior enumeration bugs) let an attacker
inherit the victim's demo-mode assets and jobs.

Projects also enforce workspace membership on read: `GET /projects/:id`
and `GET /projects/?workspaceId=X` return 404 to non-members instead of
leaking project name / owner / timestamps to anyone holding a workspace
ID.

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
  workspaceId?: string;  // optional — projects can belong to a workspace
}
```

**KV key patterns:**
```
project:{id}                  →  Project JSON
project_list:{ownerId}        →  [id, id, ...]  (JSON array of project IDs)
project_list_ws:{workspaceId} →  [id, id, ...]  (workspace's project IDs)
```

KV lacks range queries, so `project_list:{ownerId}` stores a JSON array of project IDs, updated atomically on project create/delete. This is acceptable for the expected cardinality (tens of projects per user, not thousands).

**Asset and Job scoping:**

Both `AssetMetadata` and `Job` schemas include an optional `projectId` field. When a user is authenticated and operating within a project, `projectId` is set. Demo-mode assets have no `projectId`.

**R2 key design decision:** R2 keys remain `assets/{assetId}/` — no project ID in R2 paths. R2 does not support object rename, so adding project ID to R2 keys would require copying all objects on project assignment changes. Only KV metadata carries `projectId`.

### Workspace Model

Workspaces provide multi-user collaboration. Projects belong to workspaces. Membership (and roles) are scoped to workspaces, not projects.

**Design rationale:** Workspace, member, and project management will eventually be handled by an external account/identity application. The current implementation uses interfaces (`WorkspaceStore`, `MemberStore`) with KV-backed stand-in implementations to enable local development and testing.

**Model:**
```typescript
Workspace {
  id: string;
  name: string;
  createdAt: number;
  updatedAt: number;
}
```

No `ownerId` on workspace — ownership is expressed through the Member model (role = "owner").

**KV key patterns:**
```
workspace:{id}                →  Workspace JSON
member:{workspaceId}:{userId} →  Member JSON
member_list:{workspaceId}     →  [userId, ...]
user_workspaces:{userId}      →  [wsId, ...]  (inverse index)
project_list_ws:{workspaceId} →  [projectId, ...]
```

### Member Model

```typescript
Member {
  workspaceId: string;
  userId: string;
  role: Role;
  createdAt: number;
  updatedAt: number;
}
```

When a workspace is created, the creator is automatically added as `owner`. The last owner cannot be removed or demoted.

### Role Model & Permission Table

Four roles are defined with workspace-level scoping:

| Resource | Action | owner | admin | editor | viewer |
|----------|--------|:-----:|:-----:|:------:|:------:|
| **workspace** | read | ✓ | ✓ | ✓ | ✓ |
| **workspace** | update | ✓ | ✓ | - | - |
| **workspace** | delete | ✓ | - | - | - |
| **workspace** | manage-members | ✓ | ✓ | - | - |
| **project** | read | ✓ | ✓ | ✓ | ✓ |
| **project** | create | ✓ | ✓ | - | - |
| **project** | delete | ✓ | - | - | - |
| **asset** | read | ✓ | ✓ | ✓ | ✓ |
| **asset** | create | ✓ | ✓ | ✓ | - |
| **asset** | delete | ✓ | ✓ | ✓ | - |
| **job** | read | ✓ | ✓ | ✓ | ✓ |
| **job** | retry | ✓ | ✓ | ✓ | - |

Role definitions are in `shared/api.ts` (`roleSchema`). The permission map is in `worker/auth/roles.ts`. Authorization is enforced by `Authorizer` interface implementations:
- `SimpleAuthorizer` (`worker/infra/authorizer.ts`) — in-process, uses the permission map directly
- `CerbosAuthorizer` (`worker/auth/authorizer.ts`) — delegates to external Cerbos PDP

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
- Workspaces provide multi-user collaboration with role-based access control
- Workspace/member stores use interfaces — KV implementations are stand-ins for a future external account API
- The permission table is enforced via `Authorizer` interface (SimpleAuthorizer for local dev, CerbosAuthorizer for production)
- `/api/v1/me` returns user info + workspace list in a single request
- No data migration is needed — all new fields are optional and additive
