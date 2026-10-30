#!/usr/bin/env node
import { spawn, spawnSync } from "node:child_process";
import { accessSync, constants, existsSync, mkdirSync } from "node:fs";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..");
const releaseCacheRoot = path.join(repoRoot, "tmp", "release-gate");
const npmCache = path.join(releaseCacheRoot, "npm");
const gradleCache = path.join(repoRoot, "apps", "android", ".gradle-cache");
mkdirSync(npmCache, { recursive: true });
mkdirSync(gradleCache, { recursive: true });
assertWritable(npmCache);
assertWritable(gradleCache);

const sharedEnv = {
  NPM_CONFIG_CACHE: npmCache,
  GRADLE_USER_HOME: gradleCache,
  VP_ALLOW_LISTEN_TESTS: "1"
};

const safeInheritedEnvKeys = [
  "PATH",
  "HOME",
  "USER",
  "LOGNAME",
  "TMPDIR",
  "SHELL",
  "LANG",
  "LC_ALL",
  "TERM",
  "JAVA_HOME",
  "ANDROID_HOME",
  "ANDROID_SDK_ROOT",
  "NDK_HOME",
  "CARGO_HOME",
  "RUSTUP_HOME",
  "DEVELOPER_DIR",
  "SDKROOT",
  "__CF_USER_TEXT_ENCODING"
];

const androidReleaseEnvKeys = [
  "Paytobe_ANDROID_KEYSTORE_PATH",
  "Paytobe_ANDROID_STORE_PASSWORD",
  "Paytobe_ANDROID_KEY_ALIAS",
  "Paytobe_ANDROID_KEY_PASSWORD",
  "Paytobe_FIREBASE_APPLICATION_ID",
  "Paytobe_FIREBASE_API_KEY",
  "Paytobe_FIREBASE_PROJECT_ID",
  "Paytobe_FIREBASE_SENDER_ID"
];

const args = new Set(process.argv.slice(2));
const skipAndroid = args.has("--skip-android") || args.has("--skip-mobile") || process.env.RELEASE_GATE_SKIP_ANDROID === "true";
const skipIos = args.has("--skip-ios") || args.has("--skip-mobile") || process.env.RELEASE_GATE_SKIP_IOS === "true";
const nodeOnly = args.has("--node-only") || process.env.RELEASE_GATE_NODE_ONLY === "true";

const steps = [
  {
    name: "license policy",
    command: "npm",
    args: ["run", "license:check"],
    timeoutMs: 5 * 60_000
  },
  {
    name: "workspace checks",
    command: "npm",
    args: ["run", "check"],
    timeoutMs: 10 * 60_000
  },
  {
    name: "cross-tenant security matrix",
    command: "node",
    args: ["--test", "tests/security/cross-tenant-matrix.test.mjs"],
    timeoutMs: 5 * 60_000
  },
  {
    name: "unit tests",
    command: "npm",
    args: ["test"],
    timeoutMs: 15 * 60_000
  },
  {
    name: "quickstart smoke",
    command: "npm",
    args: ["run", "smoke:quickstart"],
    timeoutMs: 5 * 60_000
  },
  {
    name: "cross-component smoke",
    command: "npm",
    args: ["run", "smoke:cross-component"],
    timeoutMs: 5 * 60_000
  },
  {
    name: "release SBOM",
    command: "node",
    args: ["scripts/generate-release-sbom.mjs"],
    timeoutMs: 10 * 60_000,
    skip: nodeOnly || skipAndroid
  },
  {
    name: "Android unit tests and signed testnet release build",
    command: platformCommand("./gradlew"),
    args: [
      "--rerun-tasks",
      "--no-build-cache",
      "testStandardDebugUnitTest",
      "assembleStandardDebug",
      "testStellarTestnetDebugUnitTest",
      "assembleStellarTestnetDebug",
      "lintStellarTestnetRelease",
      "assembleStellarTestnetRelease"
    ],
    cwd: path.join(repoRoot, "apps/android"),
    env: androidEnv(),
    allowAndroidReleaseEnv: true,
    timeoutMs: 30 * 60_000,
    skip: nodeOnly || skipAndroid
  },
  {
    // Run the iOS UNIT TESTS, not just a build — this is what CI's ios job does
    // (xcodebuild test), so the local gate must not be weaker. The concrete
    // simulator destination is resolved in assertRunnable (only when this step
    // actually runs, i.e. on macOS and not skipped).
    name: "iOS simulator unit tests",
    command: "xcodebuild",
    args: [],
    timeoutMs: 30 * 60_000,
    skip: nodeOnly || skipIos
  }
];

if (args.has("--help")) {
  console.log(`Usage: npm run release:gate -- [--node-only] [--skip-android] [--skip-ios] [--skip-mobile]

Default behavior runs every v0.1 release gate:
- workspace checks
- unit tests
- quickstart smoke
- cross-component smoke
- Android standard and stellarTestnet Debug unit tests + builds
- uncached Android release verification (all Gradle tasks are rerun with the build cache disabled)
- full stellarTestnet Release lint
- signed stellarTestnet Release APK (release signing configuration is mandatory)
- iOS simulator unit tests (xcodebuild test)
`);
  process.exit(0);
}

const startedAt = Date.now();
const results = [];

for (const step of steps) {
  if (step.skip) {
    results.push({ name: step.name, status: "skipped" });
    console.log(`\n[release-gate] skip ${step.name}`);
    continue;
  }
  assertRunnable(step);
  console.log(`\n[release-gate] start ${step.name}`);
  const code = await run(step);
  results.push({ name: step.name, status: code === 0 ? "passed" : "failed", code });
  if (code !== 0) {
    printSummary(results, Date.now() - startedAt);
    process.exit(code);
  }
}

printSummary(results, Date.now() - startedAt);
printEvidence();

function assertRunnable(step) {
  if (step.command === platformCommand("./gradlew")) {
    const gradlew = path.join(step.cwd, platformCommand("gradlew"));
    if (!existsSync(gradlew)) throw new Error(`Missing Android Gradle wrapper at ${gradlew}`);
    return;
  }
  if (step.command === "xcodebuild") {
    if (os.platform() !== "darwin") {
      throw new Error("xcodebuild release gate requires macOS. Use --skip-ios only for non-release local checks.");
    }
    if (!commandExists("xcodebuild")) {
      throw new Error("xcodebuild was not found. Install Xcode command line tools or use --skip-ios for local checks.");
    }
    // Resolve a concrete simulator here (not at module load) so non-macOS and
    // --skip-ios runs never shell out to simctl. `xcodebuild test` needs a real
    // destination, unlike a plain build.
    step.args = iosTestArgs(resolveIosSimulatorDestination());
  }
}

function iosTestArgs(destination) {
  return [
    "test",
    "-project",
    path.join(repoRoot, "apps/ios/Paytobe.xcodeproj"),
    "-scheme",
    "Paytobe",
    "-sdk",
    "iphonesimulator",
    "-destination",
    destination,
    "CODE_SIGNING_ALLOWED=NO"
  ];
}

// Pick the first available iPhone simulator, mirroring the CI ios job's selection
// step. Throws a clear, actionable error when none is installed (the gate fails
// loudly rather than silently skipping the iOS tests).
function resolveIosSimulatorDestination() {
  const result = spawnSync("xcrun", ["simctl", "list", "devices", "available", "-j"], { encoding: "utf8" });
  if (result.status !== 0) {
    throw new Error("Could not list iOS simulators (xcrun simctl). Install Xcode, or use --skip-ios for local checks.");
  }
  let data;
  try {
    data = JSON.parse(result.stdout);
  } catch {
    throw new Error("Could not parse the iOS simulator list from simctl.");
  }
  for (const runtime of Object.keys(data.devices || {})) {
    for (const device of data.devices[runtime] || []) {
      if (device.isAvailable && /iPhone/.test(device.name || "")) {
        return `id=${device.udid}`;
      }
    }
  }
  throw new Error("No available iPhone simulator was found. Create one in Xcode, or use --skip-ios for local checks.");
}

function run(step) {
  return new Promise((resolve) => {
    let settled = false;
    const child = spawn(step.command, step.args, {
      cwd: step.cwd || repoRoot,
      env: childEnvironment(step),
      stdio: "inherit"
    });
    const timeout = setTimeout(() => {
      if (settled) return;
      console.error(`[release-gate] timeout ${step.name} after ${step.timeoutMs}ms`);
      child.kill("SIGTERM");
      setTimeout(() => {
        if (!settled) child.kill("SIGKILL");
      }, 5_000).unref();
    }, step.timeoutMs);
    child.on("close", (code, signal) => {
      settled = true;
      clearTimeout(timeout);
      if (signal) console.error(`[release-gate] ${step.name} terminated by ${signal}`);
      resolve(code ?? 1);
    });
  });
}

function childEnvironment(step) {
  const env = {};
  for (const key of safeInheritedEnvKeys) {
    if (process.env[key] !== undefined) env[key] = process.env[key];
  }
  if (step.allowAndroidReleaseEnv) {
    for (const key of androidReleaseEnvKeys) {
      if (process.env[key] !== undefined) env[key] = process.env[key];
    }
  }
  return {
    ...env,
    ...sharedEnv,
    ...(step.env || {})
  };
}

function assertWritable(directory) {
  accessSync(directory, constants.R_OK | constants.W_OK);
}

function printEvidence() {
  const commit = spawnSync("git", ["rev-parse", "HEAD"], { cwd: repoRoot, encoding: "utf8" });
  const dirty = spawnSync("git", ["status", "--porcelain"], { cwd: repoRoot, encoding: "utf8" });
  console.log("\n[release-gate] evidence");
  console.log(`- git_commit: ${commit.status === 0 ? commit.stdout.trim() : "unavailable"}`);
  console.log(`- git_worktree_clean: ${dirty.status === 0 && dirty.stdout.trim() === ""}`);
  const artifacts = [
    "services/platform-api/openapi/Paytobe-platform-api-v0.1.openapi.json",
    "packages/protocol/schema/Paytobe.payment_request.v1.schema.json",
    "packages/protocol/schema/Paytobe.transaction_context.v1.schema.json"
  ];
  if (!nodeOnly && !skipAndroid) {
    artifacts.push(
      "tmp/release-gate/Paytobe-sbom.cdx.json",
      "apps/android/app/build/outputs/apk/standard/debug/Paytobe-standardDebug.apk",
      "apps/android/app/build/outputs/apk/stellarTestnet/debug/Paytobe-stellarTestnetDebug.apk",
      "apps/android/app/build/outputs/apk/stellarTestnet/release/Paytobe-stellarTestnetRelease.apk"
    );
  }
  for (const relative of artifacts) {
    const absolute = path.join(repoRoot, relative);
    if (!existsSync(absolute)) throw new Error(`Release evidence artifact is missing: ${relative}`);
    console.log(`- sha256 ${hashFile(absolute)} ${relative}`);
  }
}

function hashFile(file) {
  return createHash("sha256").update(readFileSync(file)).digest("hex");
}

function commandExists(command) {
  const result = spawnSync("which", [command], {
    stdio: "ignore"
  });
  return result.status === 0;
}

function platformCommand(command) {
  if (os.platform() === "win32" && command === "./gradlew") return "gradlew.bat";
  if (os.platform() === "win32" && command === "gradlew") return "gradlew.bat";
  return command;
}

function androidEnv() {
  if (process.env.JAVA_HOME) return {};
  const candidates = [
    "/opt/homebrew/opt/openjdk@17/libexec/openjdk.jdk/Contents/Home",
    "/usr/local/opt/openjdk@17/libexec/openjdk.jdk/Contents/Home"
  ];
  const javaHome = candidates.find((candidate) => existsSync(candidate));
  if (!javaHome) return {};
  return {
    JAVA_HOME: javaHome,
    PATH: `${path.join(javaHome, "bin")}${path.delimiter}${process.env.PATH || ""}`
  };
}

function printSummary(results, durationMs) {
  console.log("\n[release-gate] summary");
  for (const result of results) {
    const suffix = result.code === undefined ? "" : ` (${result.code})`;
    console.log(`- ${result.status}: ${result.name}${suffix}`);
  }
  console.log(`[release-gate] duration_ms=${durationMs}`);
}
