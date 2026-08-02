#!/usr/bin/env bash
# One command to run EVERY safety gate locally on a Mac, in the same order CI does.
# This is the "run it all before release" script: Rust core, Node cross-platform
# contract + backend, Android unit tests, and iOS unit tests.
#
# Requires (same as CI): rustup, Node, JDK 17 + Android SDK/NDK + cargo-ndk, Xcode.
# Run from anywhere: scripts/test-all.sh   (or: npm run test:all)
#
# Each section stops the whole run on first failure (set -e), so a red gate is
# never hidden. Skip a section with, e.g., SKIP_IOS=1 scripts/test-all.sh.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"
CORE="$ROOT/crates/velarum-wallet-core"

step() { printf '\n\033[1;36m==> %s\033[0m\n' "$1"; }

step "1/5  Rust wallet-core: derivation + signing + shared golden vectors"
( cd "$CORE" && cargo test )

step "2/5  Node: cross-platform HD-derivation contract"
node --test tests/protocol/hd-derivation-contract.test.mjs

step "3/5  Node: backend + SDK + connector unit tests and smokes"
npm run test
npm run smoke:quickstart
npm run smoke:cross-component

if [ "${SKIP_ANDROID:-0}" = "1" ]; then
  step "4/5  Android: SKIPPED (SKIP_ANDROID=1)"
else
  step "4/5  Android: build wallet-core (host + device libs) then JVM unit tests"
  "$CORE/scripts/build-android.sh"
  ( cd "$ROOT/apps/android" && ./gradlew testDebugUnitTest )
fi

if [ "${SKIP_IOS:-0}" = "1" ]; then
  step "5/5  iOS: SKIPPED (SKIP_IOS=1)"
else
  step "5/5  iOS: build wallet-core (XCFramework) then simulator unit tests"
  "$CORE/scripts/build-apple.sh"
  UDID="$(xcrun simctl list devices available -j \
    | python3 -c "import json,sys; d=json.load(sys.stdin)['devices']; print(next(x['udid'] for rt in d for x in d[rt] if x.get('isAvailable') and 'iPhone' in x['name']))")"
  echo "Using iOS simulator $UDID"
  xcodebuild test \
    -project apps/ios/VelarumPay.xcodeproj \
    -scheme VelarumPay \
    -sdk iphonesimulator \
    -destination "id=$UDID" \
    CODE_SIGNING_ALLOWED=NO
fi

printf '\n\033[1;32mAll gates passed.\033[0m\n'
