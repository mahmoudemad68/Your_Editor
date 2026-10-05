#!/bin/sh
# Install pinned supply-chain scanners into a directory on PATH.
# Usage: install-supply-chain-tools.sh [gitleaks|trivy|syft|all]
#        install-supply-chain-tools.sh --verify-archive ARCHIVE_NAME FILE
#
# Archives are downloaded to a file and checked against SHA-256 pins before
# tar runs. The pins were compared with the publishers' checksum files for
# Gitleaks 8.30.1, Trivy 0.75.0, and Syft 1.54.0. A preinstalled binary is
# used only when its version output is exactly the pinned release.
set -eu

GITLEAKS_VERSION=8.30.1
TRIVY_VERSION=0.75.0
SYFT_VERSION=1.54.0

dest="${SUPPLY_CHAIN_BIN:-/usr/local/bin}"
want="${1:-all}"
os_name="$(uname -s | tr '[:upper:]' '[:lower:]')"
arch_name="$(uname -m)"
case "$arch_name" in
  x86_64) arch_name=x64; trivy_arch=Linux-64bit; syft_arch=amd64 ;;
  aarch64|arm64) arch_name=arm64; trivy_arch=Linux-ARM64; syft_arch=arm64 ;;
  *)
    echo "unsupported architecture: $arch_name" >&2
    exit 1
    ;;
esac

# Publisher checksum files, recorded in this script rather than fetched at
# install time (the checksum file would otherwise share the archive's trust):
#   gitleaks_8.30.1_checksums.txt
#   trivy_0.75.0_checksums.txt
#   syft_1.54.0_checksums.txt
checksum_for() {
  case "$1" in
    gitleaks_8.30.1_linux_x64.tar.gz) printf '%s\n' 551f6fc83ea457d62a0d98237cbad105af8d557003051f41f3e7ca7b3f2470eb ;;
    gitleaks_8.30.1_linux_arm64.tar.gz) printf '%s\n' e4a487ee7ccd7d3a7f7ec08657610aa3606637dab924210b3aee62570fb4b080 ;;
    trivy_0.75.0_Linux-64bit.tar.gz) printf '%s\n' c6e65abddb348e25f10549df887045629cf28cc72453cd1c63acb717316b3f3f ;;
    trivy_0.75.0_Linux-ARM64.tar.gz) printf '%s\n' a1ee9f6ffb7d112b64ff726a2a0717c21175c1114361391f4a132956751a13b3 ;;
    syft_1.54.0_linux_amd64.tar.gz) printf '%s\n' 54a87372498168b2d033e876fd41fa4e8035b872699e525a57046e1f2f09c860 ;;
    syft_1.54.0_linux_arm64.tar.gz) printf '%s\n' ee6d4566373a05b344bc6b5f1706f14419bf9338ba39ff686e247deefe9b8818 ;;
    *)
      echo "no pinned checksum for $1" >&2
      exit 1
      ;;
  esac
}

verify_sha256() {
  file="$1"
  expected="$2"
  name="$3"
  if [ ! -f "$file" ]; then
    echo "missing archive: $name" >&2
    exit 1
  fi
  if [ ! -s "$file" ]; then
    echo "empty archive: $name" >&2
    exit 1
  fi
  actual="$(sha256sum "$file" | awk 'NR==1 { print $1 }')"
  if [ "$actual" != "$expected" ]; then
    echo "checksum mismatch for $name" >&2
    echo "expected $expected" >&2
    echo "actual   $actual" >&2
    exit 1
  fi
}

version_text() {
  binpath="$1"
  tool="$2"
  case "$tool" in
    gitleaks) "$binpath" version 2>&1 || true ;;
    trivy) "$binpath" --version 2>&1 || true ;;
    syft) "$binpath" version 2>&1 || true ;;
    *)
      echo "unknown tool $tool" >&2
      exit 1
      ;;
  esac
}

version_ok() {
  binpath="$1"
  tool="$2"
  expected="$3"
  text="$(version_text "$binpath" "$tool")"
  case "$tool" in
    gitleaks)
      actual="$(printf '%s\n' "$text" | head -n 1 | tr -d '[:space:]')"
      [ "$actual" = "$expected" ]
      ;;
    trivy)
      printf '%s\n' "$text" | head -n 1 | grep -q "^Version: ${expected}$"
      ;;
    syft)
      printf '%s\n' "$text" | grep -E -q "^Version:[[:space:]]+${expected}$"
      ;;
    *)
      return 1
      ;;
  esac
}

require_preinstalled_or_absent() {
  tool="$1"
  expected="$2"
  if ! command -v "$tool" >/dev/null 2>&1; then
    return 1
  fi
  existing="$(command -v "$tool")"
  if version_ok "$existing" "$tool" "$expected"; then
    echo "using preinstalled $tool $expected at $existing"
    return 0
  fi
  echo "preinstalled $tool at $existing does not match required version $expected" >&2
  exit 1
}

install_archive() {
  tool="$1"
  url="$2"
  archive_name="$3"
  binary="$4"
  expected_version="$5"
  expected_sum="$(checksum_for "$archive_name")"
  tmp="$(mktemp -d)"
  archive="$tmp/$archive_name"
  if ! curl -fsSL --retry 3 --retry-delay 2 --output "$archive" "$url"; then
    echo "failed to download $archive_name" >&2
    rm -rf "$tmp"
    exit 1
  fi
  verify_sha256 "$archive" "$expected_sum" "$archive_name"
  tar -xz -C "$tmp" -f "$archive"
  if [ ! -f "$tmp/$binary" ] || [ ! -s "$tmp/$binary" ]; then
    echo "archive $archive_name is missing $binary" >&2
    rm -rf "$tmp"
    exit 1
  fi
  mkdir -p "$dest"
  install -m 0755 "$tmp/$binary" "$dest/$binary"
  rm -rf "$tmp"
  if ! version_ok "$dest/$binary" "$tool" "$expected_version"; then
    echo "installed $tool failed the version check for $expected_version" >&2
    rm -f "$dest/$binary"
    exit 1
  fi
}

if [ "$want" = "--verify-archive" ]; then
  archive_name="${2:?archive name}"
  archive_file="${3:?archive path}"
  verify_sha256 "$archive_file" "$(checksum_for "$archive_name")" "$archive_name"
  echo "verified $archive_name"
  exit 0
fi

need() {
  [ "$want" = "all" ] || [ "$want" = "$1" ]
}

if need gitleaks; then
  if ! require_preinstalled_or_absent gitleaks "$GITLEAKS_VERSION"; then
    gitleaks_name="gitleaks_${GITLEAKS_VERSION}_${os_name}_${arch_name}.tar.gz"
    install_archive gitleaks \
      "${SUPPLY_CHAIN_URL_GITLEAKS:-https://github.com/gitleaks/gitleaks/releases/download/v${GITLEAKS_VERSION}/${gitleaks_name}}" \
      "$gitleaks_name" \
      gitleaks \
      "$GITLEAKS_VERSION"
  fi
fi

if need trivy; then
  if ! require_preinstalled_or_absent trivy "$TRIVY_VERSION"; then
    trivy_name="trivy_${TRIVY_VERSION}_${trivy_arch}.tar.gz"
    install_archive trivy \
      "${SUPPLY_CHAIN_URL_TRIVY:-https://github.com/aquasecurity/trivy/releases/download/v${TRIVY_VERSION}/${trivy_name}}" \
      "$trivy_name" \
      trivy \
      "$TRIVY_VERSION"
  fi
fi

if need syft; then
  if ! require_preinstalled_or_absent syft "$SYFT_VERSION"; then
    syft_name="syft_${SYFT_VERSION}_${os_name}_${syft_arch}.tar.gz"
    install_archive syft \
      "${SUPPLY_CHAIN_URL_SYFT:-https://github.com/anchore/syft/releases/download/v${SYFT_VERSION}/${syft_name}}" \
      "$syft_name" \
      syft \
      "$SYFT_VERSION"
  fi
fi
