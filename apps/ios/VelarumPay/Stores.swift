import Foundation
import Security

enum AppError: LocalizedError {
    case missingWallet
    case unsupportedPayment(String)
    case invalidResponse(String)
    case keychain(OSStatus)

    var errorDescription: String? {
        switch self {
        case .missingWallet:
            return "Generate a wallet first."
        case .unsupportedPayment(let message):
            return message
        case .invalidResponse(let message):
            return message
        case .keychain(let status):
            return "Keychain error \(status)."
        }
    }
}

final class KeychainStore {
    static let shared = KeychainStore()
    private init() {}

    func save(_ data: Data, service: String, account: String) throws {
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account
        ]
        let attributes: [String: Any] = [
            kSecValueData as String: data,
            kSecAttrAccessible as String: kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
        ]
        let status = SecItemUpdate(query as CFDictionary, attributes as CFDictionary)
        if status == errSecSuccess { return }
        if status != errSecItemNotFound { throw AppError.keychain(status) }
        var item = query
        item.merge(attributes) { _, new in new }
        let addStatus = SecItemAdd(item as CFDictionary, nil)
        if addStatus != errSecSuccess { throw AppError.keychain(addStatus) }
    }

    func load(service: String, account: String) throws -> Data? {
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
            kSecReturnData as String: true,
            kSecMatchLimit as String: kSecMatchLimitOne
        ]
        var result: AnyObject?
        let status = SecItemCopyMatching(query as CFDictionary, &result)
        if status == errSecItemNotFound { return nil }
        if status != errSecSuccess { throw AppError.keychain(status) }
        return result as? Data
    }

    func delete(service: String, account: String) throws {
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account
        ]
        let status = SecItemDelete(query as CFDictionary)
        if status != errSecSuccess && status != errSecItemNotFound {
            throw AppError.keychain(status)
        }
    }
}

final class WalletStore {
    private let service = "com.velarum.wallet.ios"
    private let account = "stellar-wallet-v1"

    func load() throws -> StellarWallet? {
        guard let data = try KeychainStore.shared.load(service: service, account: account) else { return nil }
        return try JSONDecoder().decode(StellarWallet.self, from: data)
    }

    func save(_ wallet: StellarWallet) throws {
        let data = try JSONEncoder().encode(wallet)
        try KeychainStore.shared.save(data, service: service, account: account)
    }

    func clear() throws {
        try KeychainStore.shared.delete(service: service, account: account)
    }
}

final class LocalStore {
    private let defaults = UserDefaults.standard
    private let inboxKey = "VelarumPay.ios.inbox"
    private let historyKey = "VelarumPay.ios.history"
    private let connectionsKey = "VelarumPay.ios.agent-connections"
    private let relayURLKey = "VelarumPay.ios.relay-url"
    private let deviceIdKey = "VelarumPay.ios.device-id"
    private let deviceTokenKey = "VelarumPay.ios.device-token"

    var relayURL: String {
        get { defaults.string(forKey: relayURLKey) ?? "https://relay-agentfood.velarumai.com" }
        set { defaults.set(newValue.trimmingCharacters(in: .whitespacesAndNewlines), forKey: relayURLKey) }
    }

    var deviceId: String {
        if let existing = defaults.string(forKey: deviceIdKey), !existing.isEmpty { return existing }
        let generated = "ios-\(UUID().uuidString.lowercased())"
        defaults.set(generated, forKey: deviceIdKey)
        return generated
    }

    var deviceToken: String {
        if let existing = defaults.string(forKey: deviceTokenKey), !existing.isEmpty { return existing }
        let generated = "awt_\(UUID().uuidString.replacingOccurrences(of: "-", with: "").lowercased())"
        defaults.set(generated, forKey: deviceTokenKey)
        return generated
    }

    func loadInbox() -> [PaymentIntent] {
        guard let data = defaults.data(forKey: inboxKey) else { return [] }
        return (try? JSONDecoder().decode([PaymentIntent].self, from: data)) ?? []
    }

    func saveInbox(_ items: [PaymentIntent]) {
        guard let data = try? JSONEncoder().encode(items.sorted { $0.createdAtMs > $1.createdAtMs }) else { return }
        defaults.set(data, forKey: inboxKey)
    }

    func upsertIntent(_ intent: PaymentIntent) {
        var items = loadInbox()
        if let index = items.firstIndex(where: { $0.id == intent.id }) {
            items[index] = intent
        } else {
            items.append(intent)
        }
        saveInbox(items)
    }

    func updateIntent(id: String, status: String, txHash: String?, error: String?) {
        let updated = loadInbox().map { item in
            item.id == id ? item.updating(status: status, txHash: txHash, error: error) : item
        }
        saveInbox(updated)
    }

    func loadHistory() -> [HistoryEntry] {
        guard let data = defaults.data(forKey: historyKey) else { return [] }
        return (try? JSONDecoder().decode([HistoryEntry].self, from: data)) ?? []
    }

    func recordHistory(_ entry: HistoryEntry) {
        var items = loadHistory()
        if let index = items.firstIndex(where: { $0.id == entry.id }) {
            items[index] = entry
        } else {
            items.append(entry)
        }
        guard let data = try? JSONEncoder().encode(items.sorted { $0.createdAtMs > $1.createdAtMs }) else { return }
        defaults.set(data, forKey: historyKey)
    }

    func loadConnections() -> [AgentConnection] {
        guard let data = defaults.data(forKey: connectionsKey) else { return [] }
        return (try? JSONDecoder().decode([AgentConnection].self, from: data)) ?? []
    }

    func saveConnections(_ items: [AgentConnection]) {
        guard let data = try? JSONEncoder().encode(items.sorted { $0.updatedAtMs > $1.updatedAtMs }) else { return }
        defaults.set(data, forKey: connectionsKey)
    }

    func upsertConnection(_ connection: AgentConnection) {
        var items = loadConnections()
        if let index = items.firstIndex(where: { $0.connectionId == connection.connectionId }) {
            items[index] = connection.preservingToken(from: items[index])
        } else {
            items.append(connection)
        }
        saveConnections(items)
    }

    func updateConnection(id: String, status: String) {
        saveConnections(loadConnections().map { $0.connectionId == id ? $0.updating(status: status) : $0 })
    }
}
