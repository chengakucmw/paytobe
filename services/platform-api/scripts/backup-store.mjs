#!/usr/bin/env node
import path from "path";
import { loadDotEnv } from "../src/env.js";
import { Store } from "../src/store.js";

loadDotEnv();

const backupDir = process.env.RELAY_BACKUP_DIR || "/var/backups/velarumpay";
const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
const target = process.argv[2] || path.join(backupDir, `relay-store-${timestamp}.sqlite`);
const store = new Store();

try {
  const backup = store.backup(path.resolve(target));
  console.log(JSON.stringify({
    ok: true,
    backup,
    storage: store.info()
  }, null, 2));
} finally {
  store.close();
}
