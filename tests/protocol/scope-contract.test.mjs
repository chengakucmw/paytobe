// B1 scope-contract test.
// The protocol package is the single source of truth for the pairing/authorization
// scope vocabulary. This test fails if the protocol list drifts from the dotted
// scopes that the runtime consumers (platform-api, mcp-server, hermes) actually use,
// or if any pre-1.0 underscore scope name reappears anywhere.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import test from "node:test";
import {
  PAIRING_SCOPES,
  DEFAULT_PAIRING_SCOPES,
  DEPRECATED_PAIRING_SCOPE_ALIASES
} from "../../packages/protocol/src/index.js";

const repoRoot = fileURLToPath(new URL("../../", import.meta.url));

// The canonical vocabulary. If the product genuinely adds a scope, update it HERE and
// in the consumers below in the same change — that is the whole point of this guard.
const DEFAULT_SCOPES = [
  "payment.requests.create",
  "payment.requests.read",
  "transaction_contexts.create",
  "transaction_contexts.read"
];
const ALLOWED_SCOPES = [...DEFAULT_SCOPES, "wallet.addresses.read"];

const LEGACY_SCOPE_NAMES = [
  "request_payments",
  "create_transaction_contexts",
  "view_balances",
  "read_payment_status",
  "save_merchants",
  "manage_connections"
];

const CONSUMERS = [
  // platform-api's pairing scope vocabulary lives in domain/scopes.js (the
  // ALLOWED_PAIRING_SCOPES / DEFAULT_PAIRING_SCOPES constants server.js imports).
  "services/platform-api/src/domain/scopes.js",
  "connectors/mcp-server/src/tools.js",
  "connectors/hermes/src/index.js"
];

test("protocol exports the canonical dotted scope vocabulary", () => {
  assert.deepEqual([...DEFAULT_PAIRING_SCOPES], DEFAULT_SCOPES);
  assert.deepEqual([...PAIRING_SCOPES].sort(), [...ALLOWED_SCOPES].sort());
});

test("every default scope appears in each runtime consumer", () => {
  for (const rel of CONSUMERS) {
    const text = readFileSync(new URL(rel, `file://${repoRoot}`), "utf8");
    for (const scope of DEFAULT_SCOPES) {
      assert.ok(text.includes(`"${scope}"`), `${rel} is missing scope ${scope}`);
    }
  }
});

test("no legacy underscore scope name survives in protocol or consumers", () => {
  for (const legacy of LEGACY_SCOPE_NAMES) {
    assert.equal(PAIRING_SCOPES.includes(legacy), false, `PAIRING_SCOPES still lists ${legacy}`);
  }
  for (const rel of CONSUMERS) {
    const text = readFileSync(new URL(rel, `file://${repoRoot}`), "utf8");
    for (const legacy of LEGACY_SCOPE_NAMES) {
      assert.equal(text.includes(`"${legacy}"`), false, `${rel} still references legacy scope ${legacy}`);
    }
  }
});

test("deprecated aliases map only to live scopes", () => {
  for (const [legacy, modern] of Object.entries(DEPRECATED_PAIRING_SCOPE_ALIASES)) {
    assert.ok(LEGACY_SCOPE_NAMES.includes(legacy), `${legacy} is not a known legacy name`);
    assert.ok(PAIRING_SCOPES.includes(modern), `alias target ${modern} is not a live scope`);
  }
});
