#!/usr/bin/env bash
# Builds the VelarumPay wallet-core for Apple platforms and assembles an
# XCFramework + the Swift bindings the iOS app consumes.
#
# Output (git-ignored build artifacts) goes to apps/ios/Generated/:
#   - VelarumWalletCore.xcframework   (device + simulator static libs)
#   - velarum_wallet_core.swift       (UniFFI-generated Swift API)
#
# Re-run after changing the Rust core. Requires: rustup, Xcode.
set -euo pipefail

CRATE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$CRATE_DIR"
LIB=velarum_wallet_core
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

echo "==> generate Swift bindings"
cargo build --release
cargo run --quiet --features cli --bin uniffi-bindgen -- \
  generate --library "target/release/lib${LIB}.dylib" --language swift \
  --out-dir target/bindings/swift

echo "==> assemble headers (module.modulemap is what Xcode auto-discovers)"
HDR="$CRATE_DIR/target/apple-headers"
rm -rf "$HDR"; mkdir -p "$HDR"
cp "target/bindings/swift/${LIB}FFI.h" "$HDR/"
cp "target/bindings/swift/${LIB}FFI.modulemap" "$HDR/module.modulemap"

echo "==> create XCFramework"
mkdir -p "$OUT"
rm -rf "$OUT/VelarumWalletCore.xcframework"
xcodebuild -create-xcframework \
  -library "target/aarch64-apple-ios/release/lib${LIB}.a" -headers "$HDR" \
  -library "$SIMLIB" -headers "$HDR" \
  -output "$OUT/VelarumWalletCore.xcframework" >/dev/null

cp "target/bindings/swift/${LIB}.swift" "$OUT/velarum_wallet_core.swift"
echo "==> done: $OUT"
ls -la "$OUT"
