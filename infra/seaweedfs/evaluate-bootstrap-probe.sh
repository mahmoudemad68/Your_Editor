#!/bin/sh
# Decide whether the host bootstrap probe proved firewall isolation.
# A curl failure by itself is not success. Success is only curl exit 28
# (timeout, no HTTP response) together with an increase in the internal
# subnet OUTPUT DROP counter. Every other exit code fails closed.
# Usage: evaluate-bootstrap-probe.sh <curl-exit> <drops-before> <drops-after>
set -eu

curl_exit=${1:?curl exit}
before=${2:?drops before}
after=${3:?drops after}

case "$curl_exit" in
  '' | *[!0-9]*)
    echo "fail-closed: host probe curl exit is not a number" >&2
    exit 1
    ;;
esac
case "$before" in
  '' | *[!0-9]*)
    echo "fail-closed: DROP counter before the probe is not a number" >&2
    exit 1
    ;;
esac
case "$after" in
  '' | *[!0-9]*)
    echo "fail-closed: DROP counter after the probe is not a number" >&2
    exit 1
    ;;
esac

if [ "$curl_exit" -ne 28 ]; then
  echo "fail-closed: host probe returned curl exit ${curl_exit}, expected timeout 28" >&2
  exit 1
fi
if [ "$after" -le "$before" ]; then
  echo "fail-closed: host probe did not increase the internal subnet DROP counter" >&2
  exit 1
fi
