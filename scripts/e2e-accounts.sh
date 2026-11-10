#!/usr/bin/env bash
set -euo pipefail
# Each job gets its own process group, so cleanup can stop npx and go trees whole.
set -m

ACCOUNTS_DIR="$(cd "${ACCOUNTS_DIR:-../reearth-accounts}" && pwd)"
RUN_ID="${E2E_ACCOUNTS_ID:-e2e}"
ACCOUNTS_PORT="${ACCOUNTS_PORT:-8090}"
MOCK_OIDC_PORT="${MOCK_OIDC_PORT:-18997}"
MONGO_PORT="${MONGO_PORT:-27018}"
CERBOS_PORT="${CERBOS_PORT:-3593}"
MONGO="serve-rbac-mongo-${RUN_ID}"
CERBOS="serve-rbac-cerbos-${RUN_ID}"
ACCOUNTS="http://localhost:${ACCOUNTS_PORT}"
ISSUER="http://localhost:${MOCK_OIDC_PORT}/"
WORK="$(mktemp -d "${TMPDIR:-/tmp}/serve-e2e-accounts.XXXXXX")"
NONCE="${RANDOM}${RANDOM}"
JOBS=()
CONTAINERS=()

cleanup() {
  local status=$?
  if [ "${status}" -ne 0 ] && [ -s "${WORK}/accounts.log" ]; then tail -n 40 "${WORK}/accounts.log" >&2; fi
  if [ "${E2E_ACCOUNTS_KEEP:-}" = "1" ]; then
    local live=()
    for pid in "${JOBS[@]:+${JOBS[@]}}"; do
      if kill -0 "${pid}" 2>/dev/null; then live+=("-${pid}"); fi
    done
    echo "E2E_ACCOUNTS_KEEP=1: leaving the stack up."
    echo "  accounts ${ACCOUNTS} (log ${WORK}/accounts.log), mock OIDC ${ISSUER}"
    echo "  teardown: kill -- ${live[*]:-} 2>/dev/null; docker rm -f ${CONTAINERS[*]:-}; rm -rf ${WORK}"
    return
  fi
  for pid in "${JOBS[@]:+${JOBS[@]}}"; do kill -- "-${pid}" 2>/dev/null || true; done
  if [ "${#CONTAINERS[@]}" -gt 0 ]; then docker rm -f "${CONTAINERS[@]}" > /dev/null 2>&1 || true; fi
  rm -rf "${WORK}"
}
trap cleanup EXIT
trap 'exit 130' INT TERM

background() {
  "$@" &
  JOBS+=("$!")
}

foreground() {
  "$@" &
  JOBS+=("$!")
  wait "$!"
}

refuse_taken() {
  if (exec 3<> "/dev/tcp/localhost/$2") 2>/dev/null; then
    echo "Port $2 for $1 is already in use. Stop whatever listens there or pick another port." >&2
    exit 1
  fi
}

container() {
  local name="$1"
  shift
  docker run -d --name "${name}" "$@" > /dev/null
  CONTAINERS+=("${name}")
}

wait_until() {
  local what="$1" pid="$2"
  shift 2
  for _ in $(seq 1 60); do
    if "$@" > /dev/null 2>&1; then return; fi
    if [ -n "${pid}" ] && ! kill -0 "${pid}" 2>/dev/null; then
      echo "${what} exited before it came up" >&2
      exit 1
    fi
    sleep 0.5
  done
  echo "${what} did not come up" >&2
  exit 1
}

if [ -z "${ACCOUNTS_BIN:-}" ]; then
  echo "Building accounts from ${ACCOUNTS_DIR}..."
  foreground go -C "${ACCOUNTS_DIR}/server" build -o "${WORK}/accounts" ./cmd/reearth-accounts
  ACCOUNTS_BIN="${WORK}/accounts"
fi

echo "Generating policies with accounts' policy-generator..."
foreground go -C "${ACCOUNTS_DIR}/server" build -o "${WORK}/policy-generator" ./cmd/policy-generator
(cd "${WORK}" && ./policy-generator)
if [ -n "${ACCOUNTS_POLICY_DIR:-}" ]; then
  echo "Overlaying policies from ${ACCOUNTS_POLICY_DIR}..."
  cp "${ACCOUNTS_POLICY_DIR}"/*.yaml "${WORK}/policies/"
fi
POLICY_KINDS="$(npx tsx --input-type=module --eval 'import { ACCOUNTS_SERVICE } from "./adapters/accounts"; import { POLICY } from "./core/auth/permissions"; console.log(ACCOUNTS_SERVICE, ...Object.keys(POLICY))')"
read -r SERVICE KINDS <<< "${POLICY_KINDS}"
if [ -z "${KINDS:-}" ]; then
  echo "Could not read the Serve policy kinds, got: ${POLICY_KINDS}" >&2
  exit 1
fi
for kind in ${KINDS}; do
  if [ ! -f "${WORK}/policies/${SERVICE}_${kind}.yaml" ]; then
    echo "No ${SERVICE}_${kind}.yaml: this accounts checkout does not generate the ${SERVICE} policy. Set ACCOUNTS_POLICY_DIR." >&2
    exit 1
  fi
done
cat > "${WORK}/policies/.cerbos.yaml" <<'EOF'
server: { httpListenAddr: ":3593", grpcListenAddr: ":3593" }
engine: { defaultPolicyVersion: "default" }
auxData: { jwt: { disableVerification: true } }
storage: { driver: "disk", disk: { directory: "/policies", watchForChanges: true } }
EOF

echo "Starting Mongo (${MONGO}) and Cerbos (${CERBOS})..."
refuse_taken Mongo "${MONGO_PORT}"
refuse_taken Cerbos "${CERBOS_PORT}"
container "${MONGO}" -p "127.0.0.1:${MONGO_PORT}:27017" mongo:7-jammy
container "${CERBOS}" -p "127.0.0.1:${CERBOS_PORT}:3593" -v "${WORK}/policies:/policies:ro" \
  cerbos/cerbos:0.40.0 server --config=/policies/.cerbos.yaml
wait_until Cerbos "" curl -sf "http://localhost:${CERBOS_PORT}/_cerbos/health"
wait_until Mongo "" docker exec "${MONGO}" mongosh --quiet --eval 'db.runCommand({ ping: 1 })'

echo "Starting mock OIDC on ${MOCK_OIDC_PORT}..."
refuse_taken "mock OIDC" "${MOCK_OIDC_PORT}"
background env MOCK_OIDC_PORT="${MOCK_OIDC_PORT}" npx tsx e2e/mock-oidc.ts
wait_until "Mock OIDC" "$!" curl -sf "${ISSUER}.well-known/openid-configuration"

# accounts' envconfig also reads the unprefixed PORT and HOST.
ACCOUNTS_ENV=(
  -u PORT -u HOST
  SKIP_DOTENV=true
  REEARTH_ACCOUNTS_DB="mongodb://127.0.0.1:${MONGO_PORT}"
  REEARTH_ACCOUNTS_DB_NAME="serve-rbac-${RUN_ID}"
  REEARTH_PORT="${ACCOUNTS_PORT}"
  CERBOS_HOST="localhost:${CERBOS_PORT}"
  REEARTH_ACCOUNTS_CERBOS_USE_SSL=false
  REEARTH_AUTH_ISS="${ISSUER}"
  REEARTH_AUTH_AUD=e2e-audience
  REEARTH_AUTH_ALG=RS256
)

migrate() {
  echo "Running the accounts role migration..."
  foreground env "${ACCOUNTS_ENV[@]}" RUN_MIGRATION=true "${ACCOUNTS_BIN}" >> "${WORK}/accounts.log" 2>&1
}

run_phase() {
  echo "Running the ${1} phase..."
  foreground env \
    E2E_ACCOUNTS_URL="${ACCOUNTS}" \
    E2E_MOCK_OIDC="http://localhost:${MOCK_OIDC_PORT}" \
    E2E_ACCOUNTS_PHASE="$1" \
    E2E_ACCOUNTS_NONCE="${NONCE}" \
    npm run test:e2e -- --reporter=default --reporter=json --outputFile.json="${WORK}/$1.json" \
      e2e/accounts-contract.test.ts "${@:2}"
  node -e '
    const { testResults } = JSON.parse(require("node:fs").readFileSync(process.argv[1], "utf8"));
    const idle = testResults.filter((file) => !file.assertionResults.some((test) => test.status === "passed"));
    for (const file of idle) console.error(`${file.name}: no test passed in the ${process.argv[2]} phase`);
    process.exit(idle.length > 0 || testResults.length === 0 ? 1 : 0);
  ' "${WORK}/$1.json" "$1"
}

migrate
echo "Starting accounts on ${ACCOUNTS_PORT}..."
refuse_taken accounts "${ACCOUNTS_PORT}"
background env "${ACCOUNTS_ENV[@]}" "${ACCOUNTS_BIN}" >> "${WORK}/accounts.log" 2>&1
wait_until Accounts "$!" curl -sf "${ACCOUNTS}/api/auth/config"

run_phase fresh "$@"
migrate
run_phase migrated "$@"
