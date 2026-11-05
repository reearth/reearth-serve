# Accounts adapter

An optional adapter that takes workspaces, memberships and decisions from [Re:Earth Accounts](https://github.com/reearth/reearth-accounts). The design is [ADR-016](../../docs/adr/016-accounts-authorization.md). A deployment that does not opt in never loads this directory.

Other code imports it only through `index.ts`, which exports:

- `ACCOUNTS_SERVICE`, the Cerbos service name of Serve's policy in accounts (`serve`). No other file spells it.
- `toAccountsRole` and `fromAccountsRole`, the role map of ADR-016 decision 10. `fromAccountsRole` answers `null` for `limited` and for any name it does not know.

| Serve | Accounts |
|---|---|
| `owner` | `owner` |
| `admin` | `maintainer` |
| `editor` | `writer` |
| `viewer` | `reader` |

## Policy contract test

`npm run test:e2e:accounts` checks that the accounts `serve` policy grants each action of `POLICY` (`core/auth/permissions.ts`) to exactly the accounts roles that map to the Serve roles `POLICY` allows. It runs `scripts/e2e-accounts.sh`, which needs Go, Docker and `curl`:

1. It builds accounts and its `policy-generator` from `ACCOUNTS_DIR`, generates the policies, and starts Mongo and Cerbos 0.40.0 in Docker.
2. It starts `e2e/mock-oidc.ts` and accounts on the host, and runs the accounts role migration once so that the role records exist.
3. The fresh phase signs up alice, mara, will, rita and dave through the accounts REST API. alice creates a workspace and adds mara as maintainer, will as writer and rita as reader. `e2e/accounts-contract.test.ts` asks `POST /api/permissions/check` for every role and every `policyEntries()` row, and checks that dave, who is not a member, is denied every action.
4. It reruns the migration, which grants every workspace member a global `maintainer` role. The migrated phase is the tripwire for [accounts issue #266](https://github.com/reearth/reearth-accounts/issues/266). It expects accounts to allow rita `create_project`. When that test fails, the role floor of ADR-016 decision 3 can move to the effective role.

An `EXIT` trap removes the containers and stops every process the script started.

| Variable | Default | Description |
|---|---|---|
| `ACCOUNTS_DIR` | `../reearth-accounts` | reearth-accounts checkout to build and generate policies from |
| `ACCOUNTS_BIN` | built from `ACCOUNTS_DIR` | Prebuilt accounts server binary. A plain `go build` is a debug build; pass a `-tags release` build to test production auth |
| `ACCOUNTS_POLICY_DIR` | (unset) | Directory of policy YAML files copied over the generated ones. Use it to test a policy before the accounts generator emits it |
| `ACCOUNTS_PORT` | `8090` | Accounts HTTP port |
| `MOCK_OIDC_PORT` | `18997` | Mock OIDC issuer port |
| `MONGO_PORT` | `27018` | Host port of the Mongo container |
| `CERBOS_PORT` | `3593` | Host port of the Cerbos container |
| `E2E_ACCOUNTS_ID` | `e2e` | Suffix of the container names (`serve-rbac-mongo-<id>`, `serve-rbac-cerbos-<id>`) and the accounts database. Give parallel runs distinct ids and ports |
| `E2E_ACCOUNTS_KEEP` | (unset) | `1` leaves the stack up and prints the teardown command |

The suite skips itself when `E2E_ACCOUNTS_URL` does not answer, so `npm run test:e2e` elsewhere is unaffected.

### CI

The `e2e-accounts` job in `.github/workflows/ci.yml` checks out `reearth/reearth-accounts` at `ACCOUNTS_SHA` and runs the suite. The job fails unless `ACCOUNTS_SHA` is a full commit SHA. A policy action change (ADR-016) adds the action to `POLICY` and to the accounts Go table, then bumps `ACCOUNTS_SHA` to the accounts commit that carries it.
