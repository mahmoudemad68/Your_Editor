#!/bin/sh
# Reject OIDC and LDAP configuration before the MinIO server starts.
# This does not remove CVE-2026-33322 or CVE-2026-33419 from the binary.
# A host administrator who replaces this entrypoint is outside this check.
set -eu

fail() {
  echo "Refusing to start. This open-source MinIO build has no fix for CVE-2026-33322 or CVE-2026-33419." >&2
  echo "$1" >&2
  echo "The server binary still contains those vulnerabilities." >&2
  exit 1
}

value_of() {
  value=${1#*=}
  value=${value#"${value%%[![:space:]]*}"}
  value=${value%"${value##*[![:space:]]}"}
  case "$value" in
    \"*\") value=${value#\"}; value=${value%\"} ;;
    \'*\') value=${value#\'}; value=${value%\'} ;;
  esac
  printf '%s' "$value"
}

reject_assignment() {
  line=$1
  case "$line" in
    ''|\#*) return 0 ;;
  esac
  case "$line" in
    export\ *) line=${line#export } ;;
  esac
  name=${line%%=*}
  case "$name" in
    MINIO_IDENTITY_OPENID_*|MINIO_IDENTITY_LDAP_*) ;;
    *) return 0 ;;
  esac
  if [ -n "$(value_of "$line")" ]; then
    fail "identity setting $name"
  fi
}

environment=$(mktemp)
trap 'rm -f "$environment"' EXIT
env >"$environment"
while IFS= read -r line; do
  reject_assignment "$line"
done <"$environment"

if [ -n "${MINIO_CONFIG_ENV_FILE:-}" ]; then
  if [ ! -f "$MINIO_CONFIG_ENV_FILE" ] || [ ! -r "$MINIO_CONFIG_ENV_FILE" ]; then
    fail "MINIO_CONFIG_ENV_FILE cannot be read"
  fi
  while IFS= read -r line || [ -n "$line" ]; do
    reject_assignment "$line"
  done <"$MINIO_CONFIG_ENV_FILE"
fi

data_root=${MINIO_DATA_DIR:-/data}
if [ -d "$data_root" ]; then
  if ! find "$data_root" -type f -exec awk '
    {
      buffer = buffer $0
    }
    END {
      count = split(buffer, parts, "\"identity_")
      for (item = 2; item <= count; item++) {
        section = parts[item]
        kind = substr(section, 1, 6)
        if (kind != "openid" && substr(section, 1, 4) != "ldap") {
          continue
        }
        if (section ~ /"key":"enable","value":"on"/) exit 2
        if (section ~ /"key":"config_url","value":"[^"]/) exit 2
        if (section ~ /"key":"client_id","value":"[^"]/) exit 2
        if (section ~ /"key":"client_secret","value":"[^"]/) exit 2
        if (section ~ /"key":"display_name","value":"[^"]/) exit 2
        if (section ~ /"key":"server_addr","value":"[^"]/) exit 2
        if (section ~ /"key":"lookup_bind_dn","value":"[^"]/) exit 2
        if (section ~ /"key":"lookup_bind_password","value":"[^"]/) exit 2
        if (section ~ /"key":"user_dn_search_base_dn","value":"[^"]/) exit 2
      }
    }
  ' {} +; then
    fail "persisted OIDC or LDAP configuration under $data_root"
  fi
fi
