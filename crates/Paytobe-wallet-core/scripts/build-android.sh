#!/usr/bin/env bash
# Cross-compiles the wallet-core to Android .so's (all ABIs) into the app's
# jniLibs, and builds the host library for JVM unit tests.
#
# Requires: rustup Android targets, cargo-ndk, and an installed NDK
# (ANDROID_NDK_HOME, or auto-picked from ~/Library/Android/sdk/ndk).
set -euo pipefail

CRATE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$CRATE_DIR"
APP="$CRATE_DIR/../../apps/android/app"

if [ -z "${ANDROID_NDK_HOME:-}" ]; then
  NDK_DIR="$HOME/Library/Android/sdk/ndk"
  export ANDROID_NDK_HOME="$NDK_DIR/$(ls "$NDK_DIR" | sort -V | tail -1)"
fi
echo "Using NDK: $ANDROID_NDK_HOME"

echo "==> host C ABI library (for JVM unit tests)"
"$CRATE_DIR/scripts/build-android-host.sh" >/dev/null

echo "==> device .so (arm64-v8a, armeabi-v7a, x86_64, x86)"
cargo ndk -t arm64-v8a -t armeabi-v7a -t x86_64 -t x86 \
  -o "$APP/src/main/jniLibs" build --release

echo "==> done; jniLibs:"
find "$APP/src/main/jniLibs" -name "*.so"
