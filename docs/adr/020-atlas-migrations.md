# ADR-020: Atlas for Schema Migrations

- **Status:** Proposed
- **Date:** 2026-11-27
- **Deciders:** @rot1024
- **Related:** ADR-003 (KV to D1), ADR-012 (portability)

## Context

The schema lives in hand-written SQL files. `adapters/cloudflare/migrations/`
holds the domain schema that every backend shares. `adapters/sql/migrations/`
holds the `kv` and `queue_messages` tables that only the Node runtime has
(ADR-012 §2). Two appliers read them:

- **D1.** `wrangler d1 migrations apply` runs from `scripts/deploy.sh`
  (`--remote`) and `scripts/e2e.sh` (`--local`). It records each applied file
  name in D1's `d1_migrations` table.
- **Node.** `adapters/memory/sqlite-node.ts` runs `db.exec` on every `.sql`
  file of both directories, in name order, on every open. It records nothing.

Three gaps follow.

1. **An edited migration goes unnoticed.** `d1_migrations` stores names only.
   A file changed after it ran in production replays differently on a fresh
   database, and nothing fails.
2. **Parallel branches pick the same number.** Two open PRs add `0008_*.sql`
   today with different contents. Whichever merges second ships a second
   0008, and wrangler applies both in name order. Nothing flags it.
3. **The Node runtime cannot reopen a database file.** With a persistent
   `SQLITE_PATH`, the second boot re-runs `CREATE TABLE workspaces` and fails.
   Only `:memory:` works.

We want [Atlas](https://github.com/ariga/atlas) to own migration integrity.
Serve is generic OSS, so a contributor must run the whole flow without an
Atlas account.

### What Atlas can do here (measured 2026-11-27)

Atlas v1.4.0 community build (Apache 2), against copies of the migration
directories and a wrangler 4.73 local D1:

| Question | Result |
|---|---|
| Can Atlas reach D1? | No. Its URLs cover `sqlite://` and libSQL. It can open the local D1 `.sqlite` file, never remote D1. |
| Does it read our file names? | Yes. The default `atlas` format reads `0001_create_initial_tables.sql` as version `0001`. |
| Integrity | `atlas migrate hash` writes `atlas.sum`. `migrate validate` fails with `0003_add_cleanup_pending.sql was edited` after an edit. |
| Does wrangler mind `atlas.sum`? | No. With 0001..0007 in `d1_migrations`, `wrangler d1 migrations list --local` shows only a new `.sql` file as pending. |
| Lint | `migrate lint` runs in the community build. A `DROP COLUMN` file gets `DS103` and exit code 1. |
| Declarative `migrate diff` | Unsafe. Diffing the directory against an identical schema writes `DROP INDEX` and `CREATE UNIQUE INDEX` for each inline `UNIQUE` (`asset_versions_asset_id_version` from 0002, `compat_credentials_client_email` from 0008). wrangler fails on that file with `no such index`. Files are named by timestamp, not `NNNN`. |
| Directives | A file starting with `-- atlas:nolint` passes lint with a `DROP TABLE` in it (exit 0; exit 1 without the directive). |
| Atlas as applier | Refuses an existing database without `--baseline` and keeps its own `atlas_schema_revisions` table. |
| Duplicate numbers | Two `0008_*.sql` files pass hash, validate and lint. |
| Install | Community binaries are only at `atlasbinaries.com`, with a `.sha256` beside each. `ariga/setup-atlas` installs the non-community build. There is no `go install` path for v1.x. Old binaries are deleted after about six months. |

## Decision

Atlas is the integrity and lint gate for versioned migration files. wrangler
stays the only applier for D1. The Node runtime keeps applying in-process and
gains its own ledger.

### 1. Versioned files, wrangler applies D1

Migrations stay hand-written `NNNN_name.sql` files in the same two
directories. Create a domain migration with
`wrangler d1 migrations create reearth-serve <name>`, then run
`npm run db:hash`. wrangler applies them to D1, remote and local, and
`d1_migrations` stays the record of what ran.

We do not use declarative `migrate diff`. Its output on this schema fails on
D1, and its timestamp names would sort after every future `NNNN` file.

Deployed databases adopt this with no baseline and no re-run. No file is
renamed and `d1_migrations` is untouched, so wrangler sees the same history.
Atlas keeps no table in D1.

### 2. `atlas.sum` and a CI gate

Each directory gets an `atlas.sum`. `atlas.hcl` at the repository root names
two environments, `d1` and `node`, each with an in-memory SQLite dev database,
so no Docker is needed.

`npm run db:check` runs, for both environments:

1. a sequence check (`scripts/migration-sequence.ts`): prefixes are four
   digits and unique, every file on the base branch is byte-identical, every
   new file sorts after the base branch's highest prefix, no file carries an
   `atlas:nolint` directive (it silences the destructive-change lint), and
   the two directories share no file name;
2. `atlas migrate validate`: `atlas.sum` matches and the files replay;
3. `atlas migrate lint --git-base <base>`: destructive changes fail.

The sequence check covers the collision Atlas does not catch. It fails the
second of two PRs that both add `0008`, which then renumbers.

A `migrations` CI job runs `npm run db:check` with the PR's base branch. It
has `contents: read` and no secrets. `deploy` needs it, so a failing gate
blocks a deploy. The deploy job itself never downloads Atlas.

The job must stay secretless. `migrate validate` and `migrate lint` replay
the PR's SQL in a real SQLite, and SQL such as `ATTACH DATABASE` can write
files on the runner.

The gate catches mistakes, not a hostile author. The checks, `atlas.sum` and
the workflow all live in the PR, so a PR can change them along with a
migration. Lint also ignores data changes such as `DELETE` or `UPDATE`.
Review of the migration files stays the control for what reaches production.

### 3. A pinned binary, verified from the repository

`tools/atlas.lock` holds the version and one sha256 per platform.
`scripts/atlas.sh <args>` downloads the community binary over https, checks
it against the lock (not against the `.sha256` on the same server), caches it
in `.cache/atlas/<version>/`, re-checks the cached copy on every call, and
runs it with the update notifier off. A wrong hash, a failed download or an
unlisted platform stops it before the binary runs. CI caches the binary
keyed on the lock file, so the job keeps working if upstream deletes the
pinned version. A version bump is a PR that changes the lock.

No step calls `atlas login` or Atlas Cloud.

### 4. A ledger for the Node runtime

The Node runtime has no Atlas binary at runtime. It applies pending files
in-process and records each in
`_serve_migrations(set_name, name, sha256, applied_at)`, where `set_name` is
`domain` or `node`. Each file and its row commit together, so a crash leaves
neither. A second boot applies nothing. An applied file whose sha256 changed
raises an error instead of running. A database file that has tables but no
ledger came from the old loop, which never survived a second boot, so it is
refused with a message to recreate it.

`adapters/sql/migrations` stays Node-only and never reaches D1.

## Consequences

- An edit to a merged migration, a duplicate number, or a destructive change
  fails CI before it can deploy.
- Contributors need network access the first time they run `db:check`. They
  need no account.
- Atlas applies nothing anywhere. A bug in Atlas can block a merge, never
  change a database.
- Changes made to remote D1 outside migrations stay undetected. Catching them
  would need a schema export from production on every deploy.
- The Node runtime and D1 keep separate records: `_serve_migrations` and
  `d1_migrations`.

## Alternatives considered

| Option | Why not |
|---|---|
| Atlas applies everywhere (local D1 file and Node, baseline 0007) | It still cannot reach remote D1, so two appliers would diverge. It also puts a binary in the deploy job, next to the Cloudflare token, and in the Node runtime. |
| Declarative schema with `migrate diff` | The diff output fails on D1 today, and its file names break the `NNNN` order. |
| `ariga/setup-atlas` in CI | It installs the non-community build under a different license and checks no pinned hash. |
| Atlas in deploy, diffing a `wrangler d1 export --no-data` dump | Catches drift, but needs the token beside the binary and a production export on every deploy. |
