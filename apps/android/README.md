# VelarumPay Android Build and Test

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
./gradlew testDebugUnitTest
./gradlew assembleDebug
```

Both commands are required before marking the Android build/test environment as closed.

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
