#!/usr/bin/env bash
set -euo pipefail

MODE="${1:-run}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ANDROID_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
PACKAGE="${ANDROID_APP_ID:-ai.agentwallet.hd}"
JAVA_HOME="${JAVA_HOME:-/opt/homebrew/opt/openjdk@17/libexec/openjdk.jdk/Contents/Home}"
ANDROID_HOME="${ANDROID_HOME:-$HOME/Library/Android/sdk}"
ADB="${ADB:-$ANDROID_HOME/platform-tools/adb}"
APK="$ANDROID_DIR/app/build/outputs/apk/debug/app-debug.apk"
REPORT_DIR="$ANDROID_DIR/build/reports/device-payment-loop-qa/$(date +%Y%m%d-%H%M%S)"

if [[ ! -x "$ADB" ]]; then
  echo "adb not found at $ADB" >&2
  echo "Set ANDROID_HOME or ADB before running this script." >&2
  exit 2
fi

cd "$ANDROID_DIR"
echo "Running Android unit tests and debug build..."
JAVA_HOME="$JAVA_HOME" ./gradlew testDebugUnitTest assembleDebug

DEVICES=()
while IFS= read -r DEVICE_SERIAL; do
  [[ -n "$DEVICE_SERIAL" ]] && DEVICES+=("$DEVICE_SERIAL")
done < <("$ADB" devices | awk 'NR > 1 && $2 == "device" { print $1 }')

if [[ "$MODE" == "--preflight" ]]; then
  echo "Preflight complete. Connected physical devices: ${#DEVICES[@]}"
  if [[ "${#DEVICES[@]}" -gt 0 ]]; then
    printf ' - %s\n' "${DEVICES[@]}"
  fi
  exit 0
fi

if [[ "${#DEVICES[@]}" -eq 0 ]]; then
  echo "No adb device is connected. Attach an unlocked Android phone with USB debugging enabled." >&2
  echo "Build/test passed, but true device QA was not executed." >&2
  exit 2
fi

SERIAL="${ANDROID_SERIAL:-${DEVICES[0]}}"
IS_EMULATOR="$("$ADB" -s "$SERIAL" shell getprop ro.kernel.qemu 2>/dev/null | tr -d '\r' || true)"
if [[ "$IS_EMULATOR" == "1" && "${ALLOW_EMULATOR_QA:-}" != "1" ]]; then
  echo "Connected adb target $SERIAL is an emulator. GAP-P0-02 requires a physical Android device." >&2
  echo "Set ALLOW_EMULATOR_QA=1 only for emulator smoke runs that should not close true device QA." >&2
  exit 2
fi
mkdir -p "$REPORT_DIR"

echo "Using device: $SERIAL"
"$ADB" -s "$SERIAL" install -r "$APK"
"$ADB" -s "$SERIAL" logcat -c || true

if [[ -n "${RELAY_URL:-}" ]]; then
  echo "Configuring relay URL: $RELAY_URL"
  "$ADB" -s "$SERIAL" shell am start \
    -a android.intent.action.VIEW \
    -d "agentwallet://configure-relay?url=$RELAY_URL" \
    -p "$PACKAGE" >/dev/null
  sleep 2
fi

echo "Launching $PACKAGE..."
"$ADB" -s "$SERIAL" shell am start -n "$PACKAGE/.MainActivity" >/dev/null
sleep 5

"$ADB" -s "$SERIAL" exec-out screencap -p > "$REPORT_DIR/launch.png" || true
"$ADB" -s "$SERIAL" logcat -d > "$REPORT_DIR/logcat.txt" || true

cat > "$REPORT_DIR/checklist.md" <<'EOF'
# Android Device Payment Loop QA Checklist

Device run artifacts:

- `launch.png`
- `logcat.txt`

Manual acceptance checklist:

- Pairing QR opens a pending pairing review from a trusted local agent.
- Pairing short code opens the same pending pairing review.
- Approving only non-signing scopes creates an active connection.
- Rejecting a pairing session creates no connection and cannot be approved later.
- Pausing or revoking a connection stops new standard Payment Requests from syncing.
- Normal Base USDC or Stellar XLM request appears in Inbox with hard payment facts visible.
- Missing-context request shows Missing context, keeps payment facts visible, and disables signing.
- Mismatch request shows Risk blocked and disables signing.
- AI-only request requires review and does not display as safe.
- Local signing requires biometric or device credential step-up.
- Signed, broadcasted, confirmed, failed, expired, and rejected states do not allow duplicate signing.
- Recovery phrase backup path requires local authentication and offline-copy confirmations.
EOF

echo "Device QA artifacts written to $REPORT_DIR"
echo "Complete the checklist in $REPORT_DIR/checklist.md during the device session."
