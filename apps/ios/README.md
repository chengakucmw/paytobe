# Paytobe iOS

> **Last modified**
> - **Taipei Time:** 2026-10-29 13:41:42 Asia/Taipei (UTC+08:00)
> - **UTC:** 2026-10-29 05:41:42 UTC

SwiftUI iOS wallet shell for Paytobe mobile QA. The app reviews Payment
Request v1 payloads, pairing sessions, inbox status, risk states, and local
Stellar XLM signing boundaries.

## Simulator Build

```bash
cd /path/to/Paytobe
xcodebuild -project apps/ios/Paytobe.xcodeproj \
  -scheme Paytobe \
  -configuration Debug \
  -sdk iphonesimulator \
  build
```

## XCTest

Run the iOS unit tests on the local simulator:

```bash
cd /path/to/Paytobe
xcodebuild -project apps/ios/Paytobe.xcodeproj \
  -scheme Paytobe \
  -configuration Debug \
  -sdk iphonesimulator \
  -destination 'platform=iOS Simulator,name=iPhone 17' \
  test
```

The test target covers standard Payment Request parsing, missing-context
blocking, risk-blocked action state, pairing short-code/URI parsing, and
filtering of signing/private-key scopes.

## One-time Connect Key

Open **Settings → Agent Pairing → Create one-time Connect Key**. The app idempotently registers its device, requests a five-minute key from the configured Relay URL, and shows the plaintext key only for copying. It polls for an Agent claim, then displays the Agent's self-declared identity and non-signing scopes before the existing approve/reject review. Connect Keys never grant signing authority and cannot be reused after claim, cancellation, rejection, connection, or expiry.

## Device QA

Run the preflight first. It builds and tests on simulator, lists available
devices, and prints the manual acceptance checklist:

```bash
cd /path/to/Paytobe
apps/ios/scripts/device-qa.sh --preflight
```

When an unlocked iPhone is connected and trusted, pass an explicit Xcode
destination. If signing needs a team, set `DEVELOPMENT_TEAM`.

```bash
DEVICE_DESTINATION='platform=iOS,name=Alice iPhone' \
DEVELOPMENT_TEAM=ABCDE12345 \
apps/ios/scripts/device-qa.sh
```

Device evidence should include the command output, the connected device name,
scanner success/failure notes, inbox screenshots, and signing-boundary notes.
Do not capture private keys, seed phrases, or real payment secrets.
