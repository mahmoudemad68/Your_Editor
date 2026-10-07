#!/bin/sh
# GitHub-hosted runners already provide Chrome. Reuse that validated runner
# toolchain instead of repeatedly downloading its replacement on every PR.
set -eu
if ! command -v google-chrome >/dev/null 2>&1 || [ ! -x /opt/google/chrome/chrome ]; then
  wget --timeout=30 --tries=3 -q -O /tmp/chrome.deb https://dl.google.com/linux/direct/google-chrome-stable_current_amd64.deb
  sudo apt-get install -y /tmp/chrome.deb
fi
test -x /opt/google/chrome/chrome
google-chrome --version
