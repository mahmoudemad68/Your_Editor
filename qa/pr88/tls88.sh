#!/usr/bin/env bash
# Ephemeral QA TLS fixtures for the offline provider battery (generated per run, never committed).
set -euo pipefail
d="$1"; mkdir -p "$d"; cd "$d"
openssl req -x509 -newkey rsa:2048 -nodes -keyout ca.key -out ca.crt -days 2 -subj "/CN=QA88 ephemeral test CA" 2>/dev/null
leaf() {
  openssl req -newkey rsa:2048 -nodes -keyout "$1.key" -out "$1.csr" -subj "/CN=$1" 2>/dev/null
  printf 'subjectAltName=%s\nbasicConstraints=CA:FALSE\nkeyUsage=digitalSignature,keyEncipherment\nextendedKeyUsage=serverAuth\n' "$2" > "$1.ext"
  openssl x509 -req -in "$1.csr" -CA ca.crt -CAkey ca.key -CAcreateserial -out "$1.crt" -days 2 -extfile "$1.ext" 2>/dev/null
}
leaf good "IP:127.0.0.1"
leaf host "DNS:localhost"
leaf wrong "DNS:wrong.qa88.invalid"
openssl req -x509 -newkey rsa:2048 -nodes -keyout self.key -out self.crt -days 2 -subj "/CN=127.0.0.1" -addext "subjectAltName=IP:127.0.0.1" 2>/dev/null
rm -f ca.key ./*.csr ./*.ext ca.srl
chmod 0644 ./*
ls
