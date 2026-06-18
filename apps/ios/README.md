# VelarumPay iOS

SwiftUI iOS wallet shell for VelarumPay mobile QA. The app reviews Payment
Request v1 payloads, pairing sessions, inbox status, risk states, and local
Stellar XLM signing boundaries.

## Simulator Build

```bash
cd /Users/yang/code/VelarumPayCode
xcodebuild -project apps/ios/VelarumPay.xcodeproj \
  -scheme VelarumPay \
  -configuration Debug \
  -sdk iphonesimulator \
  build
```

## XCTest

Run the iOS unit tests on the local simulator:

```bash
cd /Users/yang/code/VelarumPayCode
xcodebuild -project apps/ios/VelarumPay.xcodeproj \
  -scheme VelarumPay \
  -configuration Debug \
  -sdk iphonesimulator \
  -destination 'platform=iOS Simulator,name=iPhone 17' \
  test
```

The test target covers standard Payment Request parsing, missing-context
blocking, risk-blocked action state, pairing short-code/URI parsing, and
filtering of signing/private-key scopes.

## Device QA

Run the preflight first. It builds and tests on simulator, lists available
devices, and prints the manual acceptance checklist:

```bash
cd /Users/yang/code/VelarumPayCode
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
