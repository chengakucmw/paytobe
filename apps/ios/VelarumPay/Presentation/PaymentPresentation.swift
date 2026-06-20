// Payment presentation logic (review state, risk copy, truth-panel builder, formatting)
// Extracted verbatim from ContentView.swift — behavior-preserving split (2026-06-20).

import SwiftUI
import CoreImage

#if canImport(UIKit)
import UIKit
#elseif canImport(AppKit)
import AppKit
#endif

#if canImport(AVFoundation)
import AVFoundation
#endif

extension PaymentIntent {
    var payeeDisplayName: String {
        firstNonEmpty(payeeName ?? "", restaurantName)
    }

    var sourceLabel: String {
        "Requested by \(sourceDeviceId.isEmpty ? "Agent" : sourceDeviceId) via \(sourceChannel.isEmpty ? "unknown" : sourceChannel)"
    }

    var estimatedFeeDisplay: String {
        guard let fee = paymentRequest?.payment.estimatedFee, !fee.isEmpty else { return "" }
        return asset.isEmpty ? fee : "\(fee) \(asset)"
    }

    var totalDisplay: String {
        let total = firstNonEmpty(paymentRequest?.payment.total ?? "", amount)
        return asset.isEmpty ? total : "\(total) \(asset)"
    }

    var transactionIdText: String {
        firstNonEmpty(transactionId ?? "", transactionContextSnapshot?.transactionId ?? "")
    }
}

func sortInboxIntents(_ left: PaymentIntent, _ right: PaymentIntent) -> Bool {
    let leftState = paymentReviewState(left)
    let rightState = paymentReviewState(right)
    let leftRank = inboxSortRank(leftState)
    let rightRank = inboxSortRank(rightState)
    if leftRank != rightRank { return leftRank < rightRank }
    if leftRank <= 4, left.expiresAtMs > 0, right.expiresAtMs > 0, left.expiresAtMs != right.expiresAtMs {
        return left.expiresAtMs < right.expiresAtMs
    }
    return left.createdAtMs > right.createdAtMs
}

func inboxSortRank(_ state: String) -> Int {
    switch normalizeReviewState(state) {
    case "blocked": return 0
    case "network_disabled": return 1
    case "missing_context": return 2
    case "source_review_required", "needs_review": return 3
    case "pending", "awaiting_signature": return 4
    case "failed": return 5
    case "broadcasting", "signed_locally": return 6
    default:
        return isFinalReviewState(state) ? 20 : 10
    }
}

func paymentReviewState(_ intent: PaymentIntent) -> String {
    let status = normalizeReviewState(intent.status)
    if intent.isExpired && !isFinalReviewState(status) && status != "failed" && status != "broadcasting" && status != "signed_locally" {
        return "expired"
    }
    if ["broadcasting", "signed_locally", "failed"].contains(status) || isFinalReviewState(status) {
        return status
    }
    let review = normalizeReviewState(intent.reviewState ?? "")
    if !review.isEmpty && !["ready", "pending", "awaiting_signature"].contains(review) {
        return review
    }
    if (intent.riskFindings ?? []).contains(where: \.isBlocker) { return "blocked" }
    if intent.paymentRequest?.risk.reviewStatus == "missing_context" || intent.paymentRequest?.context?.status == "missing" {
        return "missing_context"
    }
    if let snapshot = intent.transactionContextSnapshot, !snapshot.missingContext.isEmpty, intent.signingAllowed == false {
        return "missing_context"
    }
    return status.isEmpty ? "pending" : status
}

func normalizeReviewState(_ state: String) -> String {
    let value = state.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        .replacingOccurrences(of: "-", with: "_")
        .replacingOccurrences(of: " ", with: "_")
    switch value {
    case "pending_user_approval", "awaiting_user_signature":
        return "pending"
    case "broadcasted":
        return "broadcasting"
    case "signed":
        return "signed_locally"
    case "null":
        return ""
    default:
        return value
    }
}

func isActiveInboxState(_ state: String) -> Bool {
    [
        "pending",
        "awaiting_signature",
        "missing_context",
        "blocked",
        "network_disabled",
        "broadcasting",
        "failed",
        "needs_review",
        "source_review_required",
        "signed_locally"
    ].contains(normalizeReviewState(state))
}

func isFinalReviewState(_ state: String) -> Bool {
    ["confirmed", "rejected", "expired", "cancelled"].contains(normalizeReviewState(state))
}

func isPaymentDetailSignable(_ intent: PaymentIntent, state overrideState: String? = nil) -> Bool {
    let state = overrideState ?? paymentReviewState(intent)
    return intent.canSign && ["pending", "awaiting_signature", "needs_review", "source_review_required"].contains(state)
}

/// H-1: Stellar XLM is the only rail this build can sign, and exchange / custodial
/// XLM deposits almost always require a memo (a numeric tag) to be credited. A
/// payment that should carry a memo but doesn't is a silent fund-loss risk, so we
/// treat an empty memo on such a payment as a caution the user must explicitly
/// accept before signing. (We do not hard-block: legitimate person-to-person
/// transfers and new-account funding genuinely need no memo.)
func paymentExpectsMemo(_ intent: PaymentIntent) -> Bool {
    intent.isStellarXLM
}

func paymentMemoMissing(_ intent: PaymentIntent) -> Bool {
    guard isPaymentDetailSignable(intent), paymentExpectsMemo(intent) else { return false }
    return intent.memo.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
}

let paymentMissingMemoWarningMessage =
    "No memo / tag on this XLM payment. Exchange and custodial deposits usually require a memo — sending without one can lose the funds. Continue only if you are sure this recipient does not need a memo."

func paymentRequiresWarningStepUp(_ intent: PaymentIntent) -> Bool {
    guard isPaymentDetailSignable(intent) else { return false }
    // H-1: an XLM payment that should carry a memo but doesn't must force the
    // second-confirmation step-up before signing, so a missing exchange /
    // custodial deposit memo can never be skipped silently.
    if paymentMemoMissing(intent) { return true }
    let state = paymentReviewState(intent)
    if ["needs_review", "source_review_required"].contains(state) { return true }
    if paymentRiskTone(intent) == "caution" { return true }
    return paymentWarningMessages(intent).isEmpty == false
}

func paymentRiskLabel(_ intent: PaymentIntent) -> String {
    if let request = intent.paymentRequest {
        if request.risk.level == "danger" || request.risk.reviewStatus == "blocked" { return "Risk blocked" }
        if request.risk.level == "caution" || request.risk.reviewStatus != "ready" { return "Needs review" }
        return "Low risk"
    }
    if (intent.riskFindings ?? []).contains(where: \.isBlocker) { return "Risk blocked" }
    if !(intent.riskFindings ?? []).isEmpty { return "Needs review" }
    return "Local review"
}

func paymentRiskTone(_ intent: PaymentIntent) -> String {
    if (intent.riskFindings ?? []).contains(where: \.isBlocker) { return "danger" }
    if let level = intent.paymentRequest?.risk.level.lowercased(), ["danger", "caution", "safe"].contains(level) {
        return level == "danger" ? "danger" : level == "caution" ? "caution" : "safe"
    }
    if !(intent.riskFindings ?? []).isEmpty { return "caution" }
    return "info"
}

func paymentTone(_ state: String, canSign: Bool) -> String {
    let value = normalizeReviewState(state)
    if canSign && value == "pending" { return "safe" }
    if canSign { return "caution" }
    if value == "confirmed" { return "safe" }
    if ["broadcasting", "signed_locally", "expired", "cancelled"].contains(value) { return "info" }
    if value == WalletSecurityNavigationPolicy.backupRequiredReviewState { return "caution" }
    if ["missing_context", "needs_review", "source_review_required", "network_disabled"].contains(value) { return "caution" }
    return "danger"
}

func paymentStatusLabel(_ state: String) -> String {
    switch normalizeReviewState(state) {
    case WalletSecurityNavigationPolicy.backupRequiredReviewState: return "Backup required"
    case "missing_context": return "Missing context"
    case "blocked": return "Risk blocked"
    case "network_disabled": return "Network disabled"
    case "needs_review": return "Needs review"
    case "source_review_required": return "Source review"
    case "signed_locally": return "Signed locally"
    case "broadcasting": return "Broadcasting"
    case "failed": return "Failed"
    case "confirmed": return "Confirmed"
    case "rejected": return "Rejected"
    case "expired": return "Expired"
    case "cancelled": return "Cancelled"
    default: return "Awaiting signature"
    }
}

func paymentStateTitle(_ state: String, canSign: Bool) -> String {
    let value = normalizeReviewState(state)
    if canSign && value == "pending" { return "Ready to sign" }
    if canSign { return "Source review required" }
    if value == WalletSecurityNavigationPolicy.backupRequiredReviewState { return "Backup required before signing" }
    if ["missing_context", "needs_review", "source_review_required"].contains(value) { return "Context needs review" }
    if value == "blocked" { return "Blocked by risk policy" }
    if value == "network_disabled" { return "Network disabled" }
    if value == "broadcasting" { return "Broadcasting" }
    if value == "signed_locally" { return "Signed locally" }
    if value == "failed" { return "Broadcast failed" }
    if value == "confirmed" { return "Signed locally" }
    if value == "rejected" { return "Rejected" }
    if value == "expired" { return "Expired" }
    return "Not signable"
}

func paymentStateCopy(_ intent: PaymentIntent, state: String, canSign: Bool) -> String {
    let value = normalizeReviewState(state)
    if canSign && value == "pending" {
        return "Payment facts and local risk checks are ready. You can reject the request or continue to local signing on this device."
    }
    if canSign {
        return "Warnings remain. Review the source groups and accept the unverified context before signing."
    }
    if value == WalletSecurityNavigationPolicy.backupRequiredReviewState {
        return WalletSecurityNavigationPolicy.backupGateCopy
    }
    if value == "missing_context" {
        return "Required transaction context or evidence is missing. Payment facts remain visible, but signing is unavailable until the agent repairs the context."
    }
    if ["needs_review", "source_review_required"].contains(value) {
        return "Critical context needs review before signing can resume. Request more context or reject the request."
    }
    if value == "blocked" {
        return "A blocking risk rule prevents this request from being signed."
    }
    if value == "network_disabled" {
        return "This request targets a network that is not enabled or verified in the wallet."
    }
    if value == "broadcasting" {
        return "A local signature exists and the transaction has been submitted. Do not sign again."
    }
    if value == "signed_locally" {
        return "The transaction was signed on this device. Continue tracking it from activity instead of signing again."
    }
    if value == "failed" {
        return "The request was signed, but broadcast failed. Retry only after re-checking fee, recipient, and prior transaction state."
    }
    if value == "confirmed" {
        return "The request is final and already recorded. No new signature is allowed."
    }
    if value == "rejected" {
        return "You rejected this Payment Request. Nothing was signed."
    }
    if value == "expired" {
        return "The approval window is closed. Ask the agent to create a new request if payment is still needed."
    }
    return paymentBlockedReason(intent)
}

func paymentRiskMessages(_ intent: PaymentIntent) -> [String] {
    let findings = intent.riskFindings ?? []
    var messages = findings.map { finding in
        let prefix = finding.isBlocker ? "Blocked" : "Warning"
        return "\(prefix): \(valueOr(finding.message, finding.code))"
    }
    if paymentMemoMissing(intent) {
        messages.append("Warning: \(paymentMissingMemoWarningMessage)")
    }
    if paymentReviewState(intent) == "missing_context", messages.isEmpty {
        messages.append("Warning: Transaction context or evidence was not received.")
    }
    return Array(Set(messages)).sorted()
}

func paymentWarningMessages(_ intent: PaymentIntent) -> [String] {
    var warnings = (intent.riskFindings ?? [])
        .filter { !$0.isBlocker }
        .map { valueOr($0.message, $0.code) }
    if paymentMemoMissing(intent) {
        warnings.append(paymentMissingMemoWarningMessage)
    }
    if warnings.isEmpty && paymentRequiresWarningStepUpWithoutMessages(intent) {
        return ["Some claims come from AI, observed pages, or incomplete evidence. They are not verified payment facts."]
    }
    return Array(Set(warnings)).sorted()
}

private func paymentRequiresWarningStepUpWithoutMessages(_ intent: PaymentIntent) -> Bool {
    let state = paymentReviewState(intent)
    return isPaymentDetailSignable(intent) && (["needs_review", "source_review_required"].contains(state) || paymentRiskTone(intent) == "caution")
}

func paymentBlockedReason(_ intent: PaymentIntent) -> String {
    let state = paymentReviewState(intent)
    if let blocker = (intent.riskFindings ?? []).first(where: \.isBlocker) {
        return valueOr(blocker.message, blocker.code)
    }
    if intent.isExpired || state == "expired" { return "Payment request expired." }
    if isFinalReviewState(state) { return "This request is final and cannot be signed." }
    if state == "missing_context" { return "Transaction context is missing or incomplete." }
    if state == "failed" { return "Failed requests must be reviewed before retry." }
    if !intent.isPending { return "Payment request is already \(intent.status)." }
    if intent.signingAllowed == false { return "Signing is disabled by the request risk policy." }
    return "This request is not signable."
}

func paymentContextLabel(_ intent: PaymentIntent, state: String) -> String {
    if state == "missing_context" { return "Missing" }
    if intent.transactionContextSnapshot != nil { return "Ready" }
    if !(intent.transactionId ?? "").isEmpty { return "Context ref" }
    return intent.isStandardPaymentRequest ? "Not received" : "Legacy"
}

func paymentWindowText(_ intent: PaymentIntent, state: String) -> String {
    if state == "expired" { return "Expired" }
    if isFinalReviewState(state) { return "Final" }
    // L-5: a request with no server expiry never auto-expires (matches Android).
    if !intent.hasExpiry { return "No expiry" }
    if intent.expiresAtMs > Int64(Date().timeIntervalSince1970 * 1000) {
        return "Expires \(dateText(intent.expiresAtMs))"
    }
    return "Expired"
}

func truthPanelSections(for intent: PaymentIntent) -> [TruthPanelSection] {
    var verified = [
        TruthPanelRow(
            field: "Payment amount",
            value: "\(valueOr(intent.amount, "0")) \(valueOr(intent.asset, ""))",
            source: "Payment fact",
            status: "Payment request fact",
            evidence: "Parsed from Payment Request",
            tone: "safe"
        ),
        TruthPanelRow(
            field: "Network and asset",
            value: "\(valueOr(intent.network, "Unknown network")) / \(valueOr(intent.asset, "Unknown asset"))",
            source: "Payment fact",
            status: "Payment request fact",
            evidence: "Hard fields shown before signing",
            tone: "safe"
        )
    ]
    if !intent.to.isEmpty {
        verified.append(
            TruthPanelRow(
                field: "Recipient address",
                value: shortAddress(intent.to),
                source: "Payment fact",
                status: intent.payeeVerified == true ? "Address verified" : "Payment request fact",
                evidence: "On-chain recipient remains visible before signing",
                tone: intent.payeeVerified == true ? "safe" : "info"
            )
        )
    }

    var merchantClaims: [TruthPanelRow] = []
    var merchantAI: [TruthPanelRow] = []
    var userAI: [TruthPanelRow] = []
    var missing: [TruthPanelRow] = []
    let snapshot = intent.transactionContextSnapshot
    var evidenceById: [String: String] = [:]
    for item in snapshot?.evidence ?? [] {
        if !item.evidenceId.isEmpty { evidenceById[item.evidenceId] = item.title }
        if !item.type.isEmpty, evidenceById[item.type] == nil { evidenceById[item.type] = item.title }
    }

    for field in snapshot?.truthFields ?? [] {
        let row = truthRow(from: field, evidenceById: evidenceById)
        switch truthBucket(for: field, row: row) {
        case "missing":
            missing.append(row)
        case "merchant_ai":
            merchantAI.append(row)
        case "user_ai":
            userAI.append(row)
        case "merchant_claims":
            merchantClaims.append(row)
        default:
            verified.append(row)
        }
    }

    for item in snapshot?.missingContext ?? [] {
        missing.append(
            TruthPanelRow(
                field: valueOr(item.field, "Missing context"),
                value: "Unavailable",
                source: "Missing",
                status: statusLabel("missing"),
                evidence: valueOr(item.reason, "Required context or evidence did not arrive."),
                tone: toneForSeverity(item.severity, fallback: "caution")
            )
        )
    }

    for finding in intent.riskFindings ?? [] {
        missing.append(
            TruthPanelRow(
                field: valueOr(finding.field, labelForRiskCode(finding.code)),
                value: finding.isBlocker ? "Blocked" : "Needs review",
                source: "Risk policy",
                status: finding.isBlocker ? "Blocked" : "Needs review",
                evidence: valueOr(finding.message, copyForRiskCode(finding.code)),
                tone: finding.isBlocker ? "danger" : "caution"
            )
        )
    }

    if snapshot == nil && intent.isStandardPaymentRequest {
        missing.append(
            TruthPanelRow(
                field: "Transaction Context",
                value: "Not received",
                source: "Missing",
                status: "Missing",
                evidence: "Payment Facts remain visible, but transaction context evidence was not received.",
                tone: intent.signingAllowed == false ? "danger" : "caution"
            )
        )
    }

    return [
        truthSection(title: "Verified facts", note: "payment and verified proof", fallbackTone: "safe", rows: verified),
        truthSection(title: "Merchant claims", note: "website or API statements", fallbackTone: "info", rows: merchantClaims),
        truthSection(title: "Merchant AI claims", note: "not signed terms", fallbackTone: "caution", rows: merchantAI),
        truthSection(title: "Your AI interpretation", note: "agent reasoning only", fallbackTone: "info", rows: userAI),
        truthSection(title: "Missing or risky", note: "needs correction or acceptance", fallbackTone: "caution", rows: missing)
    ].compactMap { $0 }
}

func truthSection(title: String, note: String, fallbackTone: String, rows: [TruthPanelRow]) -> TruthPanelSection? {
    guard !rows.isEmpty else { return nil }
    return TruthPanelSection(title: title, note: note, tone: worstTone(rows.map(\.tone), fallback: fallbackTone), rows: rows)
}

func truthRow(from field: TransactionTruthField, evidenceById: [String: String]) -> TruthPanelRow {
    let source = sourceLabel(field.sourceType)
    let status = statusLabel(field.verificationStatus)
    let evidence = firstNonEmpty(
        evidenceById[field.evidenceRef] ?? "",
        field.evidenceRef,
        defaultEvidenceCopy(sourceType: field.sourceType, verificationStatus: field.verificationStatus)
    )
    return TruthPanelRow(
        field: valueOr(field.field, "Context field"),
        value: truthValue(field),
        source: source,
        status: status,
        evidence: evidence,
        tone: truthTone(sourceType: field.sourceType, verificationStatus: field.verificationStatus)
    )
}

func truthBucket(for field: TransactionTruthField, row: TruthPanelRow) -> String {
    if ["missing", "conflicted"].contains(field.verificationStatus) || field.sourceType == "unknown" || row.tone == "danger" {
        return "missing"
    }
    if field.sourceType == "merchant_ai_claim" || field.verificationStatus == "ai_claim_only" {
        return "merchant_ai"
    }
    if field.sourceType == "user_agent_inferred" || field.verificationStatus == "inferred_only" {
        return "user_ai"
    }
    if isStrongVerification(field.verificationStatus) || field.sourceType == "payment_request_fact" || field.sourceType == "wallet_derived" || field.sourceType == "platform_verified" {
        return "verified"
    }
    if ["merchant_web_observed", "merchant_api_response", "merchant_signed_quote"].contains(field.sourceType) {
        return "merchant_claims"
    }
    return row.tone == "caution" ? "missing" : "verified"
}

func truthValue(_ field: TransactionTruthField) -> String {
    let value = valueOr(field.value, "Unavailable")
    guard !field.currency.isEmpty, !value.contains(field.currency) else { return value }
    return "\(value) \(field.currency)"
}

func truthTone(sourceType: String, verificationStatus: String) -> String {
    if ["conflicted", "missing"].contains(verificationStatus) { return "danger" }
    if sourceType == "merchant_ai_claim" || verificationStatus == "ai_claim_only" ||
        sourceType == "user_agent_inferred" || verificationStatus == "inferred_only" ||
        verificationStatus == "observed_only" || verificationStatus == "unverified" ||
        sourceType == "unknown" {
        return "caution"
    }
    if isStrongVerification(verificationStatus) || sourceType == "payment_request_fact" || sourceType == "wallet_derived" {
        return "safe"
    }
    return "info"
}

func isStrongVerification(_ value: String) -> Bool {
    [
        "signature_verified",
        "domain_verified",
        "address_verified",
        "api_authenticated",
        "payment_request_fact",
        "wallet_derived"
    ].contains(value)
}

func sourceLabel(_ value: String) -> String {
    switch value {
    case "payment_request_fact": return "Payment fact"
    case "wallet_derived": return "Wallet derived"
    case "user_provided": return "You provided"
    case "user_agent_inferred": return "Your AI inferred"
    case "merchant_web_observed": return "Website observed"
    case "merchant_ai_claim": return "Merchant AI said"
    case "merchant_api_response": return "Merchant API"
    case "merchant_signed_quote": return "Signed quote"
    case "platform_verified": return "Velarum verified"
    case "external_verified": return "Third-party verified"
    case "unknown": return "Unknown source"
    case "missing": return "Missing"
    default: return titleize(value, fallback: "Unknown source")
    }
}

func statusLabel(_ value: String) -> String {
    switch value {
    case "signature_verified": return "Signature verified"
    case "domain_verified": return "Domain verified"
    case "address_verified": return "Address verified"
    case "api_authenticated": return "API authenticated"
    case "observed_only": return "Observed only"
    case "ai_claim_only": return "AI claim only"
    case "inferred_only": return "Inferred only"
    case "conflicted": return "Conflicted"
    case "missing": return "Missing"
    case "unverified": return "Unverified"
    case "payment_request_fact": return "Payment request fact"
    case "wallet_derived": return "Wallet derived"
    default: return titleize(value, fallback: "Unverified")
    }
}

func labelForRiskCode(_ code: String) -> String {
    if code.contains("amount") { return "Amount match" }
    if code.contains("payee") || code.contains("recipient") { return "Payee match" }
    if code.contains("asset") { return "Asset match" }
    if code.contains("network") { return "Network match" }
    if code.contains("missing") { return "Transaction Context" }
    if code.contains("ai") { return "AI-only critical field" }
    return titleize(code, fallback: "Risk finding")
}

func copyForRiskCode(_ code: String) -> String {
    if code.contains("amount") { return "Payment amount conflicts with transaction context." }
    if code.contains("payee") || code.contains("recipient") { return "Payee or recipient evidence conflicts with the Payment Request." }
    if code.contains("asset") { return "Asset evidence conflicts with the Payment Request." }
    if code.contains("network") { return "Network evidence conflicts with the Payment Request." }
    if code.contains("missing") { return "Required transaction context or evidence was not received." }
    if code.contains("ai") { return "A critical field only comes from AI or observed text, so it cannot be treated as verified." }
    return "Review this source before signing."
}

func defaultEvidenceCopy(sourceType: String, verificationStatus: String) -> String {
    if sourceType == "merchant_ai_claim" || verificationStatus == "ai_claim_only" {
        return "No signed terms or verified evidence attached."
    }
    if sourceType == "user_agent_inferred" || verificationStatus == "inferred_only" {
        return "Agent reasoning only; it does not prove merchant identity or payment terms."
    }
    if verificationStatus == "observed_only" {
        return "Observed source only; not verified by signed quote."
    }
    if verificationStatus == "missing" {
        return "Required evidence did not arrive."
    }
    return "Evidence reference was not attached."
}

func toneForSeverity(_ severity: String, fallback: String) -> String {
    let value = severity.lowercased()
    if value.contains("block") || value.contains("error") || value.contains("danger") { return "danger" }
    if value.contains("warn") || value.contains("review") || value.contains("caution") { return "caution" }
    return fallback
}

func worstTone(_ tones: [String], fallback: String) -> String {
    if tones.contains("danger") { return "danger" }
    if tones.contains("caution") { return "caution" }
    if tones.contains("info") { return "info" }
    return fallback
}

func truthToneLabel(_ tone: String) -> String {
    switch tone {
    case "danger": return "Blocked"
    case "caution": return "Review"
    case "safe": return "Verified"
    default: return "Info"
    }
}

func toneColor(_ tone: String) -> Color {
    switch tone {
    case "safe", "success": return .green
    case "caution", "warning": return .orange
    case "danger": return .red
    default: return .blue
    }
}

func toneBackground(_ tone: String) -> Color {
    toneColor(tone).opacity(0.12)
}

func titleize(_ value: String, fallback: String) -> String {
    let clean = value.replacingOccurrences(of: "_", with: " ").replacingOccurrences(of: "-", with: " ").trimmingCharacters(in: .whitespacesAndNewlines)
    guard let first = clean.first else { return fallback }
    return String(first).uppercased() + clean.dropFirst()
}

func valueOr(_ value: String, _ fallback: String) -> String {
    let clean = value.trimmingCharacters(in: .whitespacesAndNewlines)
    return clean.isEmpty || clean.lowercased() == "null" ? fallback : clean
}

func dateText(_ timestampMs: Int64) -> String {
    guard timestampMs > 0 else { return "Not available" }
    let date = Date(timeIntervalSince1970: Double(timestampMs) / 1000)
    return date.formatted(date: .abbreviated, time: .shortened)
}

func challengePositions(for wordCount: Int) -> [Int] {
    let preferred = [2, 6, 10, 14, 18, 22]
    let filtered = preferred.filter { $0 < wordCount }
    if !filtered.isEmpty { return filtered }
    return Array(0..<min(3, wordCount))
}

