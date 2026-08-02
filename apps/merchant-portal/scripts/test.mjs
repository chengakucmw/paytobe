import { readdir } from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const filters = process.argv.slice(2).map((value) => value.toLowerCase());
const names = (await readdir(path.join(root, "test")))
  .filter((name) => name.endsWith(".test.mjs"))
  .filter((name) => !filters.length || filters.some((filter) => name.toLowerCase().includes(filter)))
  .sort();
if (!names.length) throw new Error(`No portal tests matched: ${filters.join(", ")}`);
const child = spawn(process.execPath, ["--test", ...names.map((name) => path.join(root, "test", name))], { stdio: "inherit" });
child.once("exit", (code, signal) => process.exit(signal ? 1 : (code ?? 1)));
