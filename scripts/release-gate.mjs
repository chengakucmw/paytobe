#!/usr/bin/env node
import { spawn, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..");

const args = new Set(process.argv.slice(2));
const skipAndroid = args.has("--skip-android") || args.has("--skip-mobile") || process.env.RELEASE_GATE_SKIP_ANDROID === "true";
const skipIos = args.has("--skip-ios") || args.has("--skip-mobile") || process.env.RELEASE_GATE_SKIP_IOS === "true";
const nodeOnly = args.has("--node-only") || process.env.RELEASE_GATE_NODE_ONLY === "true";

const steps = [
  {
    name: "license policy",
    command: "npm",
    args: ["run", "license:check"]
  },
  {
    name: "workspace checks",
    command: "npm",
    args: ["run", "check"]
  },
  {
    name: "cross-tenant security matrix",
    command: "node",
    args: ["--test", "tests/security/cross-tenant-matrix.test.mjs"]
  },
  {
    name: "unit tests",
    command: "npm",
    args: ["test"]
  },
  {
    name: "quickstart smoke",
    command: "npm",
    args: ["run", "smoke:quickstart"]
  },
  {
    name: "cross-component smoke",
    command: "npm",
    args: ["run", "smoke:cross-component"]
  },
  {
    name: "Android unit tests and debug build",
    command: platformCommand("./gradlew"),
    args: [
      "testStandardDebugUnitTest",
      "assembleStandardDebug",
      "testStellarTestnetDebugUnitTest",
      "assembleStellarTestnetDebug"
    ],
    cwd: path.join(repoRoot, "apps/android"),
    env: androidEnv(),
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
    path.join(repoRoot, "apps/ios/VelarumPay.xcodeproj"),
    "-scheme",
    "VelarumPay",
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
    const child = spawn(step.command, step.args, {
      cwd: step.cwd || repoRoot,
      env: {
        ...process.env,
        ...(step.env || {})
      },
      stdio: "inherit"
    });
    child.on("close", resolve);
  });
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
