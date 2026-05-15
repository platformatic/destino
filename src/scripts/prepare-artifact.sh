#!/bin/bash

set -euo pipefail

platform="${1:?platform is required}"
arch="${2:?arch is required}"
extension=""

if [[ "$platform" == "windows" ]]; then
  extension=".exe"
fi

source="dist/destino$extension"
artifact_dir="tmp/artifact-$platform-$arch"
target="$artifact_dir/destino$extension"

if [[ ! -f "$source" ]]; then
  echo "Artifact source not found: $source"
  exit 1
fi

rm -rf "$artifact_dir"
mkdir -p "$artifact_dir"
cp "$source" "$target"

chmod a+x "$target"
