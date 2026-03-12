#!/usr/bin/env bash
set -euo pipefail

PORT="${E2E_PORT:-5173}"
ENDPOINT="http://localhost:${PORT}"

cleanup() {
  if [ -n "${DEV_PID:-}" ]; then
    echo "Stopping dev server (PID $DEV_PID)..."
    kill "$DEV_PID" 2>/dev/null || true
    wait "$DEV_PID" 2>/dev/null || true
  fi
}
trap cleanup EXIT

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
E2E_ENDPOINT="${ENDPOINT}" npm run test:e2e -- "$@"
