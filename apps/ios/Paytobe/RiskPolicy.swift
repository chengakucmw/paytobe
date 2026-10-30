import Foundation

/// iOS client-side risk backstop — a fail-closed second line of defense that mirrors
/// Android's `RiskPolicy.java`.
///
/// The relay/backend remains the authoritative risk engine, and its verdict is already
/// honored before this runs (via `intent.signingAllowed` / risk findings in
/// `isPaymentDetailSignable`). But a non-custodial wallet must never sign solely on a
/// relay-supplied "allowed" flag: a stale, buggy, or tampered payload could omit the
/// block. This independently recomputes the daily spend cap and the unverified-recipient
/// cap locally, in exact base-10 `Decimal` (never `Double` — amounts are money), before
/// any signature is produced. iOS v1 only signs Stellar XLM, so only the XLM caps are
/// evaluated here; the structure mirrors Android so the other assets can be added when
/// iOS gains the ability to sign them.
enum LocalRiskPolicy {
    // These literals mirror the canonical packages/protocol RISK_LIMITS
    // (daily_limit_default / unverified_recipient_cap) — the single source of truth shared
    // with the backend and Android RiskPolicy.java. iOS cannot import the JS protocol at
    // runtime, so the values are pinned against RISK_LIMITS by
    // tests/protocol/risk-limits-contract.test.mjs; update there and here together.

    /// Exact daily spend cap per asset. Mirrors RISK_LIMITS.daily_limit_default.
    static let dailyXLMLimit = Decimal(1000)
    /// Exact cap for a single payment to a recipient that is not on the local whitelist.
    /// Mirrors RISK_LIMITS.unverified_recipient_cap (the M10 fail-closed control).
    static let unverifiedXLMCap = Decimal(100)

    struct Result {
        private(set) var errors: [String] = []
        private(set) var warnings: [String] = []
        var allowed: Bool { errors.isEmpty }

        mutating func block(_ message: String) { errors.append(message) }
        mutating func warn(_ message: String) { warnings.append(message) }
    }

    /// Evaluate the local backstop for a pending XLM payment.
    /// - Parameters:
    ///   - amount: the payment amount as a decimal string (for example `"12.5"`).
    ///   - spentTodayXLM: the exact amount of XLM already broadcast today, from the local ledger.
    ///   - recipientWhitelisted: whether the recipient is on the user's local trust list.
    static func evaluateXLM(amount: String,
                            spentTodayXLM: Decimal,
                            recipientWhitelisted: Bool) -> Result {
        var result = Result()
        guard let value = parseAmount(amount), value > 0 else {
            // Fail closed: a blank, non-positive, or unparseable amount is a block. The
            // signer's own strict parse (xlmToStroops) would also reject it, with no funds
            // moved, but blocking here keeps the daily ledger from being polluted.
            result.block("XLM amount is invalid")
            return result
        }
        // Daily spend cap (exact): today's spend + this payment must not exceed the cap.
        if spentTodayXLM + value > dailyXLMLimit {
            result.block("Daily XLM limit exceeded")
        }
        // Unverified-recipient cap (M10 parity): with no whitelist match, block anything
        // above the per-asset cap (fail closed) instead of merely warning, so the advertised
        // recipient-whitelist control actually protects users.
        if !recipientWhitelisted {
            if value > unverifiedXLMCap {
                result.block("No recipient whitelist is set, so a payment of \(amount) XLM to an "
                    + "unverified recipient is blocked (limit \(plainString(unverifiedXLMCap))). "
                    + "Send a smaller amount, or add the recipient to your whitelist.")
            } else {
                result.warn("No recipient whitelist is set; this recipient has not been verified.")
            }
        }
        return result
    }

    /// Parse a decimal amount string with a fixed POSIX locale so `.` is always the decimal
    /// separator, matching Android's `new BigDecimal(amount)`. The shape is validated with
    /// the same regex Android uses (`PaymentRequest.decimalString`) so partially-numeric or
    /// malformed input is rejected (fail closed) rather than silently truncated.
    static func parseAmount(_ raw: String) -> Decimal? {
        let trimmed = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        guard trimmed.range(of: "^(0|[1-9][0-9]*)(\\.[0-9]+)?$", options: .regularExpression) != nil else {
            return nil
        }
        // NSDecimalNumber(string:locale:) with a fixed POSIX locale always reads "." as the
        // decimal separator (a comma-decimal device locale would otherwise misparse "12.5").
        let value = NSDecimalNumber(string: trimmed, locale: Locale(identifier: "en_US_POSIX")).decimalValue
        return value.isNaN ? nil : value
    }

    /// Exact plain-string form (no scientific notation), for ledger persistence and messages.
    static func plainString(_ value: Decimal) -> String {
        NSDecimalNumber(decimal: value).stringValue
    }
}
