import {
  assertResourceTenant,
  authorize,
  createAuthContext,
  tenantScopeFromAuthContext
} from "../domain/auth-context.js";

export function createPlatformCore({ clock, random, transaction, repositories = {} }) {
  requireMethod(clock, "now");
  requireMethod(clock, "nowIso");
  requireMethod(clock, "after");
  requireMethod(clock, "isExpired");
  requireMethod(random, "id");
  requireMethod(random, "opaqueToken");
  requireMethod(random, "connectKey");
  requireMethod(transaction, "execute");

  return Object.freeze({
    clock,
    random,
    transaction,
    repositories: Object.freeze({ ...repositories }),
    auth: Object.freeze({
      fromVerifiedIdentity: createAuthContext,
      authorize,
      tenantScope: tenantScopeFromAuthContext,
      assertResourceTenant
    })
  });
}

function requireMethod(value, method) {
  if (!value || typeof value[method] !== "function") throw new TypeError(`Platform core port is missing ${method}()`);
}
