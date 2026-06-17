import Foundation

let paymentRequestProtocol = "velarum.payment_request.v1"

enum PaymentStatus: String, Codable {
    case pending
    case signed
    case broadcasted
    case confirmed
    case failed
    case expired
    case rejected
}

struct StellarWallet: Codable, Equatable {
    var seedBase64: String
    var publicKeyBase64: String
    var address: String

    var seed: Data {
        Data(base64Encoded: seedBase64) ?? Data()
    }

    var publicKey: Data {
        Data(base64Encoded: publicKeyBase64) ?? Data()
    }
}

struct PaymentRequest: Identifiable, Codable, Equatable {
    var protocolName: String
    var requestId: String
    var connectionId: String
    var transactionId: String
    var createdAtMs: Int64
    var expiresAtMs: Int64
    var idempotencyKey: String
    var status: String
    var source: PaymentRequestSource
    var payee: PayeeIdentity
    var payment: PaymentFacts
    var display: PaymentDisplay
    var policy: PaymentPolicy
    var transactionContextSnapshot: TransactionContextSnapshot?
    var context: TransactionContextSummary?
    var risk: PaymentRequestRisk
    var statusProjection: PaymentRequestStatusProjection?
    var history: [PaymentRequestHistory]
    var metadataJSONString: String
    var rawJSONString: String

    var id: String { requestId }

    var riskFindings: [RiskFinding] {
        dedupRiskFindings(
            risk.allFindings
                + (transactionContextSnapshot?.riskFindings ?? [])
                + (context?.warnings ?? [])
        )
    }

    var signingAllowed: Bool {
        let hasBlocker = riskFindings.contains { $0.isBlocker }
        let hasMissingContext = context?.status == "missing" || !(transactionContextSnapshot?.missingContext.isEmpty ?? true)
        if let allowed = statusProjection?.signingAllowed {
            return allowed && !hasBlocker && !hasMissingContext
        }
        return risk.signingAllowed && !hasBlocker && !hasMissingContext
    }

    static func parse(_ object: [String: Any]) throws -> PaymentRequest {
        let paymentObject = dictionary(object, "payment")
        let projectionFacts = dictionary(object, "payment_facts")
        let source = PaymentRequestSource.parse(dictionary(object, "source"))
        let payee = PayeeIdentity.parse(dictionary(object, "payee"))
        let risk = PaymentRequestRisk.parse(dictionary(object, "risk"))
        let contextObject = dictionary(object, "context")
        let statusProjectionObject = dictionary(object, "status_projection")
        let now = Int64(Date().timeIntervalSince1970 * 1000)
        let rawData = try JSONSerialization.data(withJSONObject: object, options: [.sortedKeys])
        let raw = String(data: rawData, encoding: .utf8) ?? "{}"

        return PaymentRequest(
            protocolName: string(object, "protocol", fallback: paymentRequestProtocol),
            requestId: firstNonEmpty(string(object, "request_id"), string(object, "id")),
            connectionId: string(object, "connection_id"),
            transactionId: string(object, "transaction_id"),
            createdAtMs: timeMs(object, "created_at", fallback: int64(object, "created_at_ms", fallback: now)),
            expiresAtMs: timeMs(object, "expires_at", fallback: int64(object, "expires_at_ms", fallback: now + 300_000)),
            idempotencyKey: string(object, "idempotency_key"),
            status: normalizePaymentStatus(string(object, "status", fallback: PaymentStatus.pending.rawValue)),
            source: source,
            payee: payee,
            payment: PaymentFacts.parse(paymentObject, projection: projectionFacts),
            display: PaymentDisplay.parse(dictionary(object, "display")),
            policy: PaymentPolicy.parse(dictionary(object, "policy")),
            transactionContextSnapshot: TransactionContextSnapshot.parseIfPresent(dictionary(object, "transaction_context_snapshot")),
            context: contextObject.isEmpty ? nil : TransactionContextSummary.parse(contextObject),
            risk: risk,
            statusProjection: statusProjectionObject.isEmpty ? nil : PaymentRequestStatusProjection.parse(statusProjectionObject),
            history: objectArray(object, "history").map(PaymentRequestHistory.parse),
            metadataJSONString: jsonString(dictionary(object, "metadata")),
            rawJSONString: raw
        )
    }
}

struct PaymentRequestSource: Codable, Equatable {
    var agentId: String
    var agentName: String
    var runtime: String
    var channel: String
    var deviceId: String

    var displayName: String {
        firstNonEmpty(agentName, deviceId, agentId, "Unknown agent")
    }

    static func parse(_ object: [String: Any]) -> PaymentRequestSource {
        PaymentRequestSource(
            agentId: string(object, "agent_id"),
            agentName: string(object, "agent_name"),
            runtime: string(object, "runtime"),
            channel: string(object, "channel"),
            deviceId: string(object, "device_id")
        )
    }
}

struct PayeeIdentity: Codable, Equatable {
    var name: String
    var domain: String
    var verified: Bool

    static func parse(_ object: [String: Any]) -> PayeeIdentity {
        PayeeIdentity(
            name: string(object, "name"),
            domain: string(object, "domain"),
            verified: bool(object, "verified")
        )
    }
}

struct PaymentFacts: Codable, Equatable {
    var rail: String
    var network: String
    var asset: String
    var assetIssuer: String
    var tokenContract: String
    var chainId: Int64
    var decimals: Int64
    var amount: String
    var to: String
    var memo: String
    var estimatedFee: String
    var total: String
    var rpcUrl: String
    var horizonUrl: String

    var isStellarXLM: Bool {
        rail == "stellar_xlm" && asset.uppercased() == "XLM"
    }

    var isBaseUSDC: Bool {
        rail == "base_usdc" && asset.uppercased() == "USDC"
    }

    static func parse(_ payment: [String: Any], projection: [String: Any] = [:]) -> PaymentFacts {
        let rail = firstNonEmpty(string(payment, "rail"), string(projection, "rail"))
        let asset = firstNonEmpty(string(payment, "asset"), string(projection, "token"), string(projection, "asset"))
        let network = firstNonEmpty(string(payment, "network"), string(projection, "network"))
        let amount = firstNonEmpty(string(payment, "amount"), string(projection, "amount"))
        let estimatedFee = firstNonEmpty(
            string(payment, "estimated_fee"),
            string(payment, "fee"),
            string(projection, "fee")
        )
        return PaymentFacts(
            rail: rail,
            network: network,
            asset: asset,
            assetIssuer: firstNonEmpty(
                string(payment, "asset_issuer"),
                string(payment, "issuer"),
                string(payment, "token_issuer")
            ),
            tokenContract: string(payment, "token_contract"),
            chainId: int64(payment, "chain_id"),
            decimals: int64(payment, "decimals"),
            amount: amount,
            to: firstNonEmpty(string(payment, "to"), string(projection, "recipient")),
            memo: string(payment, "memo"),
            estimatedFee: estimatedFee,
            total: firstNonEmpty(string(payment, "total"), string(projection, "total"), amount),
            rpcUrl: string(payment, "rpc_url"),
            horizonUrl: string(payment, "horizon_url")
        )
    }
}

struct PaymentDisplay: Codable, Equatable {
    var title: String
    var summary: String
    var primaryAction: String

    static func parse(_ object: [String: Any]) -> PaymentDisplay {
        PaymentDisplay(
            title: string(object, "title"),
            summary: string(object, "summary"),
            primaryAction: firstNonEmpty(string(object, "primary_action"), string(object, "button"))
        )
    }
}

struct PaymentPolicy: Codable, Equatable {
    var requiresUserApproval: Bool

    static func parse(_ object: [String: Any]) -> PaymentPolicy {
        PaymentPolicy(requiresUserApproval: bool(object, "requires_user_approval", fallback: true))
    }
}

struct TransactionContextSnapshot: Codable, Equatable {
    var transactionId: String
    var snapshotHash: String
    var truthFields: [TransactionTruthField]
    var evidence: [TransactionEvidence]
    var missingContext: [MissingContextItem]
    var riskFindings: [RiskFinding]

    static func parseIfPresent(_ object: [String: Any]) -> TransactionContextSnapshot? {
        guard !object.isEmpty else { return nil }
        return TransactionContextSnapshot(
            transactionId: string(object, "transaction_id"),
            snapshotHash: string(object, "snapshot_hash"),
            truthFields: objectArray(object, "truth_fields").map(TransactionTruthField.parse),
            evidence: objectArray(object, "evidence").map(TransactionEvidence.parse),
            missingContext: objectArray(object, "missing_context").map(MissingContextItem.parse),
            riskFindings: objectArray(object, "risk_findings").map { RiskFinding.parse($0, source: "transaction_context_snapshot") }
        )
    }
}

struct TransactionTruthField: Codable, Equatable {
    var field: String
    var value: String
    var currency: String
    var sourceType: String
    var verificationStatus: String
    var evidenceRef: String
    var confidence: String
    var observedAtMs: Int64
    var rawJSONString: String

    static func parse(_ object: [String: Any]) -> TransactionTruthField {
        TransactionTruthField(
            field: string(object, "field"),
            value: string(object, "value"),
            currency: string(object, "currency"),
            sourceType: string(object, "source_type"),
            verificationStatus: string(object, "verification_status"),
            evidenceRef: string(object, "evidence_ref"),
            confidence: string(object, "confidence"),
            observedAtMs: timeMs(object, "observed_at", fallback: 0),
            rawJSONString: jsonString(object)
        )
    }
}

struct TransactionEvidence: Codable, Equatable {
    var evidenceId: String
    var type: String
    var title: String
    var sourceUrl: String
    var capturedAtMs: Int64
    var hash: String
    var signatureVerified: Bool?
    var rawJSONString: String

    static func parse(_ object: [String: Any]) -> TransactionEvidence {
        let signature = dictionary(object, "signature")
        return TransactionEvidence(
            evidenceId: string(object, "evidence_id"),
            type: string(object, "type"),
            title: string(object, "title"),
            sourceUrl: string(object, "source_url"),
            capturedAtMs: timeMs(object, "captured_at", fallback: 0),
            hash: string(object, "hash"),
            signatureVerified: optionalBool(signature, "verified"),
            rawJSONString: jsonString(object)
        )
    }
}

struct MissingContextItem: Codable, Equatable {
    var field: String
    var reason: String
    var severity: String

    static func parse(_ object: [String: Any]) -> MissingContextItem {
        MissingContextItem(
            field: string(object, "field"),
            reason: string(object, "reason", fallback: string(object, "message")),
            severity: string(object, "severity", fallback: "warning")
        )
    }
}

struct RiskFinding: Codable, Equatable {
    var code: String
    var severity: String
    var field: String
    var message: String
    var source: String
    var detailsJSONString: String
    var rawJSONString: String

    var isBlocker: Bool {
        ["blocker", "danger", "error"].contains(severity.lowercased())
    }

    static func parse(_ object: [String: Any], defaultSeverity: String = "warning", source: String = "risk") -> RiskFinding {
        let code = firstNonEmpty(string(object, "code"), string(object, "type"))
        return RiskFinding(
            code: code,
            severity: string(object, "severity", fallback: defaultSeverity),
            field: string(object, "field"),
            message: firstNonEmpty(string(object, "message"), string(object, "reason"), string(object, "title"), code),
            source: source,
            detailsJSONString: jsonString(dictionary(object, "details")),
            rawJSONString: jsonString(object)
        )
    }
}

struct PaymentRequestRisk: Codable, Equatable {
    var level: String
    var reviewStatus: String
    var signingAllowed: Bool
    var errors: [RiskFinding]
    var warnings: [RiskFinding]
    var findings: [RiskFinding]

    var allFindings: [RiskFinding] {
        dedupRiskFindings(errors + warnings + findings)
    }

    static func parse(_ object: [String: Any]) -> PaymentRequestRisk {
        let errors = objectArray(object, "errors").map {
            RiskFinding.parse($0, defaultSeverity: "blocker", source: "risk.errors")
        }
        let warnings = objectArray(object, "warnings").map {
            RiskFinding.parse($0, defaultSeverity: "warning", source: "risk.warnings")
        }
        let findings = objectArray(object, "findings").map {
            RiskFinding.parse($0, source: "risk.findings")
        } + objectArray(object, "risk_findings").map {
            RiskFinding.parse($0, source: "risk.risk_findings")
        }
        let level = string(object, "level", fallback: errors.isEmpty ? (warnings.isEmpty ? "safe" : "caution") : "danger")
        let reviewStatus = string(object, "review_status", fallback: errors.isEmpty ? (warnings.isEmpty ? "ready" : "needs_review") : "blocked")
        let explicitSigningAllowed = optionalBool(object, "signing_allowed")
        return PaymentRequestRisk(
            level: level,
            reviewStatus: reviewStatus,
            signingAllowed: explicitSigningAllowed ?? (errors.isEmpty && reviewStatus != "missing_context"),
            errors: errors,
            warnings: warnings,
            findings: findings
        )
    }
}

struct TransactionContextSummary: Codable, Equatable {
    var status: String
    var transactionId: String
    var snapshotHash: String
    var hasSnapshot: Bool
    var warnings: [RiskFinding]

    static func parse(_ object: [String: Any]) -> TransactionContextSummary {
        TransactionContextSummary(
            status: string(object, "status", fallback: "missing"),
            transactionId: string(object, "transaction_id"),
            snapshotHash: string(object, "snapshot_hash"),
            hasSnapshot: bool(object, "has_snapshot"),
            warnings: objectArray(object, "warnings").map {
                RiskFinding.parse($0, defaultSeverity: "warning", source: "context.warnings")
            }
        )
    }
}

struct PaymentRequestStatusProjection: Codable, Equatable {
    var lifecycleStatus: String
    var reviewState: String
    var label: String
    var tone: String
    var group: String
    var inboxGroup: String
    var isFinal: Bool
    var requiresAttention: Bool
    var signingAllowed: Bool

    static func parse(_ object: [String: Any]) -> PaymentRequestStatusProjection {
        PaymentRequestStatusProjection(
            lifecycleStatus: string(object, "lifecycle_status", fallback: PaymentStatus.pending.rawValue),
            reviewState: string(object, "review_state", fallback: "pending"),
            label: string(object, "label"),
            tone: string(object, "tone"),
            group: string(object, "group"),
            inboxGroup: string(object, "inbox_group"),
            isFinal: bool(object, "is_final"),
            requiresAttention: bool(object, "requires_attention"),
            signingAllowed: bool(object, "signing_allowed")
        )
    }
}

struct PaymentRequestHistory: Codable, Equatable {
    var status: String
    var txHash: String
    var error: String
    var atMs: Int64

    static func parse(_ object: [String: Any]) -> PaymentRequestHistory {
        PaymentRequestHistory(
            status: string(object, "status"),
            txHash: string(object, "tx_hash"),
            error: string(object, "error"),
            atMs: timeMs(object, "at", fallback: int64(object, "at_ms"))
        )
    }
}

struct PaymentIntent: Identifiable, Codable, Equatable {
    var id: String
    var status: String
    var createdAtMs: Int64
    var expiresAtMs: Int64
    var rail: String
    var network: String
    var asset: String
    var assetIssuer: String
    var tokenContract: String
    var amount: String
    var to: String
    var memo: String
    var rpcUrl: String
    var horizonUrl: String
    var stellarTestnet: Bool
    var txHash: String
    var error: String
    var displayTitle: String
    var displaySummary: String
    var displayButton: String
    var sourceDeviceId: String
    var sourceChannel: String
    var orderId: String
    var restaurantName: String
    var restaurantCuisine: String
    var itemSummary: String
    var orderTotalUsd: String
    var rawJSONString: String
    var protocolName: String?
    var requestId: String?
    var connectionId: String?
    var transactionId: String?
    var payeeName: String?
    var payeeDomain: String?
    var payeeVerified: Bool?
    var reviewState: String?
    var statusLabel: String?
    var inboxGroup: String?
    var signingAllowed: Bool?
    var riskFindings: [RiskFinding]?
    var transactionContextSnapshot: TransactionContextSnapshot?
    var paymentRequest: PaymentRequest?

    var isPending: Bool {
        status == PaymentStatus.pending.rawValue && !isExpired
    }

    var isExpired: Bool {
        Date().timeIntervalSince1970 * 1000 > Double(expiresAtMs)
    }

    var isStellarXLM: Bool {
        rail == "stellar_xlm" && asset.uppercased() == "XLM"
    }

    var isBaseUSDC: Bool {
        rail == "base_usdc" && asset.uppercased() == "USDC"
    }

    var isStandardPaymentRequest: Bool {
        protocolName == paymentRequestProtocol || !(requestId ?? "").isEmpty
    }

    var canSign: Bool {
        isPending && (signingAllowed ?? !(riskFindings ?? []).contains { $0.isBlocker })
    }

    var isAmountHistory: Bool {
        status == PaymentStatus.broadcasted.rawValue || status == PaymentStatus.confirmed.rawValue
    }

    var title: String {
        if !displayTitle.isEmpty { return displayTitle }
        if isStellarXLM { return "Send \(amount) XLM" }
        return "Payment Request"
    }

    var summary: String {
        if !displaySummary.isEmpty { return displaySummary }
        if !itemSummary.isEmpty { return itemSummary }
        return "Requested by \(sourceDeviceId.isEmpty ? "OpenClaw" : sourceDeviceId) via \(sourceChannel.isEmpty ? "unknown" : sourceChannel)"
    }

    var payButtonTitle: String {
        displayButton.isEmpty ? "Pay" : displayButton
    }

    static func parse(_ object: [String: Any]) throws -> PaymentIntent {
        let isStandardRequest = string(object, "protocol") == paymentRequestProtocol || !string(object, "request_id").isEmpty
        let request = isStandardRequest ? try PaymentRequest.parse(object) : nil
        let payment = object["payment"] as? [String: Any] ?? [:]
        let source = object["source"] as? [String: Any] ?? [:]
        let display = object["display"] as? [String: Any] ?? [:]
        let metadata = object["metadata"] as? [String: Any] ?? [:]
        let velarum = object["velarum"] as? [String: Any] ?? [:]
        let payload = velarum["payload"] as? [String: Any] ?? [:]
        let foodOrder = metadata["food_order"] as? [String: Any] ?? [:]
        let order = (object["order"] as? [String: Any]) ?? (payload["order"] as? [String: Any]) ?? foodOrder
        let restaurant = order["restaurant"] as? [String: Any] ?? [:]
        let pricing = order["pricing"] as? [String: Any] ?? [:]
        let rawData = try JSONSerialization.data(withJSONObject: object, options: [.sortedKeys])
        let raw = String(data: rawData, encoding: .utf8) ?? "{}"
        let now = Int64(Date().timeIntervalSince1970 * 1000)
        let facts = request?.payment ?? PaymentFacts.parse(payment)
        let network = facts.network
        let stellarTestnet = bool(payment, "stellar_testnet") || network.lowercased().contains("test")
        return PaymentIntent(
            id: firstNonEmpty(request?.requestId ?? "", string(object, "intent_id"), string(object, "id")),
            status: normalizeStatus(request?.status ?? string(object, "status", fallback: PaymentStatus.pending.rawValue)),
            createdAtMs: request?.createdAtMs ?? timeMs(object, "created_at", fallback: int64(object, "created_at_ms", fallback: now)),
            expiresAtMs: request?.expiresAtMs ?? timeMs(object, "expires_at", fallback: int64(object, "expires_at_ms", fallback: now + 300_000)),
            rail: facts.rail,
            network: network,
            asset: facts.asset,
            assetIssuer: facts.assetIssuer,
            tokenContract: facts.tokenContract,
            amount: facts.amount,
            to: facts.to,
            memo: facts.memo,
            rpcUrl: facts.rpcUrl,
            horizonUrl: stellarHorizonUrl(facts.horizonUrl, testnet: stellarTestnet),
            stellarTestnet: stellarTestnet,
            txHash: string(object, "tx_hash"),
            error: string(object, "error"),
            displayTitle: firstNonEmpty(request?.display.title ?? "", string(display, "title")),
            displaySummary: firstNonEmpty(request?.display.summary ?? "", string(display, "summary")),
            displayButton: firstNonEmpty(request?.display.primaryAction ?? "", string(display, "button")),
            sourceDeviceId: firstNonEmpty(
                request?.source.displayName ?? "",
                string(source, "device_id"),
                string(source, "agent_name"),
                string(source, "agent_id")
            ),
            sourceChannel: string(source, "channel"),
            orderId: string(order, "id", fallback: string(order, "order_id")),
            restaurantName: string(restaurant, "name"),
            restaurantCuisine: string(restaurant, "cuisine"),
            itemSummary: string(order, "item_summary"),
            orderTotalUsd: firstNonEmpty(string(pricing, "total_usd"), string(pricing, "total")),
            rawJSONString: raw,
            protocolName: request?.protocolName,
            requestId: request?.requestId,
            connectionId: request?.connectionId,
            transactionId: request?.transactionId,
            payeeName: request?.payee.name,
            payeeDomain: request?.payee.domain,
            payeeVerified: request?.payee.verified,
            reviewState: request?.statusProjection?.reviewState ?? request?.risk.reviewStatus,
            statusLabel: request?.statusProjection?.label,
            inboxGroup: request?.statusProjection?.inboxGroup,
            signingAllowed: request?.signingAllowed,
            riskFindings: request?.riskFindings,
            transactionContextSnapshot: request?.transactionContextSnapshot,
            paymentRequest: request
        )
    }

    func updating(status: String, txHash: String? = nil, error: String? = nil) -> PaymentIntent {
        var copy = self
        copy.status = status
        if let txHash { copy.txHash = txHash }
        if let error { copy.error = error }
        return copy
    }

    private static func normalizeStatus(_ value: String) -> String {
        normalizePaymentStatus(value)
    }

    private static func stellarHorizonUrl(_ value: String, testnet: Bool) -> String {
        let clean = value.trimmingCharacters(in: .whitespacesAndNewlines).trimmingCharacters(in: CharacterSet(charactersIn: "/"))
        if !clean.isEmpty { return clean }
        return testnet ? "https://horizon-testnet.stellar.org" : "https://horizon.stellar.org"
    }
}

struct HistoryEntry: Identifiable, Codable, Equatable {
    var id: String
    var title: String
    var amount: String
    var asset: String
    var network: String
    var to: String
    var status: String
    var txHash: String
    var createdAtMs: Int64
}

struct PaymentProgress: Identifiable, Equatable {
    let id = UUID()
    var title: String
    var message: String
    var detail: String?
    var canDismiss: Bool
}

struct PairingSession: Identifiable, Codable, Equatable {
    var pairingSessionId: String
    var pairingCode: String
    var pairingUri: String
    var status: String
    var agentId: String
    var agentName: String
    var runtime: String
    var deviceLabel: String
    var source: String
    var expiresAtMs: Int64
    var requestedScopes: [String]
    var inputSource: String

    var id: String { pairingSessionId }

    var isPending: Bool {
        status == "pending"
    }

    var displayName: String {
        agentName.isEmpty ? "Unknown agent" : agentName
    }

    static func parse(_ object: [String: Any], inputSource: String) throws -> PairingSession {
        let agent = object["agent_identity"] as? [String: Any] ?? [:]
        return PairingSession(
            pairingSessionId: string(object, "pairing_session_id"),
            pairingCode: string(object, "pairing_code"),
            pairingUri: string(object, "pairing_uri"),
            status: string(object, "status", fallback: "pending").lowercased(),
            agentId: string(agent, "agent_id"),
            agentName: string(agent, "agent_name", fallback: "Unknown agent"),
            runtime: string(agent, "runtime", fallback: "unknown"),
            deviceLabel: string(agent, "device_label"),
            source: string(agent, "source"),
            expiresAtMs: timeMs(object, "expires_at", fallback: 0),
            requestedScopes: stringArray(object, "requested_scopes").filter { !isSigningScope($0) },
            inputSource: inputSource
        )
    }
}

struct AgentConnection: Identifiable, Codable, Equatable {
    var connectionId: String
    var connectionToken: String
    var pairingSessionId: String
    var agentId: String
    var agentName: String
    var runtime: String
    var deviceLabel: String
    var source: String
    var status: String
    var createdAtMs: Int64
    var updatedAtMs: Int64
    var lastActivityAtMs: Int64
    var expiresAtMs: Int64
    var scopes: [String]

    var id: String { connectionId }

    var displayName: String {
        agentName.isEmpty ? "Unknown agent" : agentName
    }

    var scopeSummary: String {
        scopes.isEmpty ? "No approved scopes" : scopes.joined(separator: " / ")
    }

    var isRevoked: Bool {
        status == "revoked"
    }

    static func parse(_ object: [String: Any]) throws -> AgentConnection {
        let agent = object["agent_identity"] as? [String: Any] ?? [:]
        let primaryScopes = stringArray(object, "scopes")
        let scopes = primaryScopes.isEmpty ? stringArray(object, "approved_scopes") : primaryScopes
        return AgentConnection(
            connectionId: string(object, "connection_id"),
            connectionToken: string(object, "connection_token"),
            pairingSessionId: string(object, "pairing_session_id"),
            agentId: string(agent, "agent_id"),
            agentName: string(agent, "agent_name", fallback: "Unknown agent"),
            runtime: string(agent, "runtime", fallback: "unknown"),
            deviceLabel: string(agent, "device_label"),
            source: string(agent, "source"),
            status: string(object, "status", fallback: "active").lowercased(),
            createdAtMs: timeMs(object, "created_at", fallback: 0),
            updatedAtMs: timeMs(object, "updated_at", fallback: 0),
            lastActivityAtMs: timeMs(object, "last_activity_at", fallback: 0),
            expiresAtMs: timeMs(object, "expires_at", fallback: 0),
            scopes: scopes.filter { !isSigningScope($0) }
        )
    }

    func preservingToken(from existing: AgentConnection?) -> AgentConnection {
        guard connectionToken.isEmpty, let existing, !existing.connectionToken.isEmpty else { return self }
        var copy = self
        copy.connectionToken = existing.connectionToken
        return copy
    }

    func updating(status: String) -> AgentConnection {
        var copy = self
        copy.status = status
        return copy
    }
}

func string(_ object: [String: Any], _ key: String, fallback: String = "") -> String {
    guard let value = object[key] else { return fallback }
    if let string = value as? String { return string }
    if value is NSNull { return fallback }
    return "\(value)"
}

func bool(_ object: [String: Any], _ key: String, fallback: Bool = false) -> Bool {
    guard let value = object[key] else { return fallback }
    if let bool = value as? Bool { return bool }
    if let string = value as? String { return ["true", "1", "yes"].contains(string.lowercased()) }
    if let number = value as? NSNumber { return number.boolValue }
    return fallback
}

func optionalBool(_ object: [String: Any], _ key: String) -> Bool? {
    guard let value = object[key], !(value is NSNull) else { return nil }
    if let bool = value as? Bool { return bool }
    if let string = value as? String {
        let clean = string.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        if ["true", "1", "yes"].contains(clean) { return true }
        if ["false", "0", "no"].contains(clean) { return false }
    }
    if let number = value as? NSNumber { return number.boolValue }
    return nil
}

func int64(_ object: [String: Any], _ key: String, fallback: Int64 = 0) -> Int64 {
    guard let value = object[key] else { return fallback }
    if let int = value as? Int64 { return int }
    if let int = value as? Int { return Int64(int) }
    if let double = value as? Double { return Int64(double) }
    if let string = value as? String, let parsed = Int64(string) { return parsed }
    return fallback
}

func timeMs(_ object: [String: Any], _ key: String, fallback: Int64) -> Int64 {
    let value = string(object, key)
    if value.isEmpty { return fallback }
    let formatter = ISO8601DateFormatter()
    formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
    if let date = formatter.date(from: value) {
        return Int64(date.timeIntervalSince1970 * 1000)
    }
    formatter.formatOptions = [.withInternetDateTime]
    if let date = formatter.date(from: value) {
        return Int64(date.timeIntervalSince1970 * 1000)
    }
    return fallback
}

func firstNonEmpty(_ values: String...) -> String {
    values.first { !$0.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty } ?? ""
}

func dictionary(_ object: [String: Any], _ key: String) -> [String: Any] {
    object[key] as? [String: Any] ?? [:]
}

func objectArray(_ object: [String: Any], _ key: String) -> [[String: Any]] {
    guard let value = object[key] else { return [] }
    if let array = value as? [[String: Any]] { return array }
    if let array = value as? [Any] {
        return array.compactMap { $0 as? [String: Any] }
    }
    return []
}

func jsonString(_ value: Any) -> String {
    guard JSONSerialization.isValidJSONObject(value),
          let data = try? JSONSerialization.data(withJSONObject: value, options: [.sortedKeys]),
          let raw = String(data: data, encoding: .utf8) else {
        return ""
    }
    return raw
}

func normalizePaymentStatus(_ value: String) -> String {
    let clean = value.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
    return clean.isEmpty ? PaymentStatus.pending.rawValue : clean
}

func dedupRiskFindings(_ findings: [RiskFinding]) -> [RiskFinding] {
    var seen = Set<String>()
    var output: [RiskFinding] = []
    for finding in findings {
        let key = [
            finding.code,
            finding.severity,
            finding.field,
            finding.message,
            finding.source
        ].joined(separator: "|")
        guard !seen.contains(key) else { continue }
        seen.insert(key)
        output.append(finding)
    }
    return output
}

func stringArray(_ object: [String: Any], _ key: String) -> [String] {
    guard let value = object[key] else { return [] }
    if let array = value as? [String] {
        return array.map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }.filter { !$0.isEmpty }
    }
    if let array = value as? [Any] {
        return array.compactMap { item in
            if let text = item as? String { return text.trimmingCharacters(in: .whitespacesAndNewlines) }
            if item is NSNull { return nil }
            return "\(item)"
        }.filter { !$0.isEmpty }
    }
    return []
}

func isSigningScope(_ scope: String) -> Bool {
    let value = scope.lowercased()
    return value.contains("sign") || value.contains("seed") || value.contains("private") || value.contains("keys")
}

func scopeDisplayName(_ scope: String) -> String {
    switch scope {
    case "payment.requests.create":
        return "Create Payment Requests"
    case "payment.requests.read":
        return "Read own request status"
    case "transaction_contexts.create":
        return "Create Transaction Context"
    case "transaction_contexts.read":
        return "Read own Transaction Context"
    case "wallet.addresses.read":
        return "Read approved address metadata"
    default:
        return scope
    }
}

func shortAddress(_ value: String) -> String {
    guard value.count > 18 else { return value }
    return "\(value.prefix(10))...\(value.suffix(8))"
}
