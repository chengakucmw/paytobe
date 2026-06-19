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
    private let networksKey = "VelarumPay.ios.wallet-networks"
    private let relayURLKey = "VelarumPay.ios.relay-url"
    private let deviceIdKey = "VelarumPay.ios.device-id"
    private let deviceTokenKey = "VelarumPay.ios.device-token"
    // L-4: Keychain service holding bearer credentials (device + connection tokens),
    // so they are no longer persisted as plaintext in UserDefaults.
    private let secretService = "com.velarum.wallet.ios.secrets"

    var relayURL: String {
        get { defaults.string(forKey: relayURLKey) ?? "" }
        set { defaults.set(newValue.trimmingCharacters(in: .whitespacesAndNewlines), forKey: relayURLKey) }
    }

    var deviceId: String {
        if let existing = defaults.string(forKey: deviceIdKey), !existing.isEmpty { return existing }
        let generated = "ios-\(UUID().uuidString.lowercased())"
        defaults.set(generated, forKey: deviceIdKey)
        return generated
    }

    // L-4: the device/connection bearer token now lives in the Keychain. Any legacy
    // plaintext copy in UserDefaults is migrated once and then removed.
    var deviceToken: String {
        if let data = keychainData(deviceTokenKey), let token = String(data: data, encoding: .utf8), !token.isEmpty {
            return token
        }
        if let legacy = defaults.string(forKey: deviceTokenKey), !legacy.isEmpty {
            if setKeychainData(Data(legacy.utf8), account: deviceTokenKey) {
                defaults.removeObject(forKey: deviceTokenKey)
            }
            return legacy
        }
        let generated = "awt_\(UUID().uuidString.replacingOccurrences(of: "-", with: "").lowercased())"
        setKeychainData(Data(generated.utf8), account: deviceTokenKey)
        return generated
    }

    private func keychainData(_ account: String) -> Data? {
        try? KeychainStore.shared.load(service: secretService, account: account)
    }

    @discardableResult
    private func setKeychainData(_ data: Data, account: String) -> Bool {
        do {
            try KeychainStore.shared.save(data, service: secretService, account: account)
            return true
        } catch {
            return false
        }
    }

    // Returns the Keychain copy, migrating a legacy plaintext UserDefaults blob on first use.
    private func secretData(account: String, legacyKey: String) -> Data? {
        if let data = keychainData(account) { return data }
        guard let legacy = defaults.data(forKey: legacyKey) else { return nil }
        if setKeychainData(legacy, account: account) {
            defaults.removeObject(forKey: legacyKey)
        }
        return legacy
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
            let existing = items[index]
            var merged = intent

            // H12 fix: never let a stale relay snapshot downgrade a locally-advanced
            // status.  E.g. local `broadcasted` must not revert to a relay-lagging
            // `pending`, which would make the payment appear actionable again and risk
            // a duplicate payment.
            if PaymentStatus.lifecycleRank(existing.status) > PaymentStatus.lifecycleRank(intent.status) {
                merged.status = existing.status
            }

            // Preserve a non-empty txHash even when the relay hasn't caught up yet,
            // so the local transaction record is never lost.
            if !existing.txHash.isEmpty && merged.txHash.isEmpty {
                merged.txHash = existing.txHash
            }

            items[index] = merged
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

    // L-4: agent-connection tokens are bearer credentials, so the connections blob is
    // stored in the Keychain (with a one-time migration from legacy UserDefaults).
    func loadConnections() -> [AgentConnection] {
        guard let data = secretData(account: connectionsKey, legacyKey: connectionsKey) else { return [] }
        return (try? JSONDecoder().decode([AgentConnection].self, from: data)) ?? []
    }

    func saveConnections(_ items: [AgentConnection]) {
        guard let data = try? JSONEncoder().encode(items.sorted { $0.updatedAtMs > $1.updatedAtMs }) else { return }
        setKeychainData(data, account: connectionsKey)
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

    func loadUserNetworks() -> [WalletNetworkConfig] {
        guard let data = defaults.data(forKey: networksKey) else { return [] }
        return (try? JSONDecoder().decode([WalletNetworkConfig].self, from: data)) ?? []
    }

    func loadAllNetworks() -> [WalletNetworkConfig] {
        let builtIns = WalletNetworkConfig.builtInEVMNetworks
        let builtInIds = Set(builtIns.map(\.id))
        return builtIns + loadUserNetworks().filter { !builtInIds.contains($0.id) }
    }

    func saveUserNetworks(_ items: [WalletNetworkConfig]) {
        guard let data = try? JSONEncoder().encode(items.sorted { $0.chainId < $1.chainId }) else { return }
        defaults.set(data, forKey: networksKey)
    }

    func upsertNetwork(_ network: WalletNetworkConfig) {
        var items = loadUserNetworks()
        if let index = items.firstIndex(where: { $0.id == network.id }) {
            items[index] = network
        } else {
            items.append(network)
        }
        saveUserNetworks(items)
    }
}
