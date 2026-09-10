#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"
WRANGLER_CONFIG="${PROJECT_DIR}/wrangler.toml"
ENV_FILE="${PROJECT_DIR}/.env"

# CI mode: use env vars directly instead of .env file
if [ "${CI:-}" = "true" ]; then
  echo "Running in CI mode"
else
  if [ ! -f "${ENV_FILE}" ]; then
    echo "Error: .env file not found. Copy .env.example to .env and fill in the values."
    exit 1
  fi
  # shellcheck source=/dev/null
  source "${ENV_FILE}"
fi

# Validate required variables
for var in CLOUDFLARE_KV_NAMESPACE_ID CLOUDFLARE_D1_DATABASE_ID CLOUDFLARE_R2_BUCKET_NAME; do
  if [ -z "${!var:-}" ]; then
    echo "Error: ${var} is not set"
    exit 1
  fi
done

# Resolve the account. CLOUDFLARE_ACCOUNT_ID wins when set. Otherwise ask the
# API which accounts the token can see: exactly one is used as-is; several are
# disambiguated by CLOUDFLARE_ACCOUNT_NAME; anything else is an error listing
# the candidates. wrangler would prompt interactively here, which hangs in CI.
resolve_account_id() {
  if [ -n "${CLOUDFLARE_ACCOUNT_ID:-}" ]; then
    return 0
  fi
  if [ -z "${CLOUDFLARE_API_TOKEN:-}" ]; then
    echo "Error: CLOUDFLARE_ACCOUNT_ID is not set and CLOUDFLARE_API_TOKEN is missing, so it cannot be auto-selected"
    exit 1
  fi
  local response
  response=$(curl -sS --fail-with-body \
    -H "Authorization: Bearer ${CLOUDFLARE_API_TOKEN}" \
    "https://api.cloudflare.com/client/v4/accounts?per_page=50") || {
    echo "Error: could not list Cloudflare accounts: ${response}"
    exit 1
  }
  # One "<id>\t<name>" line per account.
  local accounts
  accounts=$(printf '%s' "${response}" | node -e '
    const body = JSON.parse(require("fs").readFileSync(0, "utf8"));
    if (!body.success) { console.error(JSON.stringify(body.errors)); process.exit(1); }
    for (const a of body.result) console.log(`${a.id}\t${a.name}`);
  ') || { echo "Error: Cloudflare API rejected the account listing"; exit 1; }

  local count
  count=$(printf '%s\n' "${accounts}" | grep -c . || true)
  if [ "${count}" -eq 0 ]; then
    echo "Error: the API token has access to no Cloudflare accounts"
    exit 1
  fi
  if [ -n "${CLOUDFLARE_ACCOUNT_NAME:-}" ]; then
    CLOUDFLARE_ACCOUNT_ID=$(printf '%s\n' "${accounts}" | awk -F'\t' -v n="${CLOUDFLARE_ACCOUNT_NAME}" '$2 == n { print $1; exit }')
    if [ -z "${CLOUDFLARE_ACCOUNT_ID}" ]; then
      echo "Error: no account named '${CLOUDFLARE_ACCOUNT_NAME}'. Accounts visible to this token:"
      printf '%s\n' "${accounts}" | sed 's/^/  /'
      exit 1
    fi
  elif [ "${count}" -eq 1 ]; then
    CLOUDFLARE_ACCOUNT_ID=$(printf '%s\n' "${accounts}" | cut -f1)
  else
    echo "Error: the API token can see ${count} accounts; set CLOUDFLARE_ACCOUNT_ID or CLOUDFLARE_ACCOUNT_NAME:"
    printf '%s\n' "${accounts}" | sed 's/^/  /'
    exit 1
  fi
  echo "Auto-selected Cloudflare account: $(printf '%s\n' "${accounts}" | awk -F'\t' -v id="${CLOUDFLARE_ACCOUNT_ID}" '$1 == id { print $2 }') (${CLOUDFLARE_ACCOUNT_ID})"
}
resolve_account_id
export CLOUDFLARE_ACCOUNT_ID

# Backup and inject values into wrangler.toml
WRANGLER_BACKUP="${WRANGLER_CONFIG}.bak.$$"
cp "${WRANGLER_CONFIG}" "${WRANGLER_BACKUP}"

restore() {
  if [ -f "${WRANGLER_BACKUP}" ]; then
    mv "${WRANGLER_BACKUP}" "${WRANGLER_CONFIG}"
  fi
}
trap restore EXIT

# sed -i behaves differently on macOS vs Linux
if [[ "$OSTYPE" == "darwin"* ]]; then
  SED_I="sed -i ''"
else
  SED_I="sed -i"
fi

eval "$SED_I 's|id = \"KV_NAMESPACE_ID\"|id = \"${CLOUDFLARE_KV_NAMESPACE_ID}\"|' '${WRANGLER_CONFIG}'"
eval "$SED_I 's|database_id = \"D1_DATABASE_ID\"|database_id = \"${CLOUDFLARE_D1_DATABASE_ID}\"|' '${WRANGLER_CONFIG}'"
eval "$SED_I 's|bucket_name = \"reearth-serve\"|bucket_name = \"${CLOUDFLARE_R2_BUCKET_NAME}\"|' '${WRANGLER_CONFIG}'"

# Apply D1 migrations before deploying code
echo "Applying D1 migrations..."
CLOUDFLARE_ACCOUNT_ID="${CLOUDFLARE_ACCOUNT_ID}" \
  CLOUDFLARE_API_TOKEN="${CLOUDFLARE_API_TOKEN:-}" \
  npx wrangler d1 migrations apply reearth-serve --remote

echo "Building..."
rm -rf "${PROJECT_DIR}/build"
npm run build --prefix "${PROJECT_DIR}"

echo "Deploying..."
DEPLOY_OUTPUT=$(CLOUDFLARE_ACCOUNT_ID="${CLOUDFLARE_ACCOUNT_ID}" \
  CLOUDFLARE_API_TOKEN="${CLOUDFLARE_API_TOKEN:-}" \
  npx wrangler deploy --containers-rollout immediate 2>&1) || {
  echo "$DEPLOY_OUTPUT"
  echo "❌ wrangler deploy failed"
  exit 1
}
echo "$DEPLOY_OUTPUT"

# Wait for container rollout if image was changed
if echo "$DEPLOY_OUTPUT" | grep -q "No changes to be made\|no changes"; then
  echo "No container changes, skipping rollout wait."
else
  DEPLOYED_TAG=$(echo "$DEPLOY_OUTPUT" | grep -o 'reearth-serve-archiveextractorcontainer:[a-f0-9]*' | tail -1 | cut -d: -f2)

  if [ -n "${DEPLOYED_TAG}" ]; then
    echo "Waiting for container rollout (tag: ${DEPLOYED_TAG})..."

    CONTAINER_ID=$(npx wrangler containers list 2>&1 | grep -o '"id": "[^"]*"' | head -1 | cut -d'"' -f4)

    if [ -n "${CONTAINER_ID}" ]; then
      for i in $(seq 1 30); do
        CURRENT_IMAGE=$(npx wrangler containers info "${CONTAINER_ID}" 2>&1 | grep '"image"')
        if echo "${CURRENT_IMAGE}" | grep -q "${DEPLOYED_TAG}"; then
          echo "Container rollout complete!"
          break
        fi
        if [ "$i" -eq 30 ]; then
          echo "Warning: Container rollout timed out after 5 minutes"
        fi
        sleep 10
      done
    fi
  fi
fi

echo "Done!"
