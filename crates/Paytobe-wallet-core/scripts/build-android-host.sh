#!/usr/bin/env bash
# Builds the host shared library that Android JVM unit tests load via JNA.
#
# The host library used at test time is crates/.../target/release/libPaytobe_wallet_core.dylib
# (a .dylib on macOS / .so on Linux), located via -Djna.library.path in build.gradle.
#
# NOTE: this covers the JVM UNIT TEST path only. Building the Android device
# .so (arm64-v8a, etc.) needs the Android NDK + cargo-ndk and is a later step.
set -euo pipefail

CRATE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$CRATE_DIR"
LIB=Paytobe_wallet_core

echo "==> build host shared library"
cargo build --release

# Host library extension differs by OS (.dylib on macOS, .so on Linux/CI).
LIBFILE=""
for ext in dylib so; do
  if [ -f "target/release/lib${LIB}.${ext}" ]; then LIBFILE="target/release/lib${LIB}.${ext}"; break; fi
done
if [ -z "$LIBFILE" ]; then echo "host library not found in target/release" >&2; exit 1; fi

echo "==> done: $LIBFILE"
