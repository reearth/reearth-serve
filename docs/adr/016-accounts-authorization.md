# ADR-016: Policy Table, Accounts Authorization and Service Identity

- **Status:** Accepted
- **Date:** 2026-11-05
- **Deciders:** @pyshx

## Context

Serve keeps workspaces and members in its own D1 or SQLite directory, and `SimpleAuthorizer` or a Cerbos PDP decides each request ([ADR-002](002-auth-sessions-projects.md)). Some deployments already run Re:Earth Accounts and want it to own workspaces, memberships and decisions. Other deployments need machine callers, such as import jobs, that have no end user. The local directory must stay the default, and nothing from accounts may enter `core/`.

Swapping three classes in the composition roots does not work:

1. Accounts answers only for a caller that presents a token. `checkPermission` needs a user JWT (`handlers/permission.go`), and the only caller-scoped membership read is `GET /api/workspaces?user_id=` with the caller's own token. Serve verifies the token in `authMiddleware` and then drops it.
2. Accounts keys members by its own user id. Serve keys `members.user_id`, `projects.owner_id` and every principal by `sub`.
3. The SQL asset and job list filter joins the local `members` table in `adapters/sql/stores.ts`, so `MemberStore` cannot be swapped while that query exists.
4. The authorizer sees neither the workspace nor a stable resource. `resource.id` is a workspace id for `project:create` and an asset or job id elsewhere, so a planned per-project role in accounts would never apply.

Two defects shape the design. First, `core/auth/roles.ts` has no `project:upload` and no `asset:update`, so the default authorizer answers 404 to every upload into a workspace project and every asset update, for every role. Second, accounts merges a user's global roles into their workspace roles (`interactor/cerbos.go`), and its migration gives every workspace member a global `maintainer` role (`internal/app/migration.go`). A rule that admits `maintainer` therefore admits every migrated reader ([accounts issue #266](https://github.com/reearth/reearth-accounts/issues/266)).

## Decision

### Policy table

`POLICY` in `core/auth/permissions.ts` maps each resource kind and action to the lowest Serve role allowed. `ResourceKind`, `ActionOf<K>`, `allows()`, `policyEntries()`, `SimpleAuthorizer` and every contract test derive from it, and `core/auth/roles.ts` is deleted. Assets and jobs are not authorization resources. They inherit from their project.

| Kind | Action | Lowest role |
|---|---|---|
| `workspace` | `read` | viewer |
| `workspace` | `delete` | owner |
| `workspace` | `manage_members` | admin |
| `workspace` | `create_project` | admin |
| `project` | `read` | viewer |
| `project` | `delete` | owner |
| `project` | `read_asset`, `read_job` | viewer |
| `project` | `create_asset`, `update_asset`, `delete_asset`, `extract_asset`, `retry_job` | editor |
| `project` | `manage_webhooks` | admin |

This table replaces the role and permission table of ADR-002. Project delete stays owner-only, as there. `workspace:update` is dropped, because no route uses it. `manage_webhooks` has no route yet. It is in the table so that webhook management needs no policy change later. `canManageRole` moves into the same file unchanged.

Any new action goes in through one procedure, the policy action change. The first is `manage_hosts` from open PR #16, at `editor` in Serve and `writer` in accounts.

1. The Serve PR adds the action to `POLICY`.
2. The same PR updates the Cerbos example in `docs/examples/cerbos/`.
3. A paired reearth-accounts PR adds the action to the Go table of decision 10.
4. The Serve PR bumps the pinned accounts commit that the accounts contract test runs against.
5. Every count in a test or check derives from `policyEntries()`, never from a literal number.

### Core types

- `AuthzRequest` is a discriminated union on kind, so `{ kind: "project", action: "manage_members" }` does not compile. Every request carries `workspaceId` and `principal { id, role }`. A project request carries the project id as its resource.
- `CerbosAuthorizer` sends kind `workspace` or `project`, the workspace or project id as the resource id, `roles: [role]` and `attr: { workspaceId }`.
- `VerifiedCaller` is `user` or `service` (decision 11). Both hold a `BearerCredential`, which keeps the token in a `#private` field and prints `[redacted]` from `toJSON`, `toString` and `util.inspect`. Handlers never see the token.
- `AuthUser` gains `id`, the directory key. It is `sub` in the local directory and the accounts user id in accounts mode. `GET /me` still returns `sub`.
- `TenantScope` is `{ workspaces, members, authorizer, admin }`, bound to one caller. Read ports and write ports are separate, and `admin: null` means another system owns membership. `members.listByUser(userId)` becomes `members.listForCaller()` with no row cap.
- `ListScope` is `session`, `project`, `workspace` or `visible`. `visible` carries the caller's workspace ids and owner id, so unscoped lists keep the caller's ownerless projects without a `members` join. SQL binds the ids as one JSON parameter through `json_each(?)`, so D1's 100-parameter limit never applies.
- `ProjectStore.list` takes a `workspace` or `created` scope, where `created` carries `ownerId` and `memberOf`, and SQL binds `memberOf` through `json_each(?)` as it does for `visible`.

### 1. A per-request tenancy port

`Tenancy.enter(caller)` in `core/tenancy/port.ts` turns a verified caller into a directory user and binds stores and an authorizer to that caller. `tenancyMiddleware` runs after the auth middleware and before the session middleware, which amends ADR-002's middleware order. It calls `enter(caller)` on `/api/v1/*`. On `/api/internal/*`, `/files`, health and the OpenAPI routes it sets `enter(null)`, so a token there costs no directory call. `LocalTenancy` returns the shared SQL stores with `id = sub`, so existing rows need no migration. `AccountsTenancy` closes its stores over the caller's credential, so the token reaches exactly one adapter. The session middleware decides that a request is authenticated from the verified caller, so a route that skips tenancy never mints an anonymous session for a token holder.

A public file read makes no directory call, and neither does a read that a delivery token authorizes (the delivery token section of ADR-014, in review on [PR #16](https://github.com/reearth/reearth-serve/pull/16)). Only a restricted file read that carries an OIDC bearer binds tenancy, through `enterCaller(c, caller)`, which `core/tenancy/middleware.ts` exports and `tenancyMiddleware` itself uses.

### 2. One decision path

`core/auth/access.ts` is the only caller of `Authorizer.check`. `authorizeWorkspace`, `authorizeProject`, `authorizeAsset` and `authorizeJob` return `ok`, `not_found` or `forbidden`, and replace the inline `members.find` plus `check` chains in the handlers. `deniedResponse` maps the decision to a status. `not_found` is always 404. `forbidden` is 403 on `POST /api/v1/projects` with a `workspaceId`, `DELETE /api/v1/workspaces/:id`, and the three member writes (`POST /api/v1/workspaces/:workspaceId/members`, and `PATCH` and `DELETE` on `/api/v1/workspaces/:workspaceId/members/:userId`), as today, because those routes pass `forbiddenAs: 403`. A route that names no `forbiddenAs` gets 404, so a caller who cannot act learns nothing about existence. Those routes are workspace and member reads, `GET` and `DELETE /api/v1/projects/:id`, asset, job and upload routes, and restricted `/files` reads. The ownerless-project shortcut and the anonymous session match stay as they are.

A list scoped by project checks the item action, so `GET /api/v1/assets?projectId=` checks `read_asset` and `GET /api/v1/jobs?projectId=` checks `read_job`, and listing an asset needs the same action as reading it. Trunk checked project `read` there. The `workspaceId` branches of the project, asset and job lists check `workspace:read`. Those branches and the unscoped asset and job lists are decided at workspace granularity, by `workspace:read` or the SQL visibility join, never per project. A policy that narrows one project does not hide that project's rows from those lists. The unscoped project list is also decided by membership, so a policy that denies one project does not hide its name from `GET /api/v1/projects`.

### 3. A role floor in every mode

`access.ts` allows a request only when `allows(memberRole, kind, action)` and `authorizer.check` both pass. It checks the floor first, so a floor denial makes no authorizer call. In the default mode the two checks agree. In accounts mode the floor stops a migrated reader who holds a global `maintainer` role. The floor is temporary. When accounts stops merging global roles ([#266](https://github.com/reearth/reearth-accounts/issues/266)), or ships per-project roles that can raise a role on one project, the floor moves to the effective role that accounts reports.

### 4. REST for the accounts permission check, with `resource_id` sent now

`AccountsAuthorizer` calls `POST /api/permissions/check` with `service: "serve"`, the kind, the action, the workspace alias and, on project checks only, `resource_id` set to the project id. Accounts' Echo binder ignores unknown JSON fields, so accounts drops `resource_id` today. If per-project roles ship under that name, they apply with no Serve release. The field name is one constant, `RESOURCE_ID_FIELD`. GraphQL would reject the unknown input field and break every check.

### 5. No cross-request cache of aliases, memberships or decisions

Aliases are mutable and reusable, so a cached alias could send a check to another tenant. A removal in accounts takes effect on the next request. Membership comes from one unpaginated `GET /api/workspaces?user_id=<self>`, fetched on first use and memoized for the request. The adapter drops a workspace whose `members` does not include the caller or where the caller's own role does not map, such as `limited`, drops a workspace whose `deleted_at` is set, and drops integration members. Only `sub` to accounts user id is cached, in memory (at most 10,000 entries per isolate) and then KV, for one hour from the fetch. Both entries carry that expiry, so a KV hit cannot extend it. A miss is never cached. Concurrent lookups for one `sub` in an isolate share one `GET /api/users/me`. A KV read failure is a miss, and a KV write failure is logged and ignored. A 401 from the membership read or the check drops the cached mapping from memory and KV.

A project-scoped request makes two accounts calls, the membership read and the check. A restricted `/files` read with an OIDC bearer makes the same two. `GET /me` and unscoped lists make one. A public file read, a delivery-token read, an anonymous request and a service caller make none.

### 6. Accounts mode is read-only for tenancy

With `admin: null`, workspace create and delete and the member routes answer `405 {"error":"Workspaces and members are managed by an external directory"}`. Accounts owns those rules (owner transfer, the last owner, aliases). `POST /api/v1/projects` without `workspaceId` answers `400 {"error":"workspaceId is required"}`, so no new ownerless project is created in accounts mode.

Local-directory data does not carry over. `owner_id` holds `sub`, so ownerless projects created before the switch become unreachable. Accounts mode starts on fresh Serve data.

### 7. One switch, and accounts stays an optional adapter

`adapters/tenancy.ts` holds `parseTenancyConfig` and `buildTenancy`, and both composition roots call them. An operator sets at most one backend:

| Setting | Workspaces and members | Decisions |
|---|---|---|
| none (default) | D1 or SQLite | `SimpleAuthorizer` over `POLICY` |
| `CERBOS_ENDPOINT` | D1 or SQLite | the operator's Cerbos PDP |
| `ACCOUNTS_URL` | accounts, read-only in Serve | accounts, service `serve` |

`SERVICE_CLIENTS` (decision 11) works with any backend. Setting both backends is a config error, and so is `ACCOUNTS_URL` without `OIDC_ISSUER_URL`.

Accounts code lives only in `adapters/accounts/`, and only `ACCOUNTS_URL` loads it: `adapters/tenancy.ts` imports it with a dynamic `import()` on the first `enter` in accounts mode. Nothing in `core/` or `shared/` names accounts or Re:Earth. Core error messages say "external directory", and accounts settings are documented in `adapters/accounts/README.md`.

### 8. Failure is closed

- An accounts 401 becomes `UnknownAccountError`, which answers `401 {"error":"No directory user is linked to this identity"}`.
- An accounts timeout (3 s), 5xx or parse failure, including a malformed field such as `created_at`, becomes `TenancyUnavailableError`. A Cerbos timeout or non-2xx does too. A refused Cerbos connection, a timeout while the response body is read and a malformed decision body also answer 503, and a `CERBOS_ENDPOINT` that is not an http or https URL is a config error. `app.onError` answers `503 {"error":"Authorization service unavailable"}` with `Retry-After: 5`.
- `AccountsAuthorizer` denies without a call when `principal.id` differs from the session's directory user id.
- `ACCOUNTS_URL` must be an http or https origin, with no userinfo, no path other than `/`, no query and no fragment. It must use https unless its host is `localhost`, `127.0.0.1` or `[::1]`. Serve refuses redirects and reads a body only from a 2xx answer.
- A config error names the setting. Node exits non-zero at startup. On Workers, `buildDeps` reads config on every invocation, and the `fetch` handler in `runtime/cloudflare/index.ts` catches its error. Every `/api/` and `/files` request then answers `500 {"error":"Server misconfigured"}`, and the log names the setting. A queue batch or cron tick logs the same error and throws, so queue messages retry. Every ADR that adds a setting reports its config errors this way.

### 9. Boundaries are enforced by a test

`scripts/boundaries.test.ts` runs in the unit project and fails `npm run check` in six cases. It sits outside `core/`, so rule 3 never matches the test's own patterns.

1. A non-test file under `core/` or `shared/` imports from `adapters/` or `runtime/`. Files named `*.test.ts` are exempt from this rule only, because they test ports against `adapters/memory/`.
2. A file outside `adapters/accounts/` imports past `adapters/accounts/index.ts`.
3. A file under `core/` or `shared/` matches `\baccounts\b` or `re:?earth`, ignoring case, except the CLI name `reearth-serve` and the `@reearth/` npm scope. To pass, the OpenAPI title becomes "Serve API", and the "Re:Earth CMS" comments in `core/app.test.ts` and `shared/api.ts` say "an external client".
4. A file other than `core/auth/access.ts` calls `Authorizer.check`, directly or through an alias of the authorizer.
5. A file outside `adapters/` calls `reveal()` on a credential. `core/auth/types.ts`, which defines `BearerCredential`, is exempt.
6. A file outside `adapters/accounts/` and `e2e/` that is not a test statically imports or re-exports from `adapters/accounts/`. Type-only imports are exempt.

### 10. The accounts policy mirrors `POLICY`

reearth-accounts gains `server/internal/rbac/serve/definitions.go` with `ServiceName = "serve"`, and `cmd/policy-generator` emits `serve_workspace.yaml` and `serve_project.yaml`. Serve's owner, admin, editor and viewer map to accounts' owner, maintainer, writer and reader. The set never lists `self` or `limited`. The existing `accounts` and `accounts-admin` sets do not change. A Go `wantMatrix` test pins the generated rules, because accounts git-ignores generated policies. Serve's accounts contract test checks every accounts role against every `policyEntries()` row at the accounts commit pinned as `ACCOUNTS_SHA` in the `e2e-accounts` CI job, which accepts only a full commit SHA. So the TypeScript and Go tables cannot drift without a failing build. `ACCOUNTS_POLICY_DIR` lets the harness test a policy directory before the accounts generator emits it.

### 11. Service identity

A machine caller is a generic OIDC client-credentials principal from the deployment's OIDC issuer. Every PR that needs a machine caller uses this contract and adds no credential of its own.

- **Classification.** `authMiddleware` verifies the token with the configured issuer and audience, as for users. It then reads the client id from `azp`, or from `client_id` when `azp` is absent. If that id is a key of `SERVICE_CLIENTS`, the caller is `{ kind: "service", clientId, sub, credential }`. Every other token is a user, as before.
- **Config.** `SERVICE_CLIENTS` is a JSON object from client id to its workspaces and role, as in `{"svc-a":{"workspaces":["<workspaceId>"],"role":"editor"}}`. The role is `viewer`, `editor` or `admin`. Unset means no service callers. A malformed value, an unknown role, `owner` or an empty `workspaces` list is a config error that names the client id (decision 8). Operators list only clients that use the client-credentials grant, because a listed client's user tokens would also act as the service.
- **Scope.** `withServiceClients` wraps every tenancy backend. A user caller goes to the backend unchanged. A service caller gets user id `service:<clientId>`, so it never matches a `sub` in `projects.owner_id` or `members.user_id`. `members.find` returns the configured role in a configured workspace and null elsewhere. `listForCaller` returns one membership per configured workspace. `admin` is null, so workspace and member writes answer 405, and project create without `workspaceId` answers 400 as in decision 6.
- **Per mode.** In the local and Cerbos modes the scope uses that mode's authorizer, so a Cerbos policy sees principal `service:<clientId>` with the configured role, and workspaces are read from SQL, limited to the configured ids. In accounts mode the configured ids are accounts workspace ids and the scope uses `SimpleAuthorizer`, because accounts has no machine-to-machine permission path. The scope makes no accounts call. Workspace and member read routes answer 404 to a service, and project, asset and job routes work.
- **Role floor.** Decision 3 applies to services as to users. `owner` is not a service role, so project and workspace delete stay with people.

## Alternatives Considered

- **Accounts as the membership source only, with Serve deciding locally.** Fewer calls, but no `serve` policy in accounts, and per-project roles would become a Serve reimplementation.
- **A credential argument on every store and authorizer method.** It exposes the token to every handler and use case, which `Tenancy.enter` exists to prevent.
- **Write-through accounts stores.** Membership would have two writers with different rules, and accounts cannot grant `owner` over REST.
- **GraphQL for the permission check.** It rejects an early `resource_id` field.
- **Assets and jobs as Cerbos resources.** Accounts would need a registration per asset, or project bindings would never apply.
- **Unknown accounts roles mapped to `viewer`.** It is not fail-closed. Unmapped roles are dropped instead.
- **Per-product service credentials.** They put product names in Serve config and work only for Re:Earth. A client-credentials principal works with any OIDC issuer a deployment configures.
- **Service principals as accounts workspace members now.** Accounts answers `GET /api/users/me` with 401 for an unknown `sub` and has no machine-to-machine path, so service identity would wait on an accounts design. `adapters/accounts/` can read accounts-owned service members later.
- **Lazy tenancy binding inside every handler.** It touches every handler. Skipping the middleware on `/files`, health and the OpenAPI routes removes the same directory calls.

## Consequences

**Positive**

- One table defines every permission in Serve, the Cerbos example and the accounts policy, and tests fail when they drift.
- Editors can upload into workspace projects and update assets, which closes the 404 defect.
- A removal or role change in accounts takes effect on the next request.
- A self-hoster who sets neither `ACCOUNTS_URL` nor `SERVICE_CLIENTS` runs a plain DAM with no accounts code loaded.
- Machine callers work in every mode with a standard OIDC grant.

**Negative**

- A project-scoped request in accounts mode makes two sequential accounts round trips. A cache can go behind `AccountsSession` once latency from Workers is measured.
- Workspace and member writes answer 405 in accounts mode.
- The floor is stricter than accounts. A global role grants nothing outside the caller's workspaces and nothing above the member's own role. `limited` members are treated as non-members until per-project listing exists.
- `POLICY` is mirrored by hand in TypeScript and Go, in exchange for Serve not depending on accounts code.
- In accounts mode a service caller is authorized from Serve config, not by accounts.
- A project in a deactivated accounts workspace answers 404 to every route, delete included, until the workspace is restored.

**Default-mode behaviour changes**

- Editors get 201 on upload into a workspace project and 200 on asset and version updates. Trunk answered 404 to every role.
- An admin who created a workspace project gets 404 on its delete. Trunk answered 204, because any creator could delete.
- A creator demoted to editor gets 404 on the delete. Trunk answered 204.
- A creator removed from the workspace gets 404 on `GET /api/v1/projects/:id`. Trunk answered 200.
- An unscoped `GET /api/v1/projects` lists the caller's created projects minus those in a workspace the caller no longer belongs to; trunk listed by `owner_id` alone, so a removed creator still saw the project's name and `workspaceId` while `GET /api/v1/projects/:id` answered 404.
- Deleting a workspace that still has projects answers `409 {"error":"Workspace still has projects"}`. Delete its projects first. A project whose workspace is gone has no member who can pass the authorizer, so it could never be deleted.
- The ownerless-project shortcut does not change, and the workspace owner still deletes workspace projects. Workspace read, member list and project read go through the authorizer with the same results for all four roles.
- `GET /me` and unscoped lists see every membership. Trunk capped `listByUser` at 200. Unscoped lists include the caller's ownerless projects, which per-item access already allowed.
- A Cerbos timeout or non-2xx answers 503 instead of 500.
- `createdAt` and `updatedAt` on `Workspace` and `Member` become optional in the public API, because an external directory may not keep them. In accounts mode a workspace has `createdAt` and no `updatedAt`, and a member has neither.

**Cerbos upgrade break**

`CerbosAuthorizer` sends kinds `workspace` and `project` with actions such as `create_asset`. A policy written for the old kinds (`asset`, `job`) and actions (`create`, `read`) denies every check after the upgrade. `docs/examples/cerbos/` replaces it, and the README upgrade note names the change.

## Follow-ups

- Accounts must trust Serve's issuer and audience in each environment, or every Serve user gets 401.
- The accounts owners should confirm that per-project roles will read `resource_id`.
- When accounts [#266](https://github.com/reearth/reearth-accounts/issues/266) is fixed, the floor moves to the effective role. The accounts contract test fails when a bumped pin stops merging global roles.
- Platform-wide accounts roles see no workspace they are not a member of. A read-only platform view would need accounts to report platform roles separately.
- Measure the two-call latency from Cloudflare Workers before adding any cache.
- The accounts policy deploy needs a `serve` target in the Re:Earth deploy pipeline. That is a shared-environment change outside this repository.

## Implementation reconciliation

Code PRs that implement this ADR record each accepted deviation here.
