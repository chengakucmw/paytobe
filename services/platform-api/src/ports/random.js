export function createRandomPort({ id, opaqueToken, connectKey } = {}) {
  for (const [name, value] of Object.entries({ id, opaqueToken, connectKey })) {
    if (typeof value !== "function") throw new TypeError(`Random ${name} function is required`);
  }
  return Object.freeze({
    id(prefix) {
      return nonEmpty(id(prefix), "id");
    },
    opaqueToken(prefix, bytes) {
      return nonEmpty(opaqueToken(prefix, bytes), "opaque token");
    },
    connectKey() {
      return nonEmpty(connectKey(), "connect key");
    }
  });
}

function nonEmpty(value, label) {
  const normalized = String(value || "").trim();
  if (!normalized) throw new TypeError(`Random ${label} must not be empty`);
  return normalized;
}
