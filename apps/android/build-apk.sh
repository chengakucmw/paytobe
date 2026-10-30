#!/usr/bin/env bash
# Build the Paytobe Android debug APK locally.
# Requirements: JDK 17 and the Android SDK (both installed by Android Studio).
set -euo pipefail
cd "$(dirname "$0")"

# Use the default macOS Android SDK location if none is configured.
if [ -z "${ANDROID_HOME:-}" ] && [ -z "${ANDROID_SDK_ROOT:-}" ] && [ -d "$HOME/Library/Android/sdk" ]; then
  export ANDROID_HOME="$HOME/Library/Android/sdk"
fi

echo "JDK:            $(java -version 2>&1 | head -1)"
echo "ANDROID_HOME:   ${ANDROID_HOME:-${ANDROID_SDK_ROOT:-<not set>}}"
echo "Building debug APK (./gradlew assembleDebug) ..."
echo

./gradlew assembleDebug

echo
echo "Done. APK(s):"
ls -1 app/build/outputs/apk/debug/*.apk
