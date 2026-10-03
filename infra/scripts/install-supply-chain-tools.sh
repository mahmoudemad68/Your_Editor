#!/bin/sh
# Install pinned supply-chain scanners into a directory on PATH.
# Usage: install-supply-chain-tools.sh [gitleaks|trivy|syft|all]
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

install_archive() {
  url="$1"
  binary="$2"
  tmp="$(mktemp -d)"
  curl -fsSL "$url" | tar -xz -C "$tmp"
  install -m 0755 "$tmp/$binary" "$dest/$binary"
  rm -rf "$tmp"
}

need() {
  [ "$want" = "all" ] || [ "$want" = "$1" ]
}

if need gitleaks && ! command -v gitleaks >/dev/null 2>&1; then
  install_archive \
    "https://github.com/gitleaks/gitleaks/releases/download/v${GITLEAKS_VERSION}/gitleaks_${GITLEAKS_VERSION}_${os_name}_${arch_name}.tar.gz" \
    gitleaks
fi

if need trivy && ! command -v trivy >/dev/null 2>&1; then
  install_archive \
    "https://github.com/aquasecurity/trivy/releases/download/v${TRIVY_VERSION}/trivy_${TRIVY_VERSION}_${trivy_arch}.tar.gz" \
    trivy
fi

if need syft && ! command -v syft >/dev/null 2>&1; then
  install_archive \
    "https://github.com/anchore/syft/releases/download/v${SYFT_VERSION}/syft_${SYFT_VERSION}_${os_name}_${syft_arch}.tar.gz" \
    syft
fi
