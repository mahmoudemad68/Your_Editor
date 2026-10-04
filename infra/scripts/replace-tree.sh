#!/bin/sh
# Replace a destination directory with the contents of a source directory.
# Copying the source directory itself would nest source/source on the next deploy.
set -eu

src=${1:?source directory}
dest=${2:?destination directory}

rm -rf "$dest"
mkdir -p "$dest"
tar -C "$src" -cf - . | tar -C "$dest" -xf -
