#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
LOCK="${ROOT}/tools/atlas.lock"

lock_value() {
  sed -n "s/^$1=//p" "$LOCK"
}

case "$(uname -s)" in
  Linux) os=linux ;;
  Darwin) os=darwin ;;
  *) os="$(uname -s)" ;;
esac
case "$(uname -m)" in
  x86_64 | amd64) arch=amd64 ;;
  arm64 | aarch64) arch=arm64 ;;
  *) arch="$(uname -m)" ;;
esac
platform="${os}-${arch}"

version="$(lock_value version)"
pinned_sha256="$(lock_value "$platform")"
if [ -z "$version" ] || [ -z "$pinned_sha256" ]; then
  echo "atlas.sh: no pinned Atlas binary for ${platform} in tools/atlas.lock" >&2
  exit 1
fi

sha256_of() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" | cut -d' ' -f1
  else
    shasum -a 256 "$1" | cut -d' ' -f1
  fi
}

verify_or_delete() {
  local got
  got="$(sha256_of "$1")"
  if [ "$got" != "$pinned_sha256" ]; then
    rm -f "$1"
    echo "atlas.sh: sha256 mismatch for $1 (got ${got}, tools/atlas.lock pins ${pinned_sha256}); deleted it" >&2
    exit 1
  fi
}

dir="${ROOT}/.cache/atlas/${version}"
bin="${dir}/atlas"

if [ ! -f "$bin" ]; then
  mkdir -p "$dir"
  tmp="$(mktemp "${dir}/atlas.download.XXXXXX")"
  trap 'rm -f "$tmp"' EXIT
  url="https://atlasbinaries.com/atlas/atlas-community-${platform}-${version}"
  echo "atlas.sh: downloading ${url}" >&2
  curl --fail --silent --show-error --location --proto =https --proto-redir =https --output "$tmp" "$url"
  verify_or_delete "$tmp"
  chmod +x "$tmp"
  mv "$tmp" "$bin"
  trap - EXIT
fi

verify_or_delete "$bin"
ATLAS_NO_UPDATE_NOTIFIER=1 exec "$bin" "$@"
