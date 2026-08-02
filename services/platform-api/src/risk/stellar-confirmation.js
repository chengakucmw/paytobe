// M-2: a Stellar transaction that merely APPEARS in Horizon is not necessarily a
// success — Stellar still includes failed transactions in the ledger (and charges
// their fee), and Horizon marks them with `successful: false`. Treat ONLY
// successful === true as confirmed; surface the on-chain reason otherwise. A null
// `stellar` means "not found yet" → keep polling. Pure, so it can be unit-tested
// without importing the HTTP server.

export function stellarConfirmationResult(stellar) {
  if (!stellar) return null;
  if (stellar.successful === true) return { ok: true };
  const reason = stellar.result_xdr
    ? `Stellar transaction failed (result ${stellar.result_xdr})`
    : "Stellar transaction failed on-chain";
  return { ok: false, error: reason };
}
