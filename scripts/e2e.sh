#!/usr/bin/env bash
set -euo pipefail

PORT="${E2E_PORT:-5173}"
ENDPOINT="http://localhost:${PORT}"
MOCK_OIDC_PORT="${MOCK_OIDC_PORT:-18999}"
WRANGLER_CONFIG="wrangler.toml"
WRANGLER_BACKUP=""

cleanup() {
  if [ -n "${DEV_PID:-}" ]; then
    echo "Stopping dev server (PID $DEV_PID)..."
    kill "$DEV_PID" 2>/dev/null || true
    wait "$DEV_PID" 2>/dev/null || true
  fi
  if [ -n "${OIDC_PID:-}" ]; then
    echo "Stopping mock OIDC server (PID $OIDC_PID)..."
    kill "$OIDC_PID" 2>/dev/null || true
    wait "$OIDC_PID" 2>/dev/null || true
  fi
  # Restore wrangler.jsonc
  if [ -n "${WRANGLER_BACKUP}" ] && [ -f "${WRANGLER_BACKUP}" ]; then
    mv "${WRANGLER_BACKUP}" "${WRANGLER_CONFIG}"
  fi
  # Remove .dev.vars if created
  rm -f .dev.vars
}
trap cleanup EXIT

# Start mock OIDC server
echo "Starting mock OIDC server on port ${MOCK_OIDC_PORT}..."
MOCK_OIDC_PORT="${MOCK_OIDC_PORT}" npx tsx e2e/mock-oidc.ts &
OIDC_PID=$!

# Wait for mock OIDC server to be ready
for i in $(seq 1 10); do
  if curl -sf "http://localhost:${MOCK_OIDC_PORT}/.well-known/openid-configuration" > /dev/null 2>&1; then
    echo "Mock OIDC server is ready."
    break
  fi
  if ! kill -0 "$OIDC_PID" 2>/dev/null; then
    echo "Mock OIDC server exited unexpectedly."
    exit 1
  fi
  sleep 0.5
done

OIDC_ISSUER="http://localhost:${MOCK_OIDC_PORT}/"

# Clear miniflare persistent state to avoid stale JWKS cache
echo "Clearing miniflare state..."
rm -rf .wrangler/state

# Inject OIDC vars into wrangler.toml (backup original)
WRANGLER_BACKUP="${WRANGLER_CONFIG}.bak.$$"
cp "${WRANGLER_CONFIG}" "${WRANGLER_BACKUP}"

# Inject OIDC vars into wrangler.toml vars section
sed -i '' "/^BASE_URL = /a\\
OIDC_ISSUER_URL = \"${OIDC_ISSUER}\"\\
OIDC_AUDIENCE = \"e2e-audience\"
" "${WRANGLER_CONFIG}"

echo "Starting dev server on port ${PORT}..."
npm run dev -- --port "$PORT" &
DEV_PID=$!

# Wait for the server to be ready
echo "Waiting for server at ${ENDPOINT}..."
for i in $(seq 1 30); do
  if curl -sf "${ENDPOINT}/api/v1/health" > /dev/null 2>&1; then
    echo "Server is ready."
    break
  fi
  if ! kill -0 "$DEV_PID" 2>/dev/null; then
    echo "Dev server exited unexpectedly."
    exit 1
  fi
  sleep 1
done

if ! curl -sf "${ENDPOINT}/api/v1/health" > /dev/null 2>&1; then
  echo "Server did not become ready within 30 seconds."
  exit 1
fi

echo "Running E2E tests..."
E2E_ENDPOINT="${ENDPOINT}" E2E_MOCK_OIDC="http://localhost:${MOCK_OIDC_PORT}" npm run test:e2e -- "$@"
