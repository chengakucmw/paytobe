# VelarumPay Android Build and Test

> **Last modified**
> - **Taipei Time:** 2026-08-02 08:24:05 Asia/Taipei (UTC+08:00)
> - **UTC:** 2026-08-02 00:24:05 UTC

This app is built with Android Gradle Plugin 8.7.3 and the Gradle wrapper pinned to Gradle 8.9.

## Local Setup

Use JDK 17 and an Android SDK that includes API 35:

```sh
export JAVA_HOME=/opt/homebrew/opt/openjdk@17/libexec/openjdk.jdk/Contents/Home
export ANDROID_HOME="$HOME/Library/Android/sdk"
```

Create `local.properties` in this directory when Gradle cannot discover the SDK:

```properties
sdk.dir=/Users/yang/Library/Android/sdk
```

`local.properties` is ignored by git because it is machine-specific.

## Verification

Run from `apps/android`:

```sh
./gradlew testStandardDebugUnitTest assembleStandardDebug
./gradlew testStellarTestnetDebugUnitTest assembleStellarTestnetDebug
```

Both product flavors must pass their Debug unit tests and builds before marking the Android build/test environment as closed. Flavor-qualified task names are intentional: the unqualified `testDebugUnitTest` and `assembleDebug` names become ambiguous once multiple network flavors exist.

## FCM and REST Compensation Sync

Firebase is initialized from build-time values; the app does not require a committed `google-services.json`. Supply these values through Gradle properties or environment variables when producing the real device build:

```sh
export VELARUMPAY_FIREBASE_APPLICATION_ID='1:...:android:...'
export VELARUMPAY_FIREBASE_API_KEY='...'
export VELARUMPAY_FIREBASE_PROJECT_ID='...'
export VELARUMPAY_FIREBASE_SENDER_ID='...'
```

FCM is only a wake-up signal and contains opaque synchronization coordinates. After every push, and when the app resumes, the wallet uses authenticated REST synchronization to fetch the complete Payment Request. The REST cursor advances only after a successful sync and performs a full inbox refresh when the server reports that retained events no longer cover the cursor.

## Stellar Public-Network Build Gate

Stellar public-network signing is disabled in builds by default. An explicitly authorized small-mainnet build must set all four controls:

```sh
export VELARUMPAY_STELLAR_MAINNET_ENABLED=true
export VELARUMPAY_STELLAR_MAINNET_MAX_XLM=1
export VELARUMPAY_STELLAR_MAINNET_HORIZON_URL=https://horizon.stellar.org
export VELARUMPAY_STELLAR_MAINNET_RECIPIENTS=G...verified-recipient
```

The comma-separated recipient list is compiled into the build. The app checks the network, positive amount, single-payment cap, exact HTTPS Horizon endpoint, and recipient allowlist during review and again immediately before sequence lookup, signing, and broadcast. Testnet remains available without enabling this production gate. The Platform API has an independent server-side gate and must be configured consistently.

## One-time Connect Key

Open **Profile → Connected agents → Create one-time Connect Key**. The app idempotently registers its device, requests a five-minute key from the configured Relay URL, and shows the plaintext key only for copying. After an Agent consumes it, the page displays the Agent's self-declared identity and non-signing scopes and routes the user through the existing approve/reject review. Connect Keys never grant signing authority, and terminal keys cannot be reused.

## Device Payment Loop QA

Run the preflight without a connected device:

```sh
scripts/device-payment-loop-qa.sh --preflight
```

Run the device QA harness with an unlocked Android phone connected over adb:

```sh
RELAY_URL=http://192.168.1.10:8787 scripts/device-payment-loop-qa.sh
```

The harness runs unit tests, assembles the debug APK, installs and launches the
app, optionally configures the relay URL, and writes screenshot, logcat, and a
manual acceptance checklist under `build/reports/device-payment-loop-qa/`.
