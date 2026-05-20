#!/bin/bash
# SPDX-License-Identifier: MIT

set -euo pipefail

if [[ "$(uname -s)" != "Darwin" ]]; then
  echo "macOS notarization can only run on macOS."
  exit 1
fi

EXECUTABLE_PATH="${1:-dist/destino}"
ARCHIVE_PATH="${2:-dist/destino-notarization.zip}"
TEMP_DIR="${RUNNER_TEMP:-${TMPDIR:-/tmp}}"
ENTITLEMENTS_PATH="${ENTITLEMENTS_PATH:-src/sea/entitlements.plist}"
KEYCHAIN_PASSWORD="${APPLE_KEYCHAIN_PASSWORD:-$(uuidgen)}"
KEYCHAIN_PATH="$TEMP_DIR/destino-signing.keychain-db"
CERTIFICATE_PATH="$TEMP_DIR/destino-certificate.p12"

if [[ ! -f "$EXECUTABLE_PATH" ]]; then
  echo "Executable not found: $EXECUTABLE_PATH"
  exit 1
fi

if [[ ! -f "$ENTITLEMENTS_PATH" ]]; then
  echo "Entitlements file not found: $ENTITLEMENTS_PATH"
  exit 1
fi

: "${CSC_LINK:?CSC_LINK is required}"
: "${CSC_KEY_PASSWORD:?CSC_KEY_PASSWORD is required}"
: "${APPLE_ID:?APPLE_ID is required}"
: "${APPLE_APP_SPECIFIC_PASSWORD:?APPLE_APP_SPECIFIC_PASSWORD is required}"
: "${APPLE_TEAM_ID:?APPLE_TEAM_ID is required}"

cleanup () {
  security delete-keychain "$KEYCHAIN_PATH" >/dev/null 2>&1 || true
  rm -f "$CERTIFICATE_PATH" "$ARCHIVE_PATH"
}

trap cleanup EXIT

if [[ -f "$CSC_LINK" ]]; then
  cp "$CSC_LINK" "$CERTIFICATE_PATH"
else
  printf '%s' "$CSC_LINK" | base64 --decode > "$CERTIFICATE_PATH"
fi

security create-keychain -p "$KEYCHAIN_PASSWORD" "$KEYCHAIN_PATH"
security set-keychain-settings -lut 21600 "$KEYCHAIN_PATH"
security unlock-keychain -p "$KEYCHAIN_PASSWORD" "$KEYCHAIN_PATH"
security import "$CERTIFICATE_PATH" -P "$CSC_KEY_PASSWORD" -A -t cert -f pkcs12 -k "$KEYCHAIN_PATH"
security list-keychains -d user -s "$KEYCHAIN_PATH"
security set-key-partition-list -S apple-tool:,apple:,codesign: -s -k "$KEYCHAIN_PASSWORD" "$KEYCHAIN_PATH"

SIGNING_IDENTITY="${APPLE_SIGNING_IDENTITY:-}"

if [[ -z "$SIGNING_IDENTITY" ]]; then
  SIGNING_IDENTITY=$(security find-identity -v -p codesigning "$KEYCHAIN_PATH" | sed -n 's/.*"\(Developer ID Application:.*\)"/\1/p' | head -n 1)
fi

if [[ -z "$SIGNING_IDENTITY" ]]; then
  echo "Unable to find a Developer ID Application signing identity."
  exit 1
fi

codesign --force --timestamp --options runtime --entitlements "$ENTITLEMENTS_PATH" --sign "$SIGNING_IDENTITY" "$EXECUTABLE_PATH"
codesign --verify --strict --verbose=2 "$EXECUTABLE_PATH"

ditto -c -k --keepParent "$EXECUTABLE_PATH" "$ARCHIVE_PATH"

xcrun notarytool submit "$ARCHIVE_PATH" \
  --apple-id "$APPLE_ID" \
  --password "$APPLE_APP_SPECIFIC_PASSWORD" \
  --team-id "$APPLE_TEAM_ID" \
  --wait
