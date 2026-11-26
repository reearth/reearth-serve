# Accounts adapter

An optional adapter that takes workspaces, memberships and decisions from [Re:Earth Accounts](https://github.com/reearth/reearth-accounts). The design is [ADR-016](../../docs/adr/016-accounts-authorization.md). A deployment that does not set `ACCOUNTS_URL` never loads this directory. `adapters/tenancy.ts` imports it dynamically on the first request in accounts mode, and rule 6 of `scripts/boundaries.test.ts` fails on any static import from shipped code.

Other code imports it only through `index.ts`, which exports:

- `accountsTenancy`, the tenancy backend that `adapters/tenancy.ts` builds when `ACCOUNTS_URL` is set.
- `ACCOUNTS_SERVICE`, the Cerbos service name of Serve's policy in accounts (`serve`). No other file spells it.
- `toAccountsRole` and `fromAccountsRole`, the role map of ADR-016 decision 10. `fromAccountsRole` answers `null` for `limited` and for any name it does not know.

| Serve | Accounts |
|---|---|
| `owner` | `owner` |
| `admin` | `maintainer` |
| `editor` | `writer` |
| `viewer` | `reader` |

## Accounts mode

Set `ACCOUNTS_URL` to the accounts base URL, the origin that serves `/api/users/me`. An operator sets at most one backend:

| Setting | Workspaces and members | Decisions |
|---|---|---|
| none (default) | D1 or SQLite | `SimpleAuthorizer` over `POLICY` |
| `CERBOS_ENDPOINT` | D1 or SQLite | the operator's Cerbos PDP |
| `ACCOUNTS_URL` | accounts, read-only in Serve | accounts, service `serve` |

These values are config errors. Node exits at startup with a message that names the setting. On Workers every `/api/` and `/files` request answers `500 {"error":"Server misconfigured"}` and the log names the setting.

- Both `ACCOUNTS_URL` and `CERBOS_ENDPOINT`.
- `ACCOUNTS_URL` without `OIDC_ISSUER_URL`. Accounts decides only for a caller that presents a token.
- An `ACCOUNTS_URL` that is not an http or https URL.
- An `ACCOUNTS_URL` with userinfo, a path other than `/`, a query or a fragment.
- An `http://` `ACCOUNTS_URL` whose host is not `localhost`, `127.0.0.1` or `[::1]`. Serve sends every caller's token to accounts.

Accounts must accept Serve's tokens. Configure its issuer and audience to match `OIDC_ISSUER_URL` and `OIDC_AUDIENCE`, or every caller gets `401`.

Every accounts call carries the caller's own token, with a 3 s timeout. Serve refuses a redirect and reads a body only from a 2xx answer:

| Call | When |
|---|---|
| `GET /api/users/me` | The caller's accounts user id is not cached |
| `GET /api/workspaces?user_id=<self>` | The first membership read of a request. Later reads in the same request reuse it |
| `POST /api/permissions/check` | Each decision. The body names service `serve`, the kind, the action, the workspace's current alias and, for a project, `resource_id` |

A project-scoped request costs two calls, `GET /me` and an unscoped list cost one, and a public file read, health and an anonymous request cost none. The token's `sub` to accounts user id mapping is cached in memory (at most 10,000 entries per isolate) and then in KV, for one hour from the fetch. Concurrent lookups for one `sub` in an isolate share one `GET /api/users/me`. A request that joins another request's lookup waits at most the 3 second accounts timeout and then answers `503`, since on Workers the request that started the lookup can be cancelled before it settles. A KV read failure counts as a miss and a KV write failure is logged. A `401` is never cached, and a `401` from a later call drops the cached mapping. Memberships, aliases and decisions are never cached, so a removal or an alias change in accounts takes effect on the next request.

In accounts mode:

- A workspace or a member whose accounts role has no Serve role, such as `limited`, is dropped. So is an integration member, and so is a deactivated workspace (`deleted_at` set).
- Workspace create and delete and the member routes answer `405 {"error":"Workspaces and members are managed by an external directory"}`.
- `POST /api/v1/projects` without `workspaceId` answers `400 {"error":"workspaceId is required"}`.
- Workspaces and members have no `updatedAt`, and members have no `createdAt`.
- An accounts `401` answers `401 {"error":"No directory user is linked to this identity"}`. A timeout, a non-2xx answer or a body Serve cannot parse answers `503 {"error":"Authorization service unavailable"}` with `Retry-After: 5`. Serve never logs an accounts response body.
- Accounts mode starts on fresh Serve data. Projects created under the local directory keep a `sub` in `owner_id` and become unreachable.

## Policy contract test

`npm run test:e2e:accounts` runs `e2e/accounts-contract.test.ts` and `e2e/accounts.test.ts`. The contract test checks that the accounts `serve` policy grants each action of `POLICY` (`core/auth/permissions.ts`) to exactly the accounts roles that map to the Serve roles `POLICY` allows. It runs `scripts/e2e-accounts.sh`, which needs Go, Docker and `curl`:

1. It builds accounts and its `policy-generator` from `ACCOUNTS_DIR`, generates the policies, and starts Mongo and Cerbos 0.40.0 in Docker.
2. It starts `e2e/mock-oidc.ts` and accounts on the host, and runs the accounts role migration once so that the role records exist. It then starts Serve on Node with `ACCOUNTS_URL` set.
3. The fresh phase signs up alice, mara, will, rita and dave through the accounts REST API. alice creates a workspace and adds mara as maintainer, will as writer and rita as reader. `e2e/accounts-contract.test.ts` asks `POST /api/permissions/check` for every role and every `policyEntries()` row, and checks that dave, who is not a member, is denied every action. `e2e/accounts.test.ts` seeds its own users and workspace the same way and drives Serve through the role matrix, the `405` writes, the neutral `401`, the two-call budget read from the accounts log, and a member removal and an alias rename that take effect on the next request.
4. It reruns the migration, which grants every workspace member a global `maintainer` role. The migrated phase is the tripwire for [accounts issue #266](https://github.com/reearth/reearth-accounts/issues/266). It expects accounts to allow rita `create_project`, and expects Serve's role floor to refuse rita the same action with `403`. When the tripwire fails, the role floor of ADR-016 decision 3 can move to the effective role.
5. The down phase stops accounts. Signed-in routes then answer `503`, while an anonymous upload and a public file read still work.

An `EXIT` trap removes the containers and stops every process the script started. The phases run test files one at a time, so the accounts log counts only one file's requests.

| Variable | Default | Description |
|---|---|---|
| `ACCOUNTS_DIR` | `../reearth-accounts` | reearth-accounts checkout to build and generate policies from |
| `ACCOUNTS_BIN` | built from `ACCOUNTS_DIR` | Prebuilt accounts server binary. A plain `go build` is a debug build; pass a `-tags release` build to test production auth |
| `ACCOUNTS_POLICY_DIR` | (unset) | Directory of policy YAML files copied over the generated ones. Use it to test a policy before the accounts generator emits it |
| `ACCOUNTS_PORT` | `8090` | Accounts HTTP port |
| `MOCK_OIDC_PORT` | `18997` | Mock OIDC issuer port |
| `E2E_PORT` | `8788` | Port of the Serve instance the script starts |
| `MONGO_PORT` | `27018` | Host port of the Mongo container |
| `CERBOS_PORT` | `3593` | Host port of the Cerbos container |
| `E2E_ACCOUNTS_ID` | `e2e` | Suffix of the container names (`serve-rbac-mongo-<id>`, `serve-rbac-cerbos-<id>`) and the accounts database. Give parallel runs distinct ids and ports |
| `E2E_ACCOUNTS_KEEP` | (unset) | `1` restarts accounts after the down phase, leaves the stack up and prints the teardown command |

The suite skips itself when `E2E_ACCOUNTS_URL` does not answer, so `npm run test:e2e` elsewhere is unaffected.

### CI

The `e2e-accounts` job in `.github/workflows/ci.yml` checks out `reearth/reearth-accounts` at `ACCOUNTS_SHA` and runs the suite. The job fails unless `ACCOUNTS_SHA` is a full commit SHA. A policy action change (ADR-016) adds the action to `POLICY` and to the accounts Go table, then bumps `ACCOUNTS_SHA` to the accounts commit that carries it.
