#!/bin/sh
# Fail unless libcrypto3 and libssl3 are installed at or above the minimum
# Alpine revision. `apk version -t` is Alpine's own comparison. The package
# index is authenticated by apk signatures; this script does not pin one
# exact revision, so a newer rebuild still installs.
set -eu

min="${1:?minimum OpenSSL revision, for example 3.3.7-r2}"
db="${OPENSSL_INSTALLED_DB:-/lib/apk/db/installed}"

if [ ! -f "$db" ]; then
  echo "missing Alpine installed database: $db" >&2
  exit 1
fi

package_version() {
  pkg="$1"
  awk -v pkg="$pkg" '
    $0 == "P:" pkg { found = 1; next }
    found && $0 ~ /^V:/ { sub(/^V:/, ""); print; exit }
    found && $0 ~ /^P:/ { exit }
  ' "$db"
}

for pkg in libcrypto3 libssl3; do
  ver="$(package_version "$pkg")"
  if [ -z "$ver" ]; then
    echo "missing package: $pkg" >&2
    exit 1
  fi
  cmp="$(apk version -t "$ver" "$min")"
  case "$cmp" in
    "=" | ">")
      echo "$pkg $ver (>= $min)"
      ;;
    *)
      echo "$pkg $ver is older than required $min" >&2
      exit 1
      ;;
  esac
done
