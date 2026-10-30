import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { createPlatformCore } from "../../services/platform-api/src/application/platform-core.js";
import { AuthorizationFailure, createAuthContext } from "../../services/platform-api/src/domain/auth-context.js";
import { createClockPort } from "../../services/platform-api/src/ports/clock.js";
import { createRandomPort } from "../../services/platform-api/src/ports/random.js";
import { createRepositoryPort, createTransactionBoundary } from "../../services/platform-api/src/ports/repository.js";

const codeRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const forbiddenImports = /(?:from\s+["'][^"']*(?:express|worker|sqlite|d1)[^"']*["']|node:sqlite)/i;

test("new application, AuthContext, and port modules have no HTTP or database runtime dependency", () => {
  const files = [
    "application/platform-core.js",
    "domain/auth-context.js",
    "ports/clock.js",
    "ports/random.js",
    "ports/repository.js"
  ];
  for (const file of files) {
    const source = fs.readFileSync(path.join(codeRoot, "services/platform-api/src", file), "utf8");
    assert.doesNotMatch(source, forbiddenImports, file);
  }
});

test("clock and random behavior is supplied through explicit ports", () => {
  const clock = createClockPort(() => "2026-08-01T00:00:00.000Z");
  const random = createRandomPort({
    id: (prefix) => `${prefix}_fixed`,
    opaqueToken: (prefix) => `${prefix}_opaque`,
    connectKey: () => "Paytobe-connect:ck_fixed"
  });
  assert.equal(clock.nowIso(), "2026-08-01T00:00:00.000Z");
  assert.equal(clock.after(1_000), "2026-08-01T00:00:01.000Z");
  assert.equal(random.id("merchant"), "merchant_fixed");
});

test("AuthContext is immutable, tenant-derived, and scope-authorized", () => {
  const authContext = createAuthContext({
    actor_type: "agent_client",
    actor_id: "client_1",
    merchant_id: "merchant_1",
    agent_id: "agent_1",
    client_id: "client_1",
    credential_id: "credential_1",
    scopes: ["payment.requests.create"],
    auth_method: "agent_assertion",
    request_id: "request_1"
  });
  const core = createPlatformCore({
    clock: createClockPort(() => 0),
    random: createRandomPort({ id: () => "id_1", opaqueToken: () => "token_1", connectKey: () => "key_1" }),
    transaction: createTransactionBoundary()
  });
  assert.ok(Object.isFrozen(authContext));
  assert.deepEqual(core.auth.tenantScope(authContext), { merchant_id: "merchant_1" });
  assert.equal(core.auth.authorize(authContext, { scopes: ["payment.requests.create"] }), authContext);
  assert.throws(
    () => core.auth.assertResourceTenant(authContext, { merchant_id: "merchant_2" }),
    (error) => error instanceof AuthorizationFailure && error.status === 404 && error.code === "resource_not_found"
  );
  assert.throws(() => createAuthContext({ ...authContext, scopes: ["wallet.sign"] }), /cannot grant/);
});

test("repository and transaction ports make persistence boundaries explicit", async () => {
  const repository = { find: () => ({ merchant_id: "merchant_1" }) };
  const port = createRepositoryPort(repository, ["find"]);
  const calls = [];
  const transaction = createTransactionBoundary(async (operation) => {
    calls.push("begin");
    const result = await operation();
    calls.push("commit");
    return result;
  });
  assert.equal(port.repository.find().merchant_id, "merchant_1");
  assert.equal(await transaction.execute(async () => "ok"), "ok");
  assert.deepEqual(calls, ["begin", "commit"]);
  assert.throws(() => createRepositoryPort({}, ["find"]), /find/);
});
