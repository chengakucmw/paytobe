#!/usr/bin/env bash
# One command to run every release safety gate locally on a Mac.
# Rust tests run first; the unified release gate then owns licensing, Node,
# Android, iOS, cache isolation, timeouts, and artifact evidence.
#
# Requires (same as CI): rustup, Node, JDK 17 + Android SDK/NDK + cargo-ndk, Xcode.
# Run from anywhere: scripts/test-all.sh   (or: npm run test:all)
#
# Each section stops the whole run on first failure. Release runs do not accept
# mobile skips; use `npm run release:gate -- --node-only` only for non-release
# local development checks.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"
CORE="$ROOT/crates/velarum-wallet-core"

step() { printf '\n\033[1;36m==> %s\033[0m\n' "$1"; }

step "1/2  Rust wallet-core: derivation + signing + shared golden vectors"
( cd "$CORE" && cargo test )

step "2/2  Unified release gate: licensing, Node, Android, iOS, SBOM, and evidence"
npm run release:gate

printf '\n\033[1;32mAll gates passed.\033[0m\n'
