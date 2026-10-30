#!/usr/bin/env bash
# Builds the Paytobe wallet-core for Apple platforms and assembles the
# stable C ABI XCFramework consumed by the checked-in Swift adapter.
#
# Output (git-ignored build artifacts) goes to apps/ios/Generated/:
#   - PaytobeWalletCore.xcframework   (device + simulator static libs)
#   - Paytobe_wallet_core.swift       (checked-in compatibility adapter)
#
# Re-run after changing the Rust core. Requires: rustup, Xcode.
set -euo pipefail

CRATE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$CRATE_DIR"
LIB=Paytobe_wallet_core
OUT="$CRATE_DIR/../../apps/ios/Generated"

echo "==> rust targets"
rustup target add aarch64-apple-ios aarch64-apple-ios-sim x86_64-apple-ios >/dev/null 2>&1 || true

echo "==> cross-compile static libs (device + arm64 sim + x86_64 sim)"
cargo build --release --target aarch64-apple-ios
cargo build --release --target aarch64-apple-ios-sim
cargo build --release --target x86_64-apple-ios

echo "==> lipo a universal (arm64 + x86_64) simulator library"
SIMLIB="$CRATE_DIR/target/apple-sim-universal/lib${LIB}.a"
mkdir -p "$(dirname "$SIMLIB")"
lipo -create \
  "target/aarch64-apple-ios-sim/release/lib${LIB}.a" \
  "target/x86_64-apple-ios/release/lib${LIB}.a" \
  -output "$SIMLIB"

echo "==> assemble stable C ABI headers"
HDR="$CRATE_DIR/target/apple-headers"
rm -rf "$HDR"; mkdir -p "$HDR"
cp "include/${LIB}FFI.h" "$HDR/"
cp "include/module.modulemap" "$HDR/module.modulemap"

echo "==> create XCFramework"
mkdir -p "$OUT"
rm -rf "$OUT/PaytobeWalletCore.xcframework"
xcodebuild -create-xcframework \
  -library "target/aarch64-apple-ios/release/lib${LIB}.a" -headers "$HDR" \
  -library "$SIMLIB" -headers "$HDR" \
  -output "$OUT/PaytobeWalletCore.xcframework" >/dev/null

echo "==> done: $OUT"
ls -la "$OUT"
