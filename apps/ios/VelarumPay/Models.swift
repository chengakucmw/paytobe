import Foundation

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

    var isPending: Bool {
        status == PaymentStatus.pending.rawValue && !isExpired
    }

    var isExpired: Bool {
        Date().timeIntervalSince1970 * 1000 > Double(expiresAtMs)
    }

    var isStellarXLM: Bool {
        rail == "stellar_xlm" && asset.uppercased() == "XLM"
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
        let payment = object["payment"] as? [String: Any] ?? [:]
        let source = object["source"] as? [String: Any] ?? [:]
        let display = object["display"] as? [String: Any] ?? [:]
        let velarum = object["velarum"] as? [String: Any] ?? [:]
        let payload = velarum["payload"] as? [String: Any] ?? [:]
        let order = (object["order"] as? [String: Any]) ?? (payload["order"] as? [String: Any]) ?? [:]
        let restaurant = order["restaurant"] as? [String: Any] ?? [:]
        let pricing = order["pricing"] as? [String: Any] ?? [:]
        let rawData = try JSONSerialization.data(withJSONObject: object, options: [.sortedKeys])
        let raw = String(data: rawData, encoding: .utf8) ?? "{}"
        let now = Int64(Date().timeIntervalSince1970 * 1000)
        let network = string(payment, "network")
        let stellarTestnet = bool(payment, "stellar_testnet") || network.lowercased().contains("test")
        return PaymentIntent(
            id: string(object, "intent_id", fallback: string(object, "id")),
            status: normalizeStatus(string(object, "status", fallback: PaymentStatus.pending.rawValue)),
            createdAtMs: timeMs(object, "created_at", fallback: int64(object, "created_at_ms", fallback: now)),
            expiresAtMs: timeMs(object, "expires_at", fallback: int64(object, "expires_at_ms", fallback: now + 300_000)),
            rail: string(payment, "rail"),
            network: network,
            asset: string(payment, "asset"),
            assetIssuer: firstNonEmpty(
                string(payment, "asset_issuer"),
                string(payment, "issuer"),
                string(payment, "token_issuer")
            ),
            tokenContract: string(payment, "token_contract"),
            amount: string(payment, "amount"),
            to: string(payment, "to"),
            memo: string(payment, "memo"),
            rpcUrl: string(payment, "rpc_url"),
            horizonUrl: stellarHorizonUrl(string(payment, "horizon_url"), testnet: stellarTestnet),
            stellarTestnet: stellarTestnet,
            txHash: string(object, "tx_hash"),
            error: string(object, "error"),
            displayTitle: string(display, "title"),
            displaySummary: string(display, "summary"),
            displayButton: string(display, "button"),
            sourceDeviceId: string(source, "device_id"),
            sourceChannel: string(source, "channel"),
            orderId: string(order, "id", fallback: string(order, "order_id")),
            restaurantName: string(restaurant, "name"),
            restaurantCuisine: string(restaurant, "cuisine"),
            itemSummary: string(order, "item_summary"),
            orderTotalUsd: string(pricing, "total_usd"),
            rawJSONString: raw
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
        let clean = value.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        return clean.isEmpty ? PaymentStatus.pending.rawValue : clean
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
