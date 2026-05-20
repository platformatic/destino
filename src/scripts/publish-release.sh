#!/bin/bash
# SPDX-License-Identifier: MIT

set -euo pipefail

version="${1:?version is required}"
prerelease="${2:-false}"
artifacts_path="${3:-artifacts}"

version="${version#v}"
tag="v$version"
flags=()

if [[ "$prerelease" == "true" ]]; then
  flags+=(--prerelease)
fi

if [[ ! -d "$artifacts_path" ]]; then
  echo "Artifacts directory not found: $artifacts_path"
  exit 1
fi

shopt -s nullglob
artifact_directories=("$artifacts_path"/*)

if [[ ${#artifact_directories[@]} -eq 0 ]]; then
  echo "No artifacts found in: $artifacts_path"
  exit 1
fi

release_assets_dir="tmp/release-assets"
rm -rf "$release_assets_dir"
mkdir -p "$release_assets_dir"

for artifact_directory in "${artifact_directories[@]}"; do
  if [[ ! -d "$artifact_directory" ]]; then
    continue
  fi

  asset_name="$(basename "$artifact_directory").zip"

  if [[ -f "$artifact_directory/destino" ]]; then
    chmod a+x "$artifact_directory/destino"
  fi

  (
    cd "$artifact_directory"
    zip -q -r "../../$release_assets_dir/$asset_name" .
  )
done

release_assets=("$release_assets_dir"/*)

if [[ ${#release_assets[@]} -eq 0 ]]; then
  echo "No release assets created from: $artifacts_path"
  exit 1
fi

if gh release view "$tag" >/dev/null 2>&1; then
  gh release upload "$tag" "${release_assets[@]}" --clobber
else
  gh release create "$tag" "${release_assets[@]}" --title "$tag" "${flags[@]}"
fi
