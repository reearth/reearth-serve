#!/usr/bin/env bash
# Run the e2e suite against the Node runtime (runtime/node), with no cloud
# credentials and no wrangler: SQLite in memory, in-process file storage, the
# SQL-backed kv/queue tables. See scripts/e2e.sh for the Cloudflare variant.
set -euo pipefail

PORT="${E2E_PORT:-8788}"
ENDPOINT="http://localhost:${PORT}"
MOCK_OIDC_PORT="${MOCK_OIDC_PORT:-18998}"
# Mock DNS-over-HTTPS resolver, so custom-domain verification (ADR-013 B5) can
# be driven end to end without asking a public resolver about a domain we do
# not own.
MOCK_DOH_PORT="${MOCK_DOH_PORT:-18997}"
INTERNAL_API_SECRET="${INTERNAL_API_SECRET:-e2e-internal-secret}"
# Password-protected sites (ADR-013 B7). Without it a protected asset is
# fail-closed 503 and the PATCH that protects one is refused, so the access
# suite would be testing the missing-secret path rather than the feature.
SIGNING_SECRET="${SIGNING_SECRET:-e2e-signing-secret}"
# Site hosts (ADR-013 B1). The suffix carries the port because it is compared
# against the Host header verbatim; the apex ("localhost:PORT") does not end
# with it, so every other test is unaffected.
SITE_HOST_SUFFIX="${SITE_HOST_SUFFIX:-.localhost:${PORT}}"

cleanup() {
  if [ -n "${SERVER_PID:-}" ]; then
    echo "Stopping Node runtime (PID $SERVER_PID)..."
    kill "$SERVER_PID" 2>/dev/null || true
    wait "$SERVER_PID" 2>/dev/null || true
  fi
  if [ -n "${OIDC_PID:-}" ]; then
    echo "Stopping mock OIDC server (PID $OIDC_PID)..."
    kill "$OIDC_PID" 2>/dev/null || true
    wait "$OIDC_PID" 2>/dev/null || true
  fi
  if [ -n "${DOH_PID:-}" ]; then
    echo "Stopping mock DoH server (PID $DOH_PID)..."
    kill "$DOH_PID" 2>/dev/null || true
    wait "$DOH_PID" 2>/dev/null || true
  fi
}
trap cleanup EXIT

echo "Starting mock OIDC server on port ${MOCK_OIDC_PORT}..."
MOCK_OIDC_PORT="${MOCK_OIDC_PORT}" npx tsx e2e/mock-oidc.ts &
OIDC_PID=$!

for _ in $(seq 1 20); do
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

echo "Starting mock DoH resolver on port ${MOCK_DOH_PORT}..."
MOCK_DOH_PORT="${MOCK_DOH_PORT}" npx tsx e2e/mock-doh.ts &
DOH_PID=$!

for _ in $(seq 1 20); do
  if curl -sf "http://localhost:${MOCK_DOH_PORT}/dns-query?name=x&type=TXT" > /dev/null 2>&1; then
    echo "Mock DoH resolver is ready."
    break
  fi
  if ! kill -0 "$DOH_PID" 2>/dev/null; then
    echo "Mock DoH resolver exited unexpectedly."
    exit 1
  fi
  sleep 0.5
done

DOH_URL="http://localhost:${MOCK_DOH_PORT}/dns-query"

echo "Starting Node runtime on port ${PORT}..."
PORT="${PORT}" \
BASE_URL="${ENDPOINT}" \
SQLITE_PATH=":memory:" \
INTERNAL_API_SECRET="${INTERNAL_API_SECRET}" \
SIGNING_SECRET="${SIGNING_SECRET}" \
ANONYMOUS_UPLOAD_ENABLED="true" \
OIDC_ISSUER_URL="${OIDC_ISSUER}" \
OIDC_AUDIENCE="e2e-audience" \
CONTAINER_LAUNCHER="none" \
SITE_HOST_SUFFIX="${SITE_HOST_SUFFIX}" \
SITE_DNS_RESOLVER_URL="${DOH_URL}" \
  npm run start:node &
SERVER_PID=$!

echo "Waiting for server at ${ENDPOINT}..."
for _ in $(seq 1 30); do
  if curl -sf "${ENDPOINT}/api/v1/health" > /dev/null 2>&1; then
    echo "Server is ready."
    break
  fi
  if ! kill -0 "$SERVER_PID" 2>/dev/null; then
    echo "Node runtime exited unexpectedly."
    exit 1
  fi
  sleep 1
done

if ! curl -sf "${ENDPOINT}/api/v1/health" > /dev/null 2>&1; then
  echo "Server did not become ready within 30 seconds."
  exit 1
fi

echo "Running E2E tests against the Node runtime..."
# Features this runtime does not have: presigned uploads need an S3-compatible
# store, archive extraction needs a container launcher, and thumbnail
# generation needs the bundled jSquash wasm. Each is skipped by its own flag.
E2E_ENDPOINT="${ENDPOINT}" \
E2E_MOCK_OIDC="http://localhost:${MOCK_OIDC_PORT}" \
E2E_INTERNAL_API_SECRET="${INTERNAL_API_SECRET}" \
E2E_SITE_HOST_SUFFIX="${SITE_HOST_SUFFIX}" \
E2E_MOCK_DOH="http://localhost:${MOCK_DOH_PORT}" \
E2E_PRESIGNED="false" \
E2E_CONTAINER="false" \
E2E_THUMBNAILS="false" \
  npm run test:e2e -- "$@"
