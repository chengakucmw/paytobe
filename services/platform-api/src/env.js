import fs from "fs";
import path from "path";

export function loadDotEnv(file = process.env.ENV_FILE || path.resolve(".env")) {
  if (!file || !fs.existsSync(file)) {
    return { loaded: false, file, keys: [] };
  }

  const keys = [];
  const lines = fs.readFileSync(file, "utf8").split(/\r?\n/);
  for (const line of lines) {
    const parsed = parseDotEnvLine(line);
    if (!parsed) continue;
    if (process.env[parsed.key] !== undefined) continue;
    process.env[parsed.key] = parsed.value;
    keys.push(parsed.key);
  }
  return { loaded: true, file, keys };
}

function parseDotEnvLine(line) {
  const trimmed = String(line || "").trim();
  if (!trimmed || trimmed.startsWith("#")) return null;
  const normalized = trimmed.startsWith("export ") ? trimmed.slice("export ".length).trim() : trimmed;
  const index = normalized.indexOf("=");
  if (index <= 0) return null;

  const key = normalized.slice(0, index).trim();
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) return null;
  const value = stripInlineComment(normalized.slice(index + 1).trim());
  return { key, value: unquote(value) };
}

function stripInlineComment(value) {
  if (value.startsWith("\"") || value.startsWith("'")) return value;
  const index = value.search(/\s#/);
  return index === -1 ? value : value.slice(0, index).trimEnd();
}

function unquote(value) {
  if (value.length < 2) return value;
  const quote = value[0];
  if ((quote !== "\"" && quote !== "'") || value[value.length - 1] !== quote) return value;
  const inner = value.slice(1, -1);
  return quote === "\"" ? inner.replaceAll("\\n", "\n").replaceAll("\\\"", "\"") : inner;
}
