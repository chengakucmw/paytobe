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
    @Published var connectInvitation: ConnectInvitation?
    @Published var showingConnectInvitation = false
    @Published var isCreatingConnectKey = false
    @Published var showingPairingScanner = false
    @Published var connections: [AgentConnection] = []
    @Published var selectedConnection: AgentConnection?
    @Published var networks: [WalletNetworkConfig] = []
    /// Per-asset balances keyed by WalletAsset.id (rail), filled by refreshBalances(). Display-only.
    @Published var assetBalances: [String: String] = [:]
    @Published var progress: PaymentProgress?
    @Published var errorMessage: String?
    @Published var selectedTab: AppTab = .home
    // Guards the money-moving actions (pay / reject) against double-submit. Set
    // synchronously on the main actor before the first await — the detail sheet
    // can't dismiss within the same runloop tick, so without this a rapid second
    // tap on Pay/Reject enqueues a second sign+broadcast (tx_bad_seq, or a payment
    // that broadcast yet shows as failed). Bound to .disabled on both buttons too.
    @Published var isProcessingIntent = false
    // True until the off-main launch hydrate() finishes loading the wallet + local
    // stores. The root view shows a lightweight splash while this is true, so an
    // existing user never sees the empty / "no wallet" state flash at cold launch.
    @Published var isHydrating = true

    private let walletStore = WalletStore()
    private let localStore = LocalStore()
    private let relay = RelayClient()
    private let stellar = StellarService()
    private let evmService = EvmService()
    private let solanaService = SolanaService()

    override init() {
        // Initialize stored properties with cheap defaults only — NO Keychain reads or
        // JSON decoding on the main thread at launch. The real wallet + local stores are
        // loaded off the main thread in hydrate() and published after the first frame.
        relayURL = ""
        deviceId = ""
        deviceToken = ""
        super.init()
        UNUserNotificationCenter.current().delegate = self
        Task { await requestNotificationPermission() }
        hydrate()
    }

    /// Loads the wallet (Keychain) and every local store (UserDefaults + JSON decode,
    /// some Keychain-backed) OFF the main thread, then publishes them on the main actor.
    /// Cold launch therefore never hitches on a synchronous Keychain hit + decoding.
    /// The initial relay connect/sync is kicked from here too, because it needs the
    /// device id/token that are now loaded off-main (handleScenePhase skips while
    /// `isHydrating`). A splash covers the brief window (see isHydrating).
    private func hydrate() {
        let walletStore = self.walletStore
        let localStore = self.localStore
        DispatchQueue.global(qos: .userInitiated).async {
            let relayURL = localStore.relayURL
            let deviceId = localStore.deviceId
            let deviceToken = localStore.deviceToken
            let inbox = localStore.loadInbox()
            let history = localStore.loadHistory()
            let connections = localStore.loadConnections()
            let networks = localStore.loadAllNetworks()
            let wallet = try? walletStore.load()
            Task { @MainActor in
                self.relayURL = relayURL
                self.deviceId = deviceId
                self.deviceToken = deviceToken
                self.inbox = inbox
                self.history = history
                self.connections = connections
                self.networks = networks
                self.wallet = wallet
                if let wallet {
                    self.statusText = wallet.isBackupVerified ? "Ready" : "Backup required"
                }
                self.isHydrating = false
                // device id/token/relayURL are loaded now: run the initial relay connect +
                // one-shot inbox sync that handleScenePhase deferred during hydration.
                if !self.relayURL.isEmpty {
                    self.connectRelay()
                    self.syncInbox(silent: true)
                }
            }
        }
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
    }

    /// Connect/refresh in response to the app lifecycle so the inbox never
    /// silently freezes. On foreground we (re)open the relay socket — which is
    /// idempotent — and do a one-shot inbox sync as a fallback while the socket
    /// catches up. On background we tear the socket down for a clean reconnect.
    func handleScenePhase(_ phase: ScenePhase) {
        switch phase {
        case .active:
            // Skip while hydrating: the initial connect/sync is kicked from hydrate()
            // once the device id/token are loaded off the main thread.
            guard !isHydrating, !relayURL.isEmpty else { return }
            connectRelay()
            syncInbox(silent: true)
        case .background:
            relay.disconnect()
        case .inactive:
            break
        @unknown default:
            break
        }
    }

    /// Fetches each home asset's on-chain balance (XLM / ETH / USDC / SOL) concurrently and
    /// fail-safe — any failure leaves that asset at "0". Read-only: never touches signing/sending.
    func refreshBalances() {
        guard let wallet else { return }
        let stellarAddr = wallet.address
        let evmAddr = wallet.evmAddress ?? ""
        let solAddr = wallet.solanaAddress ?? ""
        let ethRpc: String
        if let network = networks.first(where: {
            $0.family == WalletNetworkConfig.familyEVM && $0.chainId == 1
        }) {
            ethRpc = network.defaultRPCURL
        } else {
            ethRpc = ""
        }
        let baseRpc: String
        if let network = networks.first(where: {
            $0.family == WalletNetworkConfig.familyEVM && $0.chainId == 8453
        }) {
            baseRpc = network.defaultRPCURL
        } else {
            baseRpc = "https://mainnet.base.org"
        }
        Task {
            async let xlm = stellar.xlmBalance(horizonURL: "https://horizon.stellar.org", accountId: stellarAddr)
            async let eth = evmService.nativeBalance(rpcURL: ethRpc, address: evmAddr, decimals: 18)
            async let usdc = evmService.tokenBalance(rpcURL: baseRpc, contract: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", address: evmAddr, decimals: 6)
            async let sol = solanaService.solBalance(rpcURL: SolanaService.mainnetRPC, address: solAddr)
            let (x, e, u, s) = await (xlm, eth, usdc, sol)
            self.assetBalances = [
                "stellar_xlm": x,
                "ethereum_eth": e,
                "base_usdc": u,
                "solana_sol": s,
            ]
        }
    }

    func syncInbox(silent: Bool = false) {
        Task {
            do {
                statusText = "Syncing inbox"
                let items = try await relay.sync(config: relayConfig)
                for item in items { localStore.upsertIntent(item) }
                inbox = localStore.loadInbox()
                statusText = "Inbox synced"
            } catch {
                if silent {
                    statusText = "Inbox sync failed"
                } else {
                    showError(error)
                }
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

    func createConnectInvitation() {
        guard !isCreatingConnectKey else { return }
        isCreatingConnectKey = true
        Task {
            defer { isCreatingConnectKey = false }
            do {
                statusText = "Creating Connect Key"
                let invitation = try await relay.createConnectInvitation(config: relayConfig)
                connectInvitation = invitation
                showingConnectInvitation = true
                statusText = "Connect Key ready"
            } catch {
                showError(error)
            }
        }
    }

    func refreshConnectInvitation() {
        guard let invitation = connectInvitation, !invitation.isTerminal else { return }
        Task {
            do {
                let refreshed = try await relay.fetchConnectInvitation(config: relayConfig, invitation: invitation)
                connectInvitation = refreshed
                statusText = refreshed.hasClaimedAgent ? "Review Agent request" : "Waiting for Agent"
            } catch {
                showError(error)
            }
        }
    }

    func cancelConnectInvitation() {
        guard let invitation = connectInvitation, !invitation.isTerminal else { return }
        Task {
            do {
                connectInvitation = try await relay.cancelConnectInvitation(config: relayConfig, invitation: invitation)
                statusText = "Connect Key cancelled"
            } catch {
                showError(error)
            }
        }
    }

    func reviewConnectInvitationAgent() {
        guard let invitation = connectInvitation, !invitation.pairingSessionId.isEmpty else { return }
        pairingInput = invitation.pairingSessionId
        showingConnectInvitation = false
        Task {
            try? await Task.sleep(nanoseconds: 250_000_000)
            reviewPairing()
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
        guard !isProcessingIntent else { return }
        isProcessingIntent = true
        Task {
            defer { isProcessingIntent = false }
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

                // Client-side risk backstop (defense in depth). The relay's verdict was
                // already honored above via isPaymentDetailSignable; this independently
                // recomputes the daily spend cap and the unverified-recipient cap in exact
                // Decimal and fails closed, so a stale, buggy, or tampered payload that omits
                // the server block can never reach the signer. Mirrors Android RiskPolicy.java.
                // Only XLM is signable on iOS v1, so only the XLM caps apply here.
                let backstop = LocalRiskPolicy.evaluateXLM(
                    amount: intent.amount,
                    spentTodayXLM: localStore.spentToday(asset: "XLM"),
                    recipientWhitelisted: localStore.isRecipientWhitelisted(intent.to)
                )
                guard backstop.allowed else {
                    throw AppError.invalidResponse(backstop.errors.joined(separator: " "))
                }

                // M14 fix: honor the protocol's policy.requires_user_approval flag.
                // This wallet has a single signing entry point (this function),
                // reached only by an explicit user action, so user approval is
                // always present here. The flag is read defensively: an absent or
                // even an explicit `false` value is treated as "approval required",
                // so a server can raise the approval bar but never waive it, and no
                // auto-sign path exists. (Previously the flag was parsed and never
                // read, so a server instruction to require approval was silently void.)
                if intent.policyRequiresUserApproval == false {
                    statusText = "Server asked to skip approval; ignoring — explicit approval is always required before signing."
                }
                selectedIntent = nil
                // L4: dismiss the detail sheet, then present the progress sheet on the
                // NEXT runloop tick. Both are .sheet(item:) on the same view (see
                // ContentView), and flipping selectedIntent → nil and progress → value
                // in a single runloop is a known SwiftUI race that can silently drop the
                // second presentation, so the progress sheet sometimes never appears.
                // Yielding one main-runloop tick lets the dismissal commit first.
                await Task.yield()
                progress = PaymentProgress(
                    title: "Generating transaction",
                    message: "Preparing and signing the transaction locally.",
                    detail: nil,
                    canDismiss: false
                )
                let config = relayConfig

                // M13 fix: sign locally first, then report `signed` as its own
                // ordered step *before* broadcasting. Previously the only `signed`
                // report was buried inside the broadcast progress callback and
                // swallowed by `try?`, so a dropped report made the relay timeline
                // skip straight from `pending` to `broadcasted` (or arrive out of
                // order). Reporting it here, in order and un-swallowed, keeps the
                // relay timeline faithful; because nothing has been broadcast yet,
                // a failure at this point safely aborts with no funds moved.
                let signedTx = try await stellar.signXLM(
                    wallet: wallet,
                    horizonURL: intent.horizonUrl,
                    testnet: intent.stellarTestnet,
                    destinationAddress: intent.to,
                    amountXLM: intent.amount,
                    memo: intent.memo,
                    memoType: intent.memoType ?? ""
                )
                try await relay.updateStatus(config: config, intent: intent, status: PaymentStatus.signed.rawValue)
                localStore.upsertIntent(intent.updating(status: PaymentStatus.signed.rawValue))
                inbox = localStore.loadInbox()

                progress = PaymentProgress(
                    title: "The transaction has been generated",
                    message: "Broadcasting to \(intent.network.isEmpty ? "Stellar" : intent.network).",
                    detail: nil,
                    canDismiss: false
                )
                let txHash = try await stellar.broadcastXLM(
                    signedTx,
                    progress: { detail in
                        await MainActor.run {
                            self.progress = PaymentProgress(
                                title: "The transaction has been generated",
                                message: "Broadcasting to \(intent.network.isEmpty ? "Stellar" : intent.network).",
                                detail: detail,
                                canDismiss: false
                            )
                        }
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
                // Record the successful spend in the local daily ledger so the client-side
                // daily cap (LocalRiskPolicy) reflects it on the next payment, mirroring
                // Android's RiskPolicy.recordSuccessfulPayment after a successful broadcast.
                localStore.recordSpend(asset: "XLM", amount: intent.amount)
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
        guard !isProcessingIntent else { return }
        isProcessingIntent = true
        Task {
            defer { isProcessingIntent = false }
            do {
                guard intent.isPending else {
                    throw AppError.invalidResponse("Cannot reject: payment request is already \(intent.status).")
                }
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
