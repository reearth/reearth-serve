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
for var in CLOUDFLARE_ACCOUNT_ID CLOUDFLARE_KV_NAMESPACE_ID CLOUDFLARE_D1_DATABASE_ID CLOUDFLARE_R2_BUCKET_NAME; do
  if [ -z "${!var:-}" ]; then
    echo "Error: ${var} is not set"
    exit 1
  fi
done

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
