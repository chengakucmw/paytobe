#!/usr/bin/env node
import { loadDotEnv } from "../src/env.js";
import { loadRuntimeConfig, validateRuntimeConfig } from "../src/security.js";

loadDotEnv();

const config = loadRuntimeConfig();
const validation = validateRuntimeConfig(config);

for (const warning of validation.warnings) {
  console.warn(`warning: ${warning}`);
}

if (!validation.ok) {
  console.error("runtime configuration is not deployable:");
  for (const error of validation.errors) console.error(`- ${error}`);
  process.exit(1);
}

console.log(JSON.stringify({
  ok: true,
  runtime_env: config.runtime_env,
  production: config.production,
  store_path: config.storage.path || "default",
  cors_allowlist_count: config.cors.allowed_origins.length,
  rate_limit_enabled: config.rate_limit.enabled,
  openclaw_secrets_configured: config.openclaw.secrets.length
}, null, 2));
