#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
PROJECT="$ROOT/apps/ios/Paytobe.xcodeproj"
SCHEME="Paytobe"
SIMULATOR_NAME="${SIMULATOR_NAME:-iPhone 17}"
DEVICE_DESTINATION="${DEVICE_DESTINATION:-}"
PREFLIGHT_ONLY=0

if [[ "${1:-}" == "--preflight" ]]; then
  PREFLIGHT_ONLY=1
fi

echo "== Paytobe iOS QA =="
echo "Project: $PROJECT"
echo "Scheme: $SCHEME"
echo "Simulator: $SIMULATOR_NAME"
echo

echo "== Simulator XCTest preflight =="
xcodebuild \
  -project "$PROJECT" \
  -scheme "$SCHEME" \
  -configuration Debug \
  -sdk iphonesimulator \
  -destination "platform=iOS Simulator,name=$SIMULATOR_NAME" \
  test

echo
echo "== Available devices =="
xcrun xctrace list devices || true

cat <<'CHECKLIST'

== Manual physical-device acceptance checklist ==

[ ] Connect an unlocked, trusted iPhone and rerun without --preflight.
[ ] Register or configure the relay URL on the device.
[ ] Scan a Paytobe://pair QR code and confirm agent identity/scopes.
[ ] Reject a pairing session and confirm it cannot create requests.
[ ] Approve only non-signing scopes; confirm wallet.sign/seed/private scopes are absent.
[ ] Sync inbox after creating Stellar XLM and Base USDC quickstart requests.
[ ] Confirm safe Stellar XLM request shows the Pay action.
[ ] Confirm missing-context request shows Request context / Reject request, not Pay.
[ ] Confirm risk-blocked mismatch request shows Reject request, not Pay.
[ ] Start Stellar XLM local signing with a funded testnet account only.
[ ] Confirm Base USDC remains review-only on iOS v1 and does not sign.
[ ] Record screenshots/logs without private keys, seed phrases, or real payment secrets.

CHECKLIST

if [[ "$PREFLIGHT_ONLY" == "1" ]]; then
  echo "Preflight complete. Physical-device build was intentionally skipped."
  exit 0
fi

if [[ -z "$DEVICE_DESTINATION" ]]; then
  echo "DEVICE_DESTINATION is required for physical-device QA." >&2
  echo "Example: DEVICE_DESTINATION='platform=iOS,name=Alice iPhone' $0" >&2
  exit 2
fi

echo "== Physical-device build =="
BUILD_ARGS=(
  -project "$PROJECT"
  -scheme "$SCHEME"
  -configuration Debug
  -destination "$DEVICE_DESTINATION"
)

if [[ -n "${DEVELOPMENT_TEAM:-}" ]]; then
  BUILD_ARGS+=(DEVELOPMENT_TEAM="$DEVELOPMENT_TEAM")
fi

xcodebuild "${BUILD_ARGS[@]}" build

echo
echo "Physical-device build complete. Finish the manual checklist above and attach screenshots/log notes to QA evidence."
