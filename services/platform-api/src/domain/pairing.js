// Pairing-session helpers that touch the store (unique-code allocation and
// id/code resolution). Produced by a factory wired once at startup.

import { randomNumericCode } from "../crypto.js";

export function createPairing({ store }) {
  function uniquePairingCode() {
    // M4: crypto.randomInt is uniform and unpredictable (no modulo bias, not a
    // seedable PRNG), so 6-digit codes neither cluster nor can be guessed. If
    // every retry collides with a live session we FAIL instead of returning a
    // known-colliding code — the old fallback returned a duplicate anyway, which
    // could clobber another session's code index.
    for (let attempt = 0; attempt < 10; attempt++) {
      const code = randomNumericCode(6);
      if (!store.pairingSessionByCode(code)) return code;
    }
    throw new Error("pairing_code_unavailable");
  }

  function resolvePairingSession(idOrCode, body = {}) {
    const session = store.pairingSession(String(idOrCode || ""));
    if (!session) return null;
    const pairingCode = body.pairing_code || body.code;
    if (pairingCode && String(pairingCode) !== session.pairing_code) return null;
    return session;
  }

  return { uniquePairingCode, resolvePairingSession };
}
