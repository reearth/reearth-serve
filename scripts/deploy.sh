#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"
WRANGLER_CONFIG="${PROJECT_DIR}/wrangler.toml"
ENV_FILE="${PROJECT_DIR}/.env"

if [ ! -f "${ENV_FILE}" ]; then
  echo "Error: .env file not found. Copy .env.example to .env and fill in the values."
  exit 1
fi

# shellcheck source=/dev/null
source "${ENV_FILE}"

# Validate required variables
for var in CLOUDFLARE_ACCOUNT_ID CLOUDFLARE_KV_NAMESPACE_ID CLOUDFLARE_R2_BUCKET_NAME; do
  if [ -z "${!var:-}" ]; then
    echo "Error: ${var} is not set in .env"
    exit 1
  fi
done

# Backup and inject values into wrangler.toml
WRANGLER_BACKUP="${WRANGLER_CONFIG}.bak.$$"
cp "${WRANGLER_CONFIG}" "${WRANGLER_BACKUP}"

restore() {
  mv "${WRANGLER_BACKUP}" "${WRANGLER_CONFIG}"
}
trap restore EXIT

sed -i '' "s|id = \"KV_NAMESPACE_ID\"|id = \"${CLOUDFLARE_KV_NAMESPACE_ID}\"|" "${WRANGLER_CONFIG}"
sed -i '' "s|bucket_name = \"reearth-serve\"|bucket_name = \"${CLOUDFLARE_R2_BUCKET_NAME}\"|" "${WRANGLER_CONFIG}"

echo "Deploying..."
CLOUDFLARE_ACCOUNT_ID="${CLOUDFLARE_ACCOUNT_ID}" \
CLOUDFLARE_API_TOKEN="${CLOUDFLARE_API_TOKEN:-}" \
npx wrangler deploy

echo "Done!"
