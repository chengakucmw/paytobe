#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const outputPath = path.resolve(
  repoRoot,
  process.argv[2] || "tmp/release-gate/velarumpay-sbom.cdx.json"
);
const skipAndroid = process.argv.includes("--skip-android");

const npmSbom = runJson("npm", [
  "sbom",
  "--package-lock-only",
  "--sbom-format",
  "cyclonedx",
  "--sbom-type",
  "application"
]);
const cargoMetadata = runJson("cargo", [
  "metadata",
  "--locked",
  "--format-version",
  "1",
  "--manifest-path",
  "crates/velarum-wallet-core/Cargo.toml"
]);

const components = new Map();
for (const component of npmSbom.components || []) addComponent(component);

for (const crate of cargoMetadata.packages || []) {
  addComponent({
    type: "library",
    name: crate.name,
    version: crate.version,
    licenses: crate.license ? [{ expression: crate.license }] : undefined,
    purl: `pkg:cargo/${encodeURIComponent(crate.name)}@${encodeURIComponent(crate.version)}`,
    properties: [{ name: "velarumpay:ecosystem", value: "cargo" }]
  });
}

if (!skipAndroid) {
  const gradleOutput = runText(
    platformCommand("./gradlew"),
    ["-q", "app:dependencies", "--configuration", "stellarTestnetReleaseRuntimeClasspath"],
    path.join(repoRoot, "apps/android"),
    androidEnv()
  );
  for (const coordinate of parseGradleCoordinates(gradleOutput)) {
    addComponent({
      type: "library",
      group: coordinate.group,
      name: coordinate.name,
      version: coordinate.version,
      purl: `pkg:maven/${encodeURIComponent(coordinate.group)}/${encodeURIComponent(coordinate.name)}@${encodeURIComponent(coordinate.version)}`,
      properties: [{ name: "velarumpay:ecosystem", value: "gradle" }]
    });
  }
}

const commit = runText("git", ["rev-parse", "HEAD"]).trim();
const commitTimestamp = runText("git", ["show", "-s", "--format=%cI", "HEAD"]).trim();
const document = {
  bomFormat: "CycloneDX",
  specVersion: "1.5",
  version: 1,
  metadata: {
    timestamp: commitTimestamp,
    tools: {
      components: [
        {
          type: "application",
          author: "VelarumPay",
          name: "generate-release-sbom.mjs"
        }
      ]
    },
    component: {
      type: "application",
      "bom-ref": `velarumpay:${commit}`,
      group: "com.velarumpay",
      name: "VelarumPay",
      version: commit,
      licenses: [{ license: { id: "Apache-2.0" } }]
    },
    properties: [
      { name: "velarumpay:git_commit", value: commit },
      { name: "velarumpay:android_configuration", value: skipAndroid ? "not-included" : "stellarTestnetReleaseRuntimeClasspath" }
    ]
  },
  components: [...components.values()].sort((left, right) => componentKey(left).localeCompare(componentKey(right)))
};

mkdirSync(path.dirname(outputPath), { recursive: true });
writeFileSync(outputPath, `${JSON.stringify(document, null, 2)}\n`, { mode: 0o644 });
console.log(`[release-sbom] wrote ${document.components.length} components to ${path.relative(repoRoot, outputPath)}`);

function addComponent(component) {
  if (!component?.name || !component?.version) return;
  const normalized = {
    ...component,
    "bom-ref": component["bom-ref"] || component.purl || componentKey(component)
  };
  components.set(normalized.purl || componentKey(normalized), normalized);
}

function componentKey(component) {
  return `${component.group || ""}:${component.name || ""}:${component.version || ""}`;
}

function parseGradleCoordinates(output) {
  const coordinates = new Map();
  for (const line of output.split(/\r?\n/)) {
    const marker = line.match(/(?:\+---|\\---)\s+([^\s].*)$/);
    if (!marker || marker[1].startsWith("project ")) continue;
    const coordinate = marker[1].match(/^([^:\s]+):([^:\s]+):([^\s({]+)/);
    if (!coordinate) continue;
    const selected = marker[1].match(/\s->\s([^\s({]+)/);
    const item = {
      group: coordinate[1],
      name: coordinate[2],
      version: selected?.[1] || coordinate[3]
    };
    coordinates.set(`${item.group}:${item.name}:${item.version}`, item);
  }
  return [...coordinates.values()];
}

function runJson(command, args, cwd = repoRoot, env = {}) {
  return JSON.parse(runText(command, args, cwd, env));
}

function runText(command, args, cwd = repoRoot, env = {}) {
  const result = spawnSync(command, args, {
    cwd,
    env: { ...process.env, ...env },
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(" ")} failed (${result.status}):\n${result.stderr || result.stdout}`);
  }
  return result.stdout;
}

function platformCommand(command) {
  return os.platform() === "win32" && command === "./gradlew" ? "gradlew.bat" : command;
}

function androidEnv() {
  const gradleUserHome = process.env.GRADLE_USER_HOME || path.join(repoRoot, "apps/android/.gradle-cache");
  mkdirSync(gradleUserHome, { recursive: true });
  if (process.env.JAVA_HOME) return { GRADLE_USER_HOME: gradleUserHome };
  const candidates = [
    "/opt/homebrew/opt/openjdk@17/libexec/openjdk.jdk/Contents/Home",
    "/usr/local/opt/openjdk@17/libexec/openjdk.jdk/Contents/Home"
  ];
  const javaHome = candidates.find((candidate) => existsSync(candidate));
  return javaHome
    ? {
        GRADLE_USER_HOME: gradleUserHome,
        JAVA_HOME: javaHome,
        PATH: `${path.join(javaHome, "bin")}${path.delimiter}${process.env.PATH || ""}`
      }
    : { GRADLE_USER_HOME: gradleUserHome };
}
