#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/.."

echo "Building the independently installable Paytobe testnet APK..."
./gradlew :app:assembleStellarTestnetRelease

APK="$(pwd)/app/build/outputs/apk/stellarTestnet/release/Paytobe-stellarTestnetRelease.apk"
if [ ! -f "$APK" ]; then
  echo "Testnet APK was not produced at the expected path: $APK" >&2
  exit 1
fi

echo "$APK"
