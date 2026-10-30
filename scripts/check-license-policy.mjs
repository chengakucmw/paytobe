#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const approved = new Set([
  "0BSD",
  "Apache-2.0",
  "BSD-2-Clause",
  "BSD-3-Clause",
  "ISC",
  "MIT",
  "Unlicense",
  "Zlib",
  "CC0-1.0",
  "Unicode-3.0"
]);

const failures = [];
const rootPackage = readJson("package.json");
const workspaceNames = new Set();

for (const workspace of rootPackage.workspaces || []) {
  const manifest = readJson(path.join(workspace, "package.json"));
  workspaceNames.add(manifest.name);
  if (!licenseExpressionAllowed(manifest.license)) {
    failures.push(`workspace ${manifest.name}: ${manifest.license || "MISSING"}`);
  }
}

for (const lockfile of ["package-lock.json", "services/platform-api/package-lock.json"]) {
  const lock = readJson(lockfile);
  for (const [packagePath, entry] of Object.entries(lock.packages || {})) {
    if (!packagePath.includes("node_modules/")) continue;
    const name = packagePath.slice(packagePath.lastIndexOf("node_modules/") + "node_modules/".length);
    if (entry.link || workspaceNames.has(name)) continue;
    if (!licenseExpressionAllowed(entry.license)) {
      failures.push(`${lockfile} ${name}@${entry.version || "unknown"}: ${entry.license || "MISSING"}`);
    }
  }
}

const cargo = spawnSync(
  "cargo",
  [
    "metadata",
    "--locked",
    "--format-version",
    "1",
    "--manifest-path",
    "crates/Paytobe-wallet-core/Cargo.toml"
  ],
  { cwd: repoRoot, encoding: "utf8" }
);

if (cargo.error) {
  failures.push(`Rust license gate unavailable: ${cargo.error.message}`);
} else if (cargo.status !== 0) {
  failures.push(`Rust cargo metadata failed: ${(cargo.stderr || cargo.stdout || "unknown error").trim()}`);
} else {
  const metadata = JSON.parse(cargo.stdout);
  for (const crate of metadata.packages || []) {
    if (crate.name === "unicode-ident" && crate.version !== "1.0.24") {
      failures.push(`Rust unicode-ident version changed: ${crate.version} (approved: 1.0.24)`);
    }
    if (!licenseExpressionAllowed(crate.license)) {
      failures.push(`Rust ${crate.name}@${crate.version}: ${crate.license || "MISSING"}`);
    }
  }
}

const uniqueFailures = [...new Set(failures)].sort();
if (uniqueFailures.length) {
  console.error("Paytobe license policy check failed:");
  for (const failure of uniqueFailures) console.error(`- ${failure}`);
  console.error("No exception was created. Resolve or obtain an explicit owner decision consistent with Rule 0.");
  process.exit(1);
}

console.log("Paytobe license policy check passed for Node lock metadata and the Rust dependency graph.");

function readJson(relativePath) {
  return JSON.parse(readFileSync(path.join(repoRoot, relativePath), "utf8"));
}

function licenseExpressionAllowed(expression) {
  if (typeof expression !== "string" || !expression.trim() || expression === "UNLICENSED") return false;
  const normalized = expression.trim() === "MIT/Apache-2.0" || expression.trim() === "Apache-2.0/MIT"
    ? "MIT OR Apache-2.0"
    : expression.trim();
  const value = stripOuterParens(normalized);
  const alternatives = splitTopLevel(value, " OR ");
  if (alternatives.length > 1) return alternatives.some(licenseExpressionAllowed);
  const requirements = splitTopLevel(value, " AND ");
  if (requirements.length > 1) return requirements.every(licenseExpressionAllowed);
  return approved.has(value);
}

function stripOuterParens(value) {
  let result = value;
  while (wrapsWholeExpression(result)) result = result.slice(1, -1).trim();
  return result;
}

function wrapsWholeExpression(value) {
  if (!value.startsWith("(") || !value.endsWith(")")) return false;
  let depth = 0;
  for (let index = 0; index < value.length; index += 1) {
    if (value[index] === "(") depth += 1;
    if (value[index] === ")") depth -= 1;
    if (depth === 0 && index < value.length - 1) return false;
  }
  return depth === 0;
}

function splitTopLevel(value, separator) {
  const parts = [];
  let depth = 0;
  let start = 0;
  for (let index = 0; index <= value.length - separator.length; index += 1) {
    if (value[index] === "(") depth += 1;
    if (value[index] === ")") depth -= 1;
    if (depth === 0 && value.slice(index, index + separator.length) === separator) {
      parts.push(value.slice(start, index));
      start = index + separator.length;
      index += separator.length - 1;
    }
  }
  parts.push(value.slice(start));
  return parts.map((part) => stripOuterParens(part.trim()));
}
