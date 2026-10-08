#!/bin/sh
# Use the signed Ubuntu archive over HTTPS instead of the runner's HTTP Azure
# mirror, whose connection retries can consume the entire test-job deadline.
set -eu
sudo python3 - <<'PY'
from pathlib import Path

sources = [Path('/etc/apt/sources.list')]
sources += list(Path('/etc/apt/sources.list.d').glob('*.sources'))
sources += list(Path('/etc/apt/sources.list.d').glob('*.list'))
for source in sources:
    if source.is_file():
        original = source.read_text()
        updated = original.replace(
            'http://azure.archive.ubuntu.com/ubuntu',
            'https://archive.ubuntu.com/ubuntu',
        )
        if updated != original:
            source.write_text(updated)
PY
sudo apt-get -o Acquire::http::Timeout=30 -o Acquire::https::Timeout=30 -o Acquire::Retries=2 update
sudo apt-get -o Acquire::http::Timeout=30 -o Acquire::https::Timeout=30 -o Acquire::Retries=2 install -y ffmpeg
ffmpeg -version
ffprobe -version
