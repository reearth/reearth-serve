#!/usr/bin/env bash
# Initialize local development secrets in .dev.vars.
# Idempotent: existing values are left alone — re-run anytime to add what's missing.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"
DEV_VARS="${PROJECT_DIR}/.dev.vars"

# ensure_secret <NAME> [<generator-cmd...>]
#   If NAME=... is missing from .dev.vars, generates a value and appends it.
#   Default generator: openssl rand -base64 32
ensure_secret() {
  local name="$1"
  shift
  local generator=("$@")
  if [ ${#generator[@]} -eq 0 ]; then
    generator=(openssl rand -base64 32)
  fi

  if [ -f "${DEV_VARS}" ] && grep -qE "^${name}=" "${DEV_VARS}"; then
    echo "  ${name}: already set, skipping"
    return
  fi

  # Make sure the file exists and ends with a newline before appending.
  if [ ! -f "${DEV_VARS}" ]; then
    : > "${DEV_VARS}"
  elif [ -s "${DEV_VARS}" ] && [ -n "$(tail -c 1 "${DEV_VARS}")" ]; then
    printf '\n' >> "${DEV_VARS}"
  fi

  local value
  value="$("${generator[@]}")"
  printf '%s=%s\n' "${name}" "${value}" >> "${DEV_VARS}"
  echo "  ${name}: generated"
}

echo "Initializing ${DEV_VARS}..."
ensure_secret INTERNAL_API_SECRET
echo "Done."
