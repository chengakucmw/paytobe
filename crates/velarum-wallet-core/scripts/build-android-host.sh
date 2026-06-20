#!/usr/bin/env bash
# Generates the Kotlin (UniFFI) bindings for the VelarumPay wallet-core and
# builds the HOST shared library that the Android JVM unit tests load via JNA.
#
# Output (git-ignored): apps/android/app/uniffi-generated/uniffi/velarum_wallet_core/velarum_wallet_core.kt
# The host library used at test time is crates/.../target/release/libvelarum_wallet_core.dylib
# (a .dylib on macOS / .so on Linux), located via -Djna.library.path in build.gradle.
#
# NOTE: this covers the JVM UNIT TEST path only. Building the Android device
# .so (arm64-v8a, etc.) needs the Android NDK + cargo-ndk and is a later step.
set -euo pipefail

CRATE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$CRATE_DIR"
LIB=velarum_wallet_core
OUT="$CRATE_DIR/../../apps/android/app/uniffi-generated"

echo "==> build host shared library"
cargo build --release

# Host library extension differs by OS (.dylib on macOS, .so on Linux/CI).
LIBFILE=""
for ext in dylib so; do
  if [ -f "target/release/lib${LIB}.${ext}" ]; then LIBFILE="target/release/lib${LIB}.${ext}"; break; fi
done
if [ -z "$LIBFILE" ]; then echo "host library not found in target/release" >&2; exit 1; fi

echo "==> generate Kotlin bindings (from $LIBFILE)"
rm -rf "$OUT"; mkdir -p "$OUT"
cargo run --quiet --features cli --bin uniffi-bindgen -- \
  generate --library "$LIBFILE" --language kotlin --out-dir "$OUT"

echo "==> done"
find "$OUT" -name "*.kt"
