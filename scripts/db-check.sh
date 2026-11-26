#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/.."
BASE="${DB_CHECK_BASE:-origin/main}"

node_modules/.bin/tsx scripts/migration-sequence.ts --base "$BASE" adapters/cloudflare/migrations adapters/sql/migrations

for env in d1 node; do
  echo "atlas: validate and lint env ${env} against ${BASE}"
  bash scripts/atlas.sh migrate validate --env "$env"
  bash scripts/atlas.sh migrate lint --env "$env" --git-base "$BASE"
done
