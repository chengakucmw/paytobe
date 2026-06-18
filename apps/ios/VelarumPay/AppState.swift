import Foundation
import SwiftUI
import UserNotifications

#if canImport(UIKit)
import UIKit
#endif

enum AppTab: Hashable {
    case home
    case inbox
    case history
    case settings
}

@MainActor
final class AppState: NSObject, ObservableObject, UNUserNotificationCenterDelegate {
    @Published var wallet: StellarWallet?
    @Published var inbox: [PaymentIntent] = []
    @Published var history: [HistoryEntry] = []
    @Published var relayURL: String
    @Published var deviceId: String
    @Published var deviceToken: String
    @Published var statusText = "Ready"
    @Published var selectedIntent: PaymentIntent?
    @Published var pairingInput = ""
    @Published var pairingSession: PairingSession?
    @Published var showingPairingScanner = false
    @Published var connections: [AgentConnection] = []
    @Published var selectedConnection: AgentConnection?
    @Published var networks: [WalletNetworkConfig] = []
    @Published var progress: PaymentProgress?
    @Published var errorMessage: String?
    @Published var selectedTab: AppTab = .home

    private let walletStore = WalletStore()
    private let localStore = LocalStore()
    private let relay = RelayClient()
    private let stellar = StellarService()

    override init() {
        relayURL = localStore.relayURL
        deviceId = localStore.deviceId
        deviceToken = localStore.deviceToken
        inbox = localStore.loadInbox()
        history = localStore.loadHistory()
        connections = localStore.loadConnections()
        networks = localStore.loadAllNetworks()
        let loadedWallet = try? walletStore.load()
        wallet = loadedWallet
        if let loadedWallet {
            statusText = loadedWallet.isBackupVerified ? "Ready" : "Backup required"
        }
        super.init()
        UNUserNotificationCenter.current().delegate = self
        Task { await requestNotificationPermission() }
    }

    var relayConfig: RelayClient.Config {
        RelayClient.Config(relayURL: relayURL, deviceId: deviceId, token: deviceToken)
    }

    func generateWallet() {
        Task {
            do {
                let generated = try await stellar.generateWallet()
                try walletStore.save(generated)
                wallet = generated
                statusText = "24-word wallet generated - backup required"
            } catch {
                showError(error)
            }
        }
    }

    func restoreWallet(mnemonic: String, backupVerified: Bool) {
        Task {
            do {
                let restored = try await stellar.restoreWallet(mnemonic: mnemonic, backupVerified: backupVerified)
                try walletStore.save(restored)
                wallet = restored
                statusText = backupVerified ? "Wallet imported" : "Wallet imported - backup required"
            } catch {
                showError(error)
            }
        }
    }

    func markWalletBackupVerified() {
        do {
            guard let wallet else { throw AppError.missingWallet }
            let updated = wallet.markingBackupVerified()
            try walletStore.save(updated)
            self.wallet = updated
            statusText = "Recovery phrase backup verified"
        } catch {
            showError(error)
        }
    }

    func openSecuritySettings() {
        selectedIntent = nil
        selectedTab = .settings
        statusText = "Open Settings > Security"
    }

    func clearWallet() {
        do {
            try walletStore.clear()
            wallet = nil
            statusText = "Wallet cleared"
        } catch {
            showError(error)
        }
    }

    func saveRelayURL(_ value: String) {
        let clean = value.trimmingCharacters(in: .whitespacesAndNewlines).trimmingCharacters(in: CharacterSet(charactersIn: "/"))
        relayURL = clean
        localStore.relayURL = clean
        statusText = "Relay URL saved"
    }

    var userNetworks: [WalletNetworkConfig] {
        networks.filter { $0.source != WalletNetworkConfig.sourceBuiltIn }
    }

    func addNetwork(_ network: WalletNetworkConfig) {
        localStore.upsertNetwork(network)
        networks = localStore.loadAllNetworks()
        statusText = "Network added"
    }

    func isNetworkEnabled(for intent: PaymentIntent) -> Bool {
        if intent.network.lowercased().contains("stellar") || intent.network.lowercased().contains("solana") {
            return true
        }
        return networks.contains { $0.matches(network: intent.network, chainId: intent.chainId) }
    }

    func registerRelay() {
        Task {
            do {
                statusText = "Registering relay"
                try await relay.register(config: relayConfig)
                statusText = "Relay registered"
            } catch {
                showError(error)
            }
        }
    }

    func connectRelay() {
        statusText = "Connecting relay"
        relay.connect(
            config: relayConfig,
            onIntentId: { [weak self] intentId in
                await self?.fetchAndOpenIntent(id: intentId, notify: true)
            },
            onMessage: { [weak self] message in
                await MainActor.run {
                    self?.statusText = message
                }
            }
        )
        statusText = "Relay connected"
    }

    func syncInbox() {
        Task {
            do {
                statusText = "Syncing inbox"
                let items = try await relay.sync(config: relayConfig)
                for item in items { localStore.upsertIntent(item) }
                inbox = localStore.loadInbox()
                statusText = "Inbox synced"
            } catch {
                showError(error)
            }
        }
    }

    func reviewPairing() {
        Task {
            do {
                statusText = "Loading pairing"
                let session = try await relay.fetchPairingSession(config: relayConfig, input: pairingInput)
                pairingSession = session
                statusText = "Review pairing"
            } catch {
                showError(error)
            }
        }
    }

    func approvePairing(_ session: PairingSession, scopes: Set<String>) {
        Task {
            do {
                let approved = session.requestedScopes.filter { scopes.contains($0) }
                guard !approved.isEmpty else {
                    throw AppError.invalidResponse("Approve at least one requested non-signing scope, or reject the pairing request.")
                }
                statusText = "Approving agent"
                let connection = try await relay.approvePairing(config: relayConfig, session: session, scopes: approved)
                localStore.upsertConnection(connection)
                connections = localStore.loadConnections()
                pairingSession = nil
                pairingInput = ""
                selectedConnection = connection
                statusText = "Agent connected"
            } catch {
                showError(error)
            }
        }
    }

    func rejectPairing(_ session: PairingSession) {
        Task {
            do {
                statusText = "Rejecting pairing"
                try await relay.rejectPairing(config: relayConfig, session: session)
                pairingSession = nil
                statusText = "Pairing rejected"
            } catch {
                showError(error)
            }
        }
    }

    func syncConnections() {
        Task {
            do {
                statusText = "Syncing connections"
                let items = try await relay.syncConnections(config: relayConfig)
                for item in items { localStore.upsertConnection(item) }
                connections = localStore.loadConnections()
                statusText = "Connections synced"
            } catch {
                showError(error)
            }
        }
    }

    func updateConnection(_ connection: AgentConnection, status: String) {
        Task {
            do {
                statusText = status == "active" ? "Resuming agent" : "Pausing agent"
                let updated = try await relay.updateConnectionStatus(config: relayConfig, connection: connection, status: status)
                localStore.upsertConnection(updated)
                connections = localStore.loadConnections()
                selectedConnection = updated
                statusText = "Connection \(status)"
            } catch {
                showError(error)
            }
        }
    }

    func revokeConnection(_ connection: AgentConnection) {
        Task {
            do {
                statusText = "Revoking agent"
                let updated = try await relay.revokeConnection(config: relayConfig, connection: connection)
                localStore.upsertConnection(updated)
                connections = localStore.loadConnections()
                selectedConnection = updated
                statusText = "Connection revoked"
            } catch {
                localStore.updateConnection(id: connection.connectionId, status: "revoked")
                connections = localStore.loadConnections()
                selectedConnection = connection.updating(status: "revoked")
                showError(error)
            }
        }
    }

    func pay(_ intent: PaymentIntent) {
        Task {
            do {
                guard let wallet else { throw AppError.missingWallet }
                guard intent.isPending else {
                    throw AppError.invalidResponse(intent.isExpired ? "Payment request expired." : "Payment request is already \(intent.status).")
                }
                let paymentReady = isPaymentDetailSignable(intent)
                guard paymentReady else {
                    throw AppError.invalidResponse(paymentBlockedReason(intent))
                }
                guard WalletSecurityNavigationPolicy.canCreateSignature(
                    walletLoaded: true,
                    backupVerified: wallet.isBackupVerified,
                    paymentReady: paymentReady
                ) else {
                    openSecuritySettings()
                    throw AppError.invalidResponse(WalletSecurityNavigationPolicy.backupGateCopy)
                }
                guard intent.isStellarXLM else {
                    if intent.asset.uppercased() != "XLM", intent.network.lowercased().contains("stellar") {
                        try await stellar.canReceiveAsset(
                            horizonURL: intent.horizonUrl,
                            testnet: intent.stellarTestnet,
                            destinationAddress: intent.to,
                            assetCode: intent.asset,
                            assetIssuer: intent.assetIssuer
                        )
                    }
                    throw AppError.unsupportedPayment("iOS v1 supports Stellar XLM payment requests. \(intent.asset) / \(intent.network) is review-only for now.")
                }
                selectedIntent = nil
                progress = PaymentProgress(
                    title: "Generating transaction",
                    message: "Preparing and signing the transaction locally.",
                    detail: nil,
                    canDismiss: false
                )
                let config = relayConfig
                let relayClient = relay
                let txHash = try await stellar.sendXLM(
                    wallet: wallet,
                    horizonURL: intent.horizonUrl,
                    testnet: intent.stellarTestnet,
                    destinationAddress: intent.to,
                    amountXLM: intent.amount,
                    progress: { detail in
                        await MainActor.run {
                            self.progress = PaymentProgress(
                                title: "The transaction has been generated",
                                message: "Broadcasting to \(intent.network.isEmpty ? "Stellar" : intent.network).",
                                detail: detail,
                                canDismiss: false
                            )
                        }
                        try? await relayClient.updateStatus(config: config, intent: intent, status: PaymentStatus.signed.rawValue)
                    }
                )
                try await relay.updateStatus(config: relayConfig, intent: intent, status: PaymentStatus.broadcasted.rawValue, txHash: txHash)
                let updated = intent.updating(status: PaymentStatus.broadcasted.rawValue, txHash: txHash)
                localStore.upsertIntent(updated)
                inbox = localStore.loadInbox()
                let entry = HistoryEntry(
                    id: "tx:\(txHash)",
                    title: intent.title,
                    amount: intent.amount,
                    asset: intent.asset,
                    network: intent.network,
                    to: intent.to,
                    status: PaymentStatus.broadcasted.rawValue,
                    txHash: txHash,
                    createdAtMs: Int64(Date().timeIntervalSince1970 * 1000)
                )
                localStore.recordHistory(entry)
                history = localStore.loadHistory()
                progress = PaymentProgress(
                    title: "Payment broadcasted",
                    message: "The transaction was submitted to the Stellar network.",
                    detail: txHash,
                    canDismiss: true
                )
                statusText = "Payment broadcasted"
            } catch {
                try? await relay.updateStatus(config: relayConfig, intent: intent, status: PaymentStatus.failed.rawValue, error: error.localizedDescription)
                localStore.updateIntent(id: intent.id, status: PaymentStatus.failed.rawValue, txHash: nil, error: error.localizedDescription)
                inbox = localStore.loadInbox()
                progress = nil
                showError(error)
            }
        }
    }

    func reject(_ intent: PaymentIntent) {
        Task {
            do {
                try await relay.updateStatus(config: relayConfig, intent: intent, status: PaymentStatus.rejected.rawValue)
                localStore.updateIntent(id: intent.id, status: PaymentStatus.rejected.rawValue, txHash: nil, error: nil)
                inbox = localStore.loadInbox()
                selectedIntent = nil
                statusText = "Payment rejected"
            } catch {
                showError(error)
            }
        }
    }

    func copy(_ value: String) {
        #if canImport(UIKit)
        UIPasteboard.general.string = value
        statusText = "Copied"
        #else
        statusText = value
        #endif
    }

    func closeProgress() {
        progress = nil
        selectedIntent = nil
    }

    private func fetchAndOpenIntent(id: String, notify: Bool) async {
        do {
            let intent = try await relay.fetchIntent(config: relayConfig, id: id)
            localStore.upsertIntent(intent)
            inbox = localStore.loadInbox()
            selectedIntent = intent
            statusText = "New payment request"
            if notify {
                await notifyPayment(intent)
            }
        } catch {
            showError(error)
        }
    }

    private func requestNotificationPermission() async {
        _ = try? await UNUserNotificationCenter.current().requestAuthorization(options: [.alert, .badge, .sound])
    }

    private func notifyPayment(_ intent: PaymentIntent) async {
        let content = UNMutableNotificationContent()
        content.title = "New payment request"
        content.body = "\(intent.title) to \(shortAddress(intent.to))"
        content.userInfo = ["intent_id": intent.id]
        content.sound = .default
        let request = UNNotificationRequest(identifier: "payment-\(intent.id)", content: content, trigger: nil)
        try? await UNUserNotificationCenter.current().add(request)
    }

    nonisolated func userNotificationCenter(
        _ center: UNUserNotificationCenter,
        didReceive response: UNNotificationResponse
    ) async {
        guard let intentId = response.notification.request.content.userInfo["intent_id"] as? String else { return }
        await fetchAndOpenIntent(id: intentId, notify: false)
    }

    nonisolated func userNotificationCenter(
        _ center: UNUserNotificationCenter,
        willPresent notification: UNNotification
    ) async -> UNNotificationPresentationOptions {
        [.banner, .sound]
    }

    private func showError(_ error: Error) {
        errorMessage = error.localizedDescription
        statusText = "Error"
    }
}
