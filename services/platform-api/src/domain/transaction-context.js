// Builds the server-trusted Transaction Context projection for a Payment
// Request. Needs the store (to fetch the stored context), so it's produced by
// a factory wired once at startup.

import { createTransactionContextSnapshot } from "../Paytobe.js";
import { apiWarning } from "../http/responses.js";

export function createTransactionContext({ store }) {
  function buildTransactionContextProjection(request) {
    // M7: the transaction context snapshot is security-sensitive evidence
    // (merchant identity, costs, payee binding) that risk scoring trusts. It must
    // be derived ONLY from a server-stored context that belongs to THIS request's
    // connection. We never fall back to the request's own client-supplied
    // snapshot — a malicious agent could forge a "safe-looking" one. When we can't
    // build it from server data we return snapshot:null and mark the context
    // missing, so risk treats it as unverified rather than believing the caller.
    if (!request.transaction_id) {
      return {
        ref: { status: "missing" },
        snapshot: null,
        context: null,
        warnings: [apiWarning("context_missing", "Payment Request has no transaction_id", { field: "transaction_id" })]
      };
    }

    const context = store.transactionContext(request.transaction_id);
    if (!context || context.connection_id !== request.connection_id) {
      return {
        ref: { transaction_id: request.transaction_id, status: "missing" },
        snapshot: null,
        context: null,
        warnings: [apiWarning("context_missing", "Transaction Context is not available for this connection", {
          field: "transaction_id"
        })]
      };
    }

    const snapshot = createTransactionContextSnapshot(context);
    if (!snapshot.ok) {
      return {
        ref: { transaction_id: request.transaction_id, status: "missing" },
        snapshot: null,
        context,
        warnings: snapshot.errors || [snapshot.error]
      };
    }

    return {
      ref: {
        transaction_id: request.transaction_id,
        status: "ready",
        snapshot_hash: snapshot.value.snapshot_hash
      },
      snapshot: snapshot.value,
      context,
      warnings: snapshot.warnings || []
    };
  }

  return { buildTransactionContextProjection };
}
