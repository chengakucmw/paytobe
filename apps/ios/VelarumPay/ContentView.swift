import SwiftUI
import CoreImage // M-5: QR code generation for the receive address (CIQRCodeGenerator).

#if canImport(UIKit)
import UIKit
#elseif canImport(AppKit)
import AppKit
#endif

#if canImport(AVFoundation)
import AVFoundation
#endif

struct ContentView: View {
    var body: some View {
        VelarumRootView()
    }
}

struct VelarumRootView: View {
    @EnvironmentObject private var app: AppState

    var body: some View {
        TabView(selection: $app.selectedTab) {
            WalletView()
                .tabItem { Label("Home", systemImage: "wallet.pass") }
                .tag(AppTab.home)
            InboxView()
                .tabItem { Label("Inbox", systemImage: "tray.full") }
                .tag(AppTab.inbox)
            HistoryView()
                .tabItem { Label("History", systemImage: "clock") }
                .tag(AppTab.history)
            SettingsView()
                .tabItem { Label("Settings", systemImage: "gearshape") }
                .tag(AppTab.settings)
        }
        .sheet(item: $app.selectedIntent) { intent in
            PaymentDetailView(intent: intent)
                .environmentObject(app)
        }
        .sheet(item: $app.pairingSession) { session in
            PairingReviewView(session: session)
                .environmentObject(app)
        }
        .sheet(item: $app.selectedConnection) { connection in
            ConnectionDetailView(connection: connection)
                .environmentObject(app)
        }
        .sheet(item: $app.progress) { progress in
            PaymentProgressView(progress: progress)
                .environmentObject(app)
                .presentationDetents([.medium, .large])
        }
        .sheet(isPresented: $app.showingPairingScanner) {
            PairingScannerSheet { code in
                app.showingPairingScanner = false
                app.pairingInput = code
                app.reviewPairing()
            }
        }
        .alert(
            "VelarumPay",
            isPresented: Binding(
                get: { app.errorMessage != nil },
                set: { if !$0 { app.errorMessage = nil } }
            )
        ) {
            Button("OK", role: .cancel) { app.errorMessage = nil }
        } message: {
            Text(app.errorMessage ?? "")
        }
    }
}

struct WalletView: View {
    @EnvironmentObject private var app: AppState

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(spacing: 16) {
                    HeaderCard(title: "VelarumPay", subtitle: "Local signing wallet", status: app.statusText)
                    if let wallet = app.wallet {
                        AddressCard(
                            title: "Stellar",
                            address: wallet.address,
                            note: "Use this address only for Stellar XLM. Other networks show separate receive details when their signer is enabled."
                        )
                        WalletRelayCard()
                    } else {
                        EmptyWalletCard()
                    }
                    InfoCard(
                        title: "Payment support",
                        bodyText: "iOS v1 signs Stellar XLM Payment Requests locally. Other rails remain review-only until their signer is enabled."
                    )
                }
                .padding()
            }
            .background(Color.appGroupedBackground)
        }
    }
}

struct EmptyWalletCard: View {
    @EnvironmentObject private var app: AppState

    var body: some View {
        Card {
            VStack(alignment: .leading, spacing: 12) {
                Text("No wallet yet")
                    .font(.title2.bold())
                Text("Set up or recover a wallet from Settings > Security. Home will show your Stellar receive address and a scannable QR code after a wallet is loaded.")
                    .foregroundStyle(.secondary)
                Button {
                    app.openSecuritySettings()
                } label: {
                    Label("Open Settings", systemImage: "gearshape")
                        .frame(maxWidth: .infinity)
                }
                .buttonStyle(.borderedProminent)
                .controlSize(.large)
            }
        }
    }
}

struct WalletRelayCard: View {
    @EnvironmentObject private var app: AppState

    var body: some View {
        Card {
            VStack(alignment: .leading, spacing: 12) {
                Text("Payment Request relay")
                    .font(.title2.bold())
                Text("Register this device with a VelarumPay relay, connect trusted agents, then review incoming requests before signing.")
                    .foregroundStyle(.secondary)
                HStack {
                    Button {
                        app.registerRelay()
                    } label: {
                        Label("Register", systemImage: "antenna.radiowaves.left.and.right")
                    }
                    .buttonStyle(.borderedProminent)
                    Button {
                        app.syncInbox()
                    } label: {
                        Label("Sync", systemImage: "arrow.clockwise")
                    }
                    .buttonStyle(.bordered)
                }
                if app.relayURL.isEmpty {
                    Text("Set a relay URL in Settings before registering or syncing.")
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                } else {
                    FieldRow(title: "Relay URL", value: app.relayURL)
                }
            }
        }
    }
}

struct MnemonicBackupCard: View {
    let wallet: StellarWallet
    let onBackup: () -> Void

    var body: some View {
        Card {
            VStack(alignment: .leading, spacing: 12) {
                HStack {
                    VStack(alignment: .leading, spacing: 4) {
                        Text("Recovery phrase")
                            .font(.title2.bold())
                        Text(wallet.displayMnemonicType)
                            .font(.subheadline)
                            .foregroundStyle(.secondary)
                    }
                    Spacer()
                    TonePill(text: wallet.isBackupVerified ? "Verified" : "Required", tone: wallet.isBackupVerified ? "success" : "warning")
                }
                if let path = wallet.derivationPath, !path.isEmpty {
                    FieldRow(title: "Stellar path", value: path)
                }
                Text(wallet.isBackupVerified ? "This wallet is ready for local signing." : "Back up and verify the recovery phrase before signing Payment Requests.")
                    .foregroundStyle(.secondary)
                Button {
                    onBackup()
                } label: {
                    Label(wallet.isBackupVerified ? "Review Backup" : "Back Up Now", systemImage: "lock.shield")
                        .frame(maxWidth: .infinity)
                }
                .buttonStyle(.borderedProminent)
                .controlSize(.large)
            }
        }
    }
}

struct RecoveryPhraseBackupSheet: View {
    @EnvironmentObject private var app: AppState
    @Environment(\.dismiss) private var dismiss
    let wallet: StellarWallet
    @State private var showingWords = false
    @State private var answers: [Int: String] = [:]
    @State private var verificationMessage = ""

    private var words: [String] {
        wallet.recoveryPhrase?.split(whereSeparator: { $0.isWhitespace }).map(String.init) ?? []
    }

    private var positions: [Int] {
        challengePositions(for: words.count)
    }

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 16) {
                    InfoCard(
                        title: "Offline backup only",
                        bodyText: "Write the recovery phrase in the exact order. Do not save it to screenshots, cloud notes, chat, or email."
                    )
                    if words.isEmpty {
                        ContentUnavailableView("Recovery phrase unavailable", systemImage: "key.slash", description: Text("This looks like a legacy local Stellar key and cannot be backed up as a BIP-39 phrase."))
                    } else if showingWords {
                        MnemonicGrid(words: words)
                            .textSelection(.disabled)
                        Text("Verification")
                            .font(.headline)
                        ForEach(positions, id: \.self) { position in
                            TextField("Word #\(position + 1)", text: Binding(
                                get: { answers[position, default: ""] },
                                set: { answers[position] = $0 }
                            ))
                            .textInputAutocapitalization(.never)
                            .autocorrectionDisabled()
                            .textFieldStyle(.roundedBorder)
                        }
                        if !verificationMessage.isEmpty {
                            Text(verificationMessage)
                                .font(.footnote.bold())
                                .foregroundStyle(.red)
                        }
                        Button {
                            verify()
                        } label: {
                            Label("Verify Backup", systemImage: "checkmark.shield")
                                .frame(maxWidth: .infinity)
                        }
                        .buttonStyle(.borderedProminent)
                        .controlSize(.large)
                    } else {
                        Button {
                            showingWords = true
                        } label: {
                            Label("Show Recovery Phrase", systemImage: "eye")
                                .frame(maxWidth: .infinity)
                        }
                        .buttonStyle(.borderedProminent)
                        .controlSize(.large)
                    }
                }
                .padding()
            }
            .navigationTitle("Back Up Wallet")
            .appInlineNavigationTitle()
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Close") { dismiss() }
                }
            }
        }
    }

    private func verify() {
        for position in positions {
            let expected = words[position]
            let actual = answers[position, default: ""].trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
            guard actual == expected else {
                verificationMessage = "Word #\(position + 1) does not match."
                return
            }
        }
        app.markWalletBackupVerified()
        dismiss()
    }
}

struct RecoveryPhraseImportSheet: View {
    @EnvironmentObject private var app: AppState
    @Environment(\.dismiss) private var dismiss
    @State private var phraseText = ""
    @State private var backupConfirmed = false
    @State private var preview: StellarWallet?
    @State private var errorMessage = ""
    private let stellar = StellarService()

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 16) {
                    InfoCard(
                        title: "Import recovery phrase",
                        bodyText: "Supported BIP-39 English lengths are 12, 15, 18, 21, and 24 words. Cloud backup and MPC recovery are not enabled in this build."
                    )
                    TextEditor(text: $phraseText)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                        .font(.system(.body, design: .monospaced))
                        .frame(minHeight: 150)
                        .padding(8)
                        .background(Color.appSecondaryGroupedBackground, in: RoundedRectangle(cornerRadius: 14))
                    Toggle("I already have this phrase backed up offline", isOn: $backupConfirmed)
                    Button {
                        previewImport()
                    } label: {
                        Label("Preview Address", systemImage: "doc.text.magnifyingglass")
                            .frame(maxWidth: .infinity)
                    }
                    .buttonStyle(.borderedProminent)
                    .controlSize(.large)
                    if let preview {
                        Card {
                            VStack(alignment: .leading, spacing: 12) {
                                Text("Address preview")
                                    .font(.headline)
                                FieldRow(title: "Mnemonic type", value: preview.displayMnemonicType)
                                FieldRow(title: "Stellar path", value: preview.derivationPath ?? "m/44'/148'/0'")
                                FieldRow(title: "Stellar address", value: preview.address)
                                Text(backupConfirmed ? "This wallet will be marked as backed up." : "Backup verification will be required before signing.")
                                    .foregroundStyle(.secondary)
                                Button {
                                    app.restoreWallet(mnemonic: phraseText, backupVerified: backupConfirmed)
                                    dismiss()
                                } label: {
                                    Label("Import to this Device", systemImage: "square.and.arrow.down")
                                        .frame(maxWidth: .infinity)
                                }
                                .buttonStyle(.borderedProminent)
                                .controlSize(.large)
                            }
                        }
                    }
                    if !errorMessage.isEmpty {
                        Text(errorMessage)
                            .font(.footnote.bold())
                            .foregroundStyle(.red)
                    }
                }
                .padding()
            }
            .navigationTitle("Import Wallet")
            .appInlineNavigationTitle()
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Close") { dismiss() }
                }
            }
        }
    }

    private func previewImport() {
        errorMessage = ""
        preview = nil
        Task {
            do {
                let wallet = try await stellar.restoreWallet(mnemonic: phraseText, backupVerified: backupConfirmed)
                await MainActor.run { preview = wallet }
            } catch {
                await MainActor.run { errorMessage = error.localizedDescription }
            }
        }
    }
}

struct MnemonicGrid: View {
    let words: [String]

    var body: some View {
        LazyVGrid(columns: [GridItem(.flexible()), GridItem(.flexible())], spacing: 8) {
            ForEach(Array(words.enumerated()), id: \.offset) { index, word in
                HStack(spacing: 8) {
                    Text(String(format: "%02d", index + 1))
                        .foregroundStyle(.secondary)
                    Text(word)
                        .fontWeight(.semibold)
                    Spacer(minLength: 0)
                }
                .font(.system(.subheadline, design: .monospaced))
                .padding(.horizontal, 10)
                .padding(.vertical, 10)
                .background(Color.appSecondaryGroupedBackground, in: RoundedRectangle(cornerRadius: 12))
            }
        }
    }
}

struct InboxView: View {
    @EnvironmentObject private var app: AppState
    @State private var filter: InboxFilter = .pending

    private var visibleItems: [PaymentIntent] {
        app.inbox
            .filter { !$0.status.isEmpty && filter.matches($0) }
            .sorted(by: sortInboxIntents)
    }

    private var sections: [InboxSection] {
        InboxSection.sections(for: visibleItems, filter: filter)
    }

    var body: some View {
        NavigationStack {
            List {
                Section {
                    Button {
                        app.syncInbox()
                    } label: {
                        Label("Sync Inbox", systemImage: "arrow.clockwise")
                    }
                    Picker("Inbox filter", selection: $filter) {
                        ForEach(InboxFilter.allCases) { item in
                            Text(item.rawValue).tag(item)
                        }
                    }
                    .pickerStyle(.segmented)
                }
                if visibleItems.isEmpty {
                    ContentUnavailableView("No payment requests", systemImage: "tray", description: Text("Connect a trusted agent and sync the relay to receive reviewable requests."))
                } else {
                    ForEach(sections) { section in
                        Section(section.title) {
                            ForEach(section.items) { intent in
                                PaymentIntentRow(intent: intent)
                                    .contentShape(Rectangle())
                                    .onTapGesture { app.selectedIntent = intent }
                            }
                        }
                    }
                }
            }
            .navigationTitle("Inbox")
        }
    }
}

struct HistoryView: View {
    @EnvironmentObject private var app: AppState

    private var items: [HistoryEntry] {
        let fromInbox = app.inbox.filter(\.isAmountHistory).map {
            HistoryEntry(
                id: $0.txHash.isEmpty ? $0.id : "tx:\($0.txHash)",
                title: $0.title,
                amount: $0.amount,
                asset: $0.asset,
                network: $0.network,
                to: $0.to,
                status: $0.status,
                txHash: $0.txHash,
                createdAtMs: $0.createdAtMs
            )
        }
        return (app.history + fromInbox).uniquedById().sorted { $0.createdAtMs > $1.createdAtMs }
    }

    var body: some View {
        NavigationStack {
            List {
                if items.isEmpty {
                    ContentUnavailableView("No amount changes", systemImage: "clock", description: Text("Broadcast an XLM payment to create history."))
                } else {
                    ForEach(items) { item in
                        HistoryRow(item: item)
                    }
                }
            }
            .navigationTitle("History")
        }
    }
}

struct SettingsView: View {
    @EnvironmentObject private var app: AppState
    @State private var relayDraft = ""
    @State private var showingBackup = false
    @State private var showingImport = false
    @State private var showingAddNetwork = false

    var body: some View {
        NavigationStack {
            Form {
                Section("Security") {
                    Text("Settings > Security is the only place for wallet creation, recovery phrase backup, import, and recovery flows. Signing stays locked until the offline backup is verified.")
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                    if let wallet = app.wallet {
                        FieldRow(title: "Mnemonic type", value: wallet.displayMnemonicType)
                        FieldRow(title: "Backup status", value: wallet.isBackupVerified ? "Verified" : "Required before signing")
                        if let path = wallet.derivationPath, !path.isEmpty {
                            FieldRow(title: "Stellar path", value: path)
                        }
                        FieldRow(title: "Stellar Address", value: wallet.address, copyAction: { app.copy(wallet.address) })
                    } else {
                        ContentUnavailableView("No wallet loaded", systemImage: "wallet.pass", description: Text("Create a new wallet or recover an existing one here."))
                    }
                    Button {
                        app.generateWallet()
                    } label: {
                        Label("Create 24-word wallet", systemImage: "plus.circle.fill")
                    }
                    Button {
                        showingBackup = true
                    } label: {
                        Label(app.wallet?.isBackupVerified == true ? "Review recovery phrase backup" : "Recovery phrase backup", systemImage: "lock.shield")
                    }
                    .disabled(app.wallet == nil)
                    Button {
                        showingImport = true
                    } label: {
                        Label("Import or recover wallet", systemImage: "square.and.arrow.down")
                    }
                    Label("Device risk controls: local Keychain storage, no cloud backup in v1, and local user approval before signing.", systemImage: "iphone")
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                    if app.wallet != nil {
                        Button("Clear Local Wallet", role: .destructive) {
                            app.clearWallet()
                        }
                    }
                }
                Section("Relay") {
                    TextField("Relay URL", text: $relayDraft)
                        .relayURLInputStyle()
                    Button("Save Relay URL") {
                        app.saveRelayURL(relayDraft)
                    }
                    Button("Register Device") {
                        app.registerRelay()
                    }
                    Button("Connect WebSocket") {
                        app.connectRelay()
                    }
                }
                Section("Agent Pairing") {
                    TextField("Pairing short code or velarumpay://pair URI", text: $app.pairingInput)
                        .relayURLInputStyle()
                    Button {
                        app.reviewPairing()
                    } label: {
                        Label("Review Pairing", systemImage: "qrcode.viewfinder")
                    }
                    Button {
                        app.showingPairingScanner = true
                    } label: {
                        Label("Scan Pairing QR", systemImage: "camera.viewfinder")
                    }
                    Button {
                        app.syncConnections()
                    } label: {
                        Label("Sync Connections", systemImage: "arrow.clockwise")
                    }
                    Text("Pairing lets agents prepare requests only. It never grants signing permission or payment approval.")
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                }
                Section("Connected Agents") {
                    if app.connections.isEmpty {
                        ContentUnavailableView("No agents connected", systemImage: "person.crop.circle.badge.plus", description: Text("Enter a short code or pairing URI to review a local agent."))
                    } else {
                        ForEach(app.connections) { connection in
                            Button {
                                app.selectedConnection = connection
                            } label: {
                                ConnectionRow(connection: connection)
                            }
                            .buttonStyle(.plain)
                        }
                    }
                }
                Section("Networks") {
                    Text("Add EVM-compatible networks after verifying that the RPC endpoint reports the exact Chain ID. Personal RPC settings stay on this device.")
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                    ForEach(app.networks) { network in
                        NetworkConfigRow(network: network)
                    }
                    Button {
                        showingAddNetwork = true
                    } label: {
                        Label("Add Network", systemImage: "plus.circle")
                    }
                }
                Section("Device") {
                    FieldRow(title: "Device ID", value: app.deviceId, copyAction: { app.copy(app.deviceId) })
                    FieldRow(title: "Device Token", value: app.deviceToken, copyAction: { app.copy(app.deviceToken) })
                }
            }
            .navigationTitle("Settings")
            .onAppear { relayDraft = app.relayURL }
        }
        .sheet(isPresented: $showingBackup) {
            if let wallet = app.wallet {
                RecoveryPhraseBackupSheet(wallet: wallet)
                    .environmentObject(app)
                    .presentationDetents([.large])
                    .privacySensitive()
            }
        }
        .sheet(isPresented: $showingImport) {
            RecoveryPhraseImportSheet()
                .environmentObject(app)
                .presentationDetents([.large])
        }
        .sheet(isPresented: $showingAddNetwork) {
            AddNetworkSheet(sourceIntent: nil)
                .environmentObject(app)
                .presentationDetents([.large])
        }
    }
}

struct NetworkConfigRow: View {
    let network: WalletNetworkConfig

    var body: some View {
        HStack(alignment: .top, spacing: 12) {
            Image(systemName: network.source == WalletNetworkConfig.sourceBuiltIn ? "checkmark.seal.fill" : "network")
                .foregroundStyle(.green)
            VStack(alignment: .leading, spacing: 4) {
                Text(network.name)
                    .font(.headline)
                Text(network.displayLine)
                    .font(.caption)
                    .foregroundStyle(.secondary)
                if !network.defaultRPCURL.isEmpty {
                    Text(network.defaultRPCURL)
                        .font(.caption.monospaced())
                        .foregroundStyle(.secondary)
                        .lineLimit(1)
                }
            }
        }
        .padding(.vertical, 4)
    }
}

struct AddNetworkSheet: View {
    @Environment(\.dismiss) private var dismiss
    @EnvironmentObject private var app: AppState
    let sourceIntent: PaymentIntent?

    @State private var networkName = ""
    @State private var rpcURL = ""
    @State private var chainId = ""
    @State private var currencySymbol = ""
    @State private var blockExplorerURL = ""
    @State private var verificationText = "Test RPC before adding the network."
    @State private var verifiedFingerprint = ""
    @State private var isTesting = false
    @State private var didPrefill = false

    var body: some View {
        NavigationStack {
            Form {
                if let sourceIntent {
                    Section("Requested Network") {
                        FieldRow(title: "Network", value: "\(valueOr(sourceIntent.network, "Unknown network"))\(requestChainSuffix(sourceIntent))")
                        Text("Adding this network only enables local review. You still approve or reject the request separately.")
                            .font(.footnote)
                            .foregroundStyle(.secondary)
                    }
                }
                Section {
                    TextField("Enter network name", text: $networkName)
                    TextField("Add a URL", text: $rpcURL)
                        .keyboardType(.URL)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                    TextField("Enter Chain ID", text: $chainId)
                        .keyboardType(.numbersAndPunctuation)
                    TextField("Enter symbol", text: $currencySymbol)
                        .textInputAutocapitalization(.characters)
                    TextField("Add a URL", text: $blockExplorerURL)
                        .keyboardType(.URL)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                } header: {
                    Text("Network")
                } footer: {
                    Text("Default RPC URL and optional block explorer URL must use HTTPS in release builds.")
                }
                Section("Verification") {
                    Text(verificationText)
                        .foregroundColor(verifiedFingerprint.isEmpty ? Color.secondary : Color.green)
                    Button {
                        Task { await testRPC() }
                    } label: {
                        Label(isTesting ? "Testing RPC" : "Test RPC", systemImage: "checkmark.shield")
                    }
                    .disabled(isTesting)
                    Button {
                        addNetwork()
                    } label: {
                        Label("Add Network", systemImage: "plus.circle.fill")
                    }
                    .disabled(!canAdd)
                }
            }
            .navigationTitle("Add Network")
            .appInlineNavigationTitle()
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Close") { dismiss() }
                }
            }
            .onAppear(perform: prefillIfNeeded)
        }
    }

    private var canAdd: Bool {
        (try? currentFingerprint()) == verifiedFingerprint && !verifiedFingerprint.isEmpty
    }

    private var allowLocalURLs: Bool {
        #if DEBUG
        true
        #else
        false
        #endif
    }

    private func testRPC() async {
        do {
            let config = try buildDraft(source: sourceIntent == nil ? WalletNetworkConfig.sourceUser : WalletNetworkConfig.sourcePaymentRequest)
            let fingerprint = try currentFingerprint()
            isTesting = true
            verificationText = "Testing RPC chain ID..."
            let rpcChainId = try await WalletNetworkRPCVerifier.verifyEVMRPC(rpcURL: config.defaultRPCURL, expectedChainId: config.chainId)
            verifiedFingerprint = fingerprint
            verificationText = "RPC verified: \(rpcChainId) / Chain ID \(config.chainId)"
            isTesting = false
        } catch {
            verifiedFingerprint = ""
            verificationText = error.localizedDescription
            isTesting = false
        }
    }

    private func addNetwork() {
        do {
            guard try currentFingerprint() == verifiedFingerprint else {
                verificationText = "Test RPC again before adding."
                return
            }
            let source = sourceIntent == nil ? WalletNetworkConfig.sourceUser : WalletNetworkConfig.sourcePaymentRequest
            let config = try buildDraft(source: source)
            app.addNetwork(config)
            dismiss()
        } catch {
            verificationText = error.localizedDescription
        }
    }

    private func buildDraft(source: String) throws -> WalletNetworkConfig {
        try WalletNetworkValidator.buildVerifiedEVMConfig(
            name: networkName,
            rpcURL: rpcURL,
            chainId: chainId,
            currencySymbol: currencySymbol,
            blockExplorerURL: blockExplorerURL,
            source: source,
            allowLocalURLs: allowLocalURLs
        )
    }

    private func currentFingerprint() throws -> String {
        try WalletNetworkValidator.fingerprint(
            name: networkName,
            rpcURL: rpcURL,
            chainId: chainId,
            currencySymbol: currencySymbol,
            blockExplorerURL: blockExplorerURL
        )
    }

    private func prefillIfNeeded() {
        guard !didPrefill else { return }
        didPrefill = true
        guard let intent = sourceIntent else { return }
        networkName = defaultNetworkName(intent)
        rpcURL = firstNonEmpty(intent.rpcUrl, defaultRPCURL(intent))
        let id = intent.chainId > 0 ? intent.chainId : defaultChainId(intent)
        chainId = id > 0 ? "\(id)" : ""
        currencySymbol = defaultCurrencySymbol(intent)
        blockExplorerURL = defaultBlockExplorerURL(intent)
    }

    private func defaultNetworkName(_ intent: PaymentIntent) -> String {
        let lower = intent.network.lowercased()
        if lower.contains("base"), lower.contains("sepolia") { return "Base Sepolia" }
        if lower.contains("base") { return "Base" }
        if lower.contains("polygon") { return "Polygon" }
        if lower.contains("ethereum") || lower.contains("sepolia") { return "Ethereum Sepolia" }
        return titleize(intent.network.replacingOccurrences(of: "_", with: " "), fallback: "Custom EVM Network")
    }

    private func defaultChainId(_ intent: PaymentIntent) -> Int64 {
        let lower = intent.network.lowercased()
        if lower.contains("base"), lower.contains("sepolia") { return 84532 }
        if lower.contains("base") { return 8453 }
        if lower.contains("polygon") { return 137 }
        if lower.contains("sepolia") { return 11155111 }
        return 0
    }

    private func defaultRPCURL(_ intent: PaymentIntent) -> String {
        let lower = intent.network.lowercased()
        if lower.contains("base"), lower.contains("sepolia") { return "https://sepolia.base.org" }
        if lower.contains("base") { return "https://mainnet.base.org" }
        if lower.contains("polygon") { return "https://polygon-rpc.com" }
        return ""
    }

    private func defaultBlockExplorerURL(_ intent: PaymentIntent) -> String {
        let lower = intent.network.lowercased()
        if lower.contains("base"), lower.contains("sepolia") { return "https://sepolia.basescan.org" }
        if lower.contains("base") { return "https://basescan.org" }
        if lower.contains("polygon") { return "https://polygonscan.com" }
        if lower.contains("sepolia") { return "https://sepolia.etherscan.io" }
        return ""
    }

    private func defaultCurrencySymbol(_ intent: PaymentIntent) -> String {
        intent.network.lowercased().contains("polygon") ? "MATIC" : "ETH"
    }

    private func requestChainSuffix(_ intent: PaymentIntent) -> String {
        let id = intent.chainId > 0 ? intent.chainId : defaultChainId(intent)
        return id > 0 ? " / Chain ID \(id)" : ""
    }
}

struct PairingScannerSheet: View {
    @Environment(\.dismiss) private var dismiss
    let onCode: (String) -> Void

    var body: some View {
        NavigationStack {
            VStack(spacing: 16) {
                #if canImport(UIKit) && canImport(AVFoundation)
                PairingQRScanner(onCode: onCode)
                    .clipShape(RoundedRectangle(cornerRadius: 20))
                    .padding()
                #else
                ContentUnavailableView("Scanner unavailable", systemImage: "camera", description: Text("Enter the pairing URI or short code manually."))
                    .padding()
                #endif
                InfoCard(
                    title: "Scan to connect",
                    bodyText: "Scan a VelarumPay pairing QR. The next screen reviews agent identity and scopes before any permission is granted."
                )
                .padding(.horizontal)
            }
            .navigationTitle("Scan Pairing QR")
            .appInlineNavigationTitle()
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Close") { dismiss() }
                }
            }
        }
    }
}

#if canImport(UIKit) && canImport(AVFoundation)
struct PairingQRScanner: UIViewControllerRepresentable {
    let onCode: (String) -> Void

    func makeUIViewController(context: Context) -> QRScannerViewController {
        QRScannerViewController(onCode: onCode)
    }

    func updateUIViewController(_ uiViewController: QRScannerViewController, context: Context) {}
}

final class QRScannerViewController: UIViewController, AVCaptureMetadataOutputObjectsDelegate {
    private let onCode: (String) -> Void
    private let session = AVCaptureSession()
    private var previewLayer: AVCaptureVideoPreviewLayer?
    private var didEmitCode = false

    init(onCode: @escaping (String) -> Void) {
        self.onCode = onCode
        super.init(nibName: nil, bundle: nil)
    }

    required init?(coder: NSCoder) {
        nil
    }

    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = .black
        configureCamera()
    }

    override func viewDidLayoutSubviews() {
        super.viewDidLayoutSubviews()
        previewLayer?.frame = view.bounds
    }

    private func configureCamera() {
        switch AVCaptureDevice.authorizationStatus(for: .video) {
        case .authorized:
            startSession()
        case .notDetermined:
            AVCaptureDevice.requestAccess(for: .video) { [weak self] granted in
                DispatchQueue.main.async {
                    granted ? self?.startSession() : self?.showPermissionMessage()
                }
            }
        default:
            showPermissionMessage()
        }
    }

    private func startSession() {
        guard let device = AVCaptureDevice.default(for: .video),
              let input = try? AVCaptureDeviceInput(device: device),
              session.canAddInput(input) else {
            showPermissionMessage()
            return
        }
        session.addInput(input)
        let output = AVCaptureMetadataOutput()
        guard session.canAddOutput(output) else {
            showPermissionMessage()
            return
        }
        session.addOutput(output)
        output.setMetadataObjectsDelegate(self, queue: DispatchQueue.main)
        output.metadataObjectTypes = [.qr]
        let layer = AVCaptureVideoPreviewLayer(session: session)
        layer.videoGravity = .resizeAspectFill
        layer.frame = view.bounds
        view.layer.addSublayer(layer)
        previewLayer = layer
        DispatchQueue.global(qos: .userInitiated).async { [session] in
            session.startRunning()
        }
    }

    private func showPermissionMessage() {
        let label = UILabel()
        label.text = "Camera is required to scan QR codes."
        label.textColor = .white
        label.textAlignment = .center
        label.numberOfLines = 0
        label.translatesAutoresizingMaskIntoConstraints = false
        view.addSubview(label)
        NSLayoutConstraint.activate([
            label.leadingAnchor.constraint(equalTo: view.leadingAnchor, constant: 24),
            label.trailingAnchor.constraint(equalTo: view.trailingAnchor, constant: -24),
            label.centerYAnchor.constraint(equalTo: view.centerYAnchor)
        ])
    }

    func metadataOutput(_ output: AVCaptureMetadataOutput, didOutput metadataObjects: [AVMetadataObject], from connection: AVCaptureConnection) {
        guard !didEmitCode,
              let object = metadataObjects.compactMap({ $0 as? AVMetadataMachineReadableCodeObject }).first,
              let value = object.stringValue?.trimmingCharacters(in: .whitespacesAndNewlines),
              !value.isEmpty else {
            return
        }
        didEmitCode = true
        session.stopRunning()
        onCode(value)
    }
}
#endif

struct PairingReviewView: View {
    @EnvironmentObject private var app: AppState
    let session: PairingSession
    @State private var approvedScopes = Set<String>()

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 14) {
                    Text(session.displayName)
                        .font(.largeTitle.bold())
                    StatusPill(text: "\(session.status) / \(session.inputSource)")
                    FieldRow(title: "Runtime", value: session.runtime)
                    if !session.deviceLabel.isEmpty {
                        FieldRow(title: "Device label", value: session.deviceLabel)
                    }
                    if !session.source.isEmpty {
                        FieldRow(title: "Source", value: session.source)
                    }
                    FieldRow(title: "Expiration", value: dateText(session.expiresAtMs))
                    Text("Requested scopes")
                        .font(.headline)
                    ForEach(session.requestedScopes, id: \.self) { scope in
                        Toggle(isOn: Binding(
                            get: { approvedScopes.contains(scope) },
                            set: { isOn in
                                if isOn {
                                    approvedScopes.insert(scope)
                                } else {
                                    approvedScopes.remove(scope)
                                }
                            }
                        )) {
                            VStack(alignment: .leading, spacing: 3) {
                                Text(scopeDisplayName(scope))
                                Text(scope)
                                    .font(.caption.monospaced())
                                    .foregroundStyle(.secondary)
                            }
                        }
                    }
                    InfoCard(
                        title: "No signing permission",
                        bodyText: "Pairing is not payment approval. Agents can prepare requests or read their own status only; every payment still needs review and local signing on this device."
                    )
                    if !session.isPending {
                        InfoCard(title: "Session closed", bodyText: "This pairing session is \(session.status) and cannot be approved.")
                    }
                }
                .padding()
            }
            .navigationTitle("Pair Agent")
            .appInlineNavigationTitle()
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Close") { app.pairingSession = nil }
                }
            }
            .onAppear {
                if approvedScopes.isEmpty {
                    approvedScopes = Set(session.requestedScopes)
                }
            }
            .safeAreaInset(edge: .bottom) {
                if session.isPending {
                    FloatingActionBar {
                        HStack {
                            Button(role: .destructive) {
                                app.rejectPairing(session)
                            } label: {
                                Text("Reject").frame(maxWidth: .infinity)
                            }
                            .buttonStyle(.bordered)
                            Button {
                                app.approvePairing(session, scopes: approvedScopes)
                            } label: {
                                Text("Approve Selected").frame(maxWidth: .infinity)
                            }
                            .buttonStyle(.borderedProminent)
                        }
                    }
                }
            }
        }
    }
}

struct ConnectionDetailView: View {
    @EnvironmentObject private var app: AppState
    let connection: AgentConnection
    @State private var confirmingRevoke = false

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 14) {
                    Text(connection.displayName)
                        .font(.largeTitle.bold())
                    StatusPill(text: connection.status)
                    FieldRow(title: "Connection ID", value: connection.connectionId, copyAction: { app.copy(connection.connectionId) })
                    FieldRow(title: "Runtime", value: connection.runtime)
                    if !connection.deviceLabel.isEmpty {
                        FieldRow(title: "Device label", value: connection.deviceLabel)
                    }
                    if !connection.source.isEmpty {
                        FieldRow(title: "Source", value: connection.source)
                    }
                    FieldRow(title: "Approved scopes", value: connection.scopeSummary)
                    FieldRow(title: "Last activity", value: dateText(connection.lastActivityAtMs))
                    FieldRow(title: "Expiration", value: dateText(connection.expiresAtMs))
                    FieldRow(title: "Token status", value: "Stored locally / hidden")
                    InfoCard(
                        title: "User-controlled payments",
                        bodyText: "Signing permission is not available for agent connections. Paused or revoked connections cannot create standard requests."
                    )
                }
                .padding()
            }
            .navigationTitle("Agent")
            .appInlineNavigationTitle()
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Close") { app.selectedConnection = nil }
                }
            }
            .alert("Revoke connection?", isPresented: $confirmingRevoke) {
                Button("Cancel", role: .cancel) {}
                Button("Revoke", role: .destructive) { app.revokeConnection(connection) }
            } message: {
                Text("The agent will no longer be authorized to create standard requests with this token.")
            }
            .safeAreaInset(edge: .bottom) {
                if !connection.isRevoked {
                    FloatingActionBar {
                        HStack {
                            Button {
                                app.updateConnection(connection, status: connection.status == "paused" ? "active" : "paused")
                            } label: {
                                Text(connection.status == "paused" ? "Resume Agent" : "Pause Agent")
                                    .frame(maxWidth: .infinity)
                            }
                            .buttonStyle(.bordered)
                            Button(role: .destructive) {
                                confirmingRevoke = true
                            } label: {
                                Text("Revoke").frame(maxWidth: .infinity)
                            }
                            .buttonStyle(.borderedProminent)
                        }
                    }
                }
            }
        }
    }
}

struct PaymentDetailView: View {
    @EnvironmentObject private var app: AppState
    let intent: PaymentIntent
    @State private var showingWarningReview = false
    @State private var showingAddNetwork = false

    private var reviewState: String {
        let state = paymentReviewState(intent)
        if state == "network_disabled", app.isNetworkEnabled(for: intent) {
            return "pending"
        }
        return state
    }

    private var paymentReady: Bool {
        isPaymentDetailSignable(intent, state: reviewState)
    }

    private var backupGateRequired: Bool {
        WalletSecurityNavigationPolicy.requiresBackupGate(
            walletLoaded: app.wallet != nil,
            backupVerified: app.wallet?.isBackupVerified == true,
            paymentReady: paymentReady
        )
    }

    private var displayState: String {
        backupGateRequired ? WalletSecurityNavigationPolicy.backupRequiredReviewState : reviewState
    }

    private var canSign: Bool {
        WalletSecurityNavigationPolicy.canCreateSignature(
            walletLoaded: app.wallet != nil,
            backupVerified: app.wallet?.isBackupVerified == true,
            paymentReady: paymentReady
        )
    }

    private var requiresWarningStepUp: Bool {
        paymentRequiresWarningStepUp(intent)
    }

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 14) {
                    Text(intent.title)
                        .font(.largeTitle.bold())
                    HStack {
                        TonePill(text: paymentStatusLabel(displayState), tone: paymentTone(displayState, canSign: canSign))
                        TonePill(text: paymentRiskLabel(intent), tone: paymentRiskTone(intent))
                    }
                    Text(intent.summary)
                        .foregroundStyle(.secondary)
                    PaymentFactsCard(intent: intent)
                    PaymentStateCard(intent: intent, state: displayState, canSign: canSign)
                    TruthPanelCard(intent: intent)
                    PaymentContextCard(intent: intent)
                }
                .padding()
            }
            .navigationTitle("Payment")
            .appInlineNavigationTitle()
            .safeAreaInset(edge: .bottom) {
                FloatingActionBar {
                    PaymentDetailActions(
                        intent: intent,
                        state: displayState,
                        canSign: canSign,
                        requiresWarningStepUp: requiresWarningStepUp,
                        onReject: { app.reject(intent) },
                        onSign: { app.pay(intent) },
                        onReviewWarnings: { showingWarningReview = true },
                        onCopyTransaction: { app.copy(intent.txHash) },
                        onRequestContext: { app.statusText = "Context requested" },
                        onEnableNetwork: { showingAddNetwork = true },
                        onOpenSecurity: { app.openSecuritySettings() }
                    )
                }
            }
            .sheet(isPresented: $showingWarningReview) {
                WarningReviewSheet(intent: intent) {
                    showingWarningReview = false
                    app.pay(intent)
                }
                .presentationDetents([.medium, .large])
            }
            .sheet(isPresented: $showingAddNetwork) {
                AddNetworkSheet(sourceIntent: intent)
                    .environmentObject(app)
                    .presentationDetents([.large])
            }
        }
    }
}

struct PaymentFactsCard: View {
    @EnvironmentObject private var app: AppState
    let intent: PaymentIntent

    var body: some View {
        Card {
            VStack(alignment: .leading, spacing: 12) {
                SectionHeader(title: "Payment Facts", note: "hard fields")
                FieldRow(title: "Network", value: valueOr(intent.network, "Unknown network"))
                if intent.isStellarXLM {
                    // M-3: show the network resolved from the actual Horizon host —
                    // not just the requester's label — and the host itself, so a
                    // human can confirm real-money mainnet vs testnet before signing.
                    FieldRow(title: "Stellar network", value: intent.stellarTestnet ? "Testnet · test coins" : "Mainnet · real funds")
                    if let host = URL(string: intent.horizonUrl)?.host, !host.isEmpty {
                        FieldRow(title: "Horizon endpoint", value: host)
                    }
                }
                FieldRow(title: "Asset", value: valueOr(intent.asset, "Unknown asset"))
                FieldRow(title: "Amount", value: "\(valueOr(intent.amount, "0")) \(valueOr(intent.asset, ""))")
                FieldRow(title: "Recipient", value: valueOr(intent.to, "Missing recipient"), copyAction: intent.to.isEmpty ? nil : { app.copy(intent.to) })
                if !intent.payeeDisplayName.isEmpty {
                    FieldRow(title: "Payee", value: intent.payeeDisplayName)
                }
                if !intent.memo.isEmpty {
                    FieldRow(title: intent.memoFieldTitle, value: intent.memo, copyAction: { app.copy(intent.memo) })
                } else if paymentExpectsMemo(intent) {
                    // H-1: a memo-capable XLM payment with an empty memo must not be
                    // invisible. Always show the row as "Not provided" so a missing
                    // exchange/custodial deposit memo is obvious before signing.
                    FieldRow(title: intent.memoFieldTitle, value: "Not provided")
                }
                if !intent.estimatedFeeDisplay.isEmpty {
                    FieldRow(title: "Estimated fee", value: intent.estimatedFeeDisplay)
                }
                if !intent.tokenContract.isEmpty {
                    FieldRow(title: "Token contract", value: intent.tokenContract, copyAction: { app.copy(intent.tokenContract) })
                }
                if !intent.assetIssuer.isEmpty {
                    FieldRow(title: "Asset issuer", value: intent.assetIssuer, copyAction: { app.copy(intent.assetIssuer) })
                }
            }
        }
    }
}

struct PaymentStateCard: View {
    let intent: PaymentIntent
    let state: String
    let canSign: Bool

    var body: some View {
        Card {
            VStack(alignment: .leading, spacing: 10) {
                HStack(alignment: .top) {
                    VStack(alignment: .leading, spacing: 4) {
                        Text(paymentStateTitle(state, canSign: canSign))
                            .font(.headline)
                        Text(paymentStateCopy(intent, state: state, canSign: canSign))
                            .foregroundStyle(.secondary)
                    }
                    Spacer()
                    TonePill(text: paymentStatusLabel(state), tone: paymentTone(state, canSign: canSign))
                }
                ForEach(paymentRiskMessages(intent), id: \.self) { message in
                    RiskMessageRow(message: message, tone: message.lowercased().contains("blocked") ? "danger" : "caution")
                }
                if !intent.error.isEmpty {
                    RiskMessageRow(message: "Failure: \(intent.error)", tone: "danger")
                }
                if !intent.txHash.isEmpty {
                    FieldRow(title: "Transaction", value: intent.txHash)
                }
            }
        }
    }
}

struct TruthPanelCard: View {
    let intent: PaymentIntent

    private var sections: [TruthPanelSection] {
        truthPanelSections(for: intent)
    }

    var body: some View {
        Card {
            VStack(alignment: .leading, spacing: 12) {
                SectionHeader(title: "Truth Panel", note: "facts, claims, inference")
                if sections.isEmpty {
                    RiskMessageRow(
                        message: "Transaction context was not received. Payment Facts remain visible, but source evidence is unavailable.",
                        tone: "caution"
                    )
                } else {
                    ForEach(sections) { section in
                        TruthSectionView(section: section)
                    }
                }
            }
        }
    }
}

struct TruthSectionView: View {
    let section: TruthPanelSection

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack(alignment: .top) {
                VStack(alignment: .leading, spacing: 2) {
                    Text(section.title)
                        .font(.headline)
                    Text(section.note)
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
                Spacer()
                TonePill(text: truthToneLabel(section.tone), tone: section.tone)
            }
            ForEach(section.rows) { row in
                TruthRowView(row: row)
            }
        }
        .padding(12)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(toneBackground(section.tone), in: RoundedRectangle(cornerRadius: 16))
        .overlay(
            RoundedRectangle(cornerRadius: 16)
                .stroke(toneColor(section.tone).opacity(0.22), lineWidth: 1)
        )
    }
}

struct TruthRowView: View {
    let row: TruthPanelRow

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(alignment: .top) {
                VStack(alignment: .leading, spacing: 4) {
                    Text(row.field)
                        .font(.subheadline.bold())
                    Text(row.value)
                        .font(.system(.subheadline, design: .monospaced))
                        .textSelection(.enabled)
                }
                Spacer()
            }
            HStack {
                TonePill(text: row.source, tone: row.tone)
                TonePill(text: row.status, tone: row.tone)
            }
            if !row.evidence.isEmpty {
                Text(row.evidence)
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
        }
        .padding(12)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Color.appSystemBackground, in: RoundedRectangle(cornerRadius: 14))
    }
}

struct PaymentContextCard: View {
    let intent: PaymentIntent

    var body: some View {
        Card {
            VStack(alignment: .leading, spacing: 12) {
                SectionHeader(title: "Request Context", note: "agent and metadata")
                FieldRow(title: "Source", value: intent.sourceLabel)
                if !intent.transactionIdText.isEmpty {
                    FieldRow(title: "Transaction context", value: intent.transactionIdText)
                }
                if !intent.orderId.isEmpty {
                    FieldRow(title: "Order", value: intent.orderId)
                }
                if !intent.restaurantName.isEmpty {
                    FieldRow(title: "Merchant", value: firstNonEmpty(intent.restaurantName, intent.restaurantCuisine))
                }
                if !intent.orderTotalUsd.isEmpty {
                    FieldRow(title: "Order Total", value: "$\(intent.orderTotalUsd)")
                }
                if intent.orderId.isEmpty && intent.restaurantName.isEmpty && intent.transactionIdText.isEmpty {
                    Text("No additional context arrived with this request.")
                        .foregroundStyle(.secondary)
                }
            }
        }
    }
}

struct PaymentDetailActions: View {
    let intent: PaymentIntent
    let state: String
    let canSign: Bool
    let requiresWarningStepUp: Bool
    let onReject: () -> Void
    let onSign: () -> Void
    let onReviewWarnings: () -> Void
    let onCopyTransaction: () -> Void
    let onRequestContext: () -> Void
    let onEnableNetwork: () -> Void
    let onOpenSecurity: () -> Void

    var body: some View {
        VStack(spacing: 10) {
            if canSign {
                HStack {
                    Button(role: .destructive, action: onReject) {
                        Text("Reject").frame(maxWidth: .infinity)
                    }
                    .buttonStyle(.bordered)
                    Button(action: requiresWarningStepUp ? onReviewWarnings : onSign) {
                        Text(requiresWarningStepUp ? "Review warnings" : intent.payButtonTitle)
                            .frame(maxWidth: .infinity)
                    }
                    .buttonStyle(.borderedProminent)
                }
            } else {
                nonSigningActions
            }
        }
    }

    @ViewBuilder
    private var nonSigningActions: some View {
        let normalized = normalizeReviewState(state)
        if normalized == WalletSecurityNavigationPolicy.backupRequiredReviewState && intent.status == PaymentStatus.pending.rawValue {
            HStack {
                Button(action: onOpenSecurity) {
                    Text("Open Settings").frame(maxWidth: .infinity)
                }
                .buttonStyle(.borderedProminent)
                Button(role: .destructive, action: onReject) {
                    Text("Reject request").frame(maxWidth: .infinity)
                }
                .buttonStyle(.bordered)
            }
        } else if ["missing_context", "needs_review", "source_review_required"].contains(normalized) && intent.status == PaymentStatus.pending.rawValue {
            HStack {
                Button(action: onRequestContext) {
                    Text("Request context").frame(maxWidth: .infinity)
                }
                .buttonStyle(.borderedProminent)
                Button(role: .destructive, action: onReject) {
                    Text("Reject request").frame(maxWidth: .infinity)
                }
                .buttonStyle(.bordered)
            }
        } else if normalized == "blocked" && intent.status == PaymentStatus.pending.rawValue {
            Button(role: .destructive, action: onReject) {
                Text("Reject request").frame(maxWidth: .infinity)
            }
            .buttonStyle(.borderedProminent)
        } else if normalized == "network_disabled" && intent.status == PaymentStatus.pending.rawValue {
            HStack {
                Button(action: onEnableNetwork) {
                    Text("Enable network").frame(maxWidth: .infinity)
                }
                .buttonStyle(.borderedProminent)
                Button(role: .destructive, action: onReject) {
                    Text("Reject request").frame(maxWidth: .infinity)
                }
                .buttonStyle(.bordered)
            }
        } else if normalized == "failed" {
            InfoCard(title: "Retry requires review", bodyText: "Retry only after re-checking fee, recipient, and the prior transaction state.")
        } else if normalized == "broadcasting" || normalized == "signed_locally" || normalized == "confirmed" {
            Button(action: onCopyTransaction) {
                Label("Copy transaction", systemImage: "doc.on.doc")
                    .frame(maxWidth: .infinity)
            }
            .buttonStyle(.bordered)
            .disabled(intent.txHash.isEmpty)
        } else if normalized == "expired" {
            InfoCard(title: "Approval window closed", bodyText: "Ask the agent to create a new request if payment is still needed.")
        } else if normalized == "rejected" {
            InfoCard(title: "Rejected", bodyText: "Nothing was signed, and the agent cannot reuse this approval.")
        } else {
            InfoCard(title: "Not signable", bodyText: paymentBlockedReason(intent))
        }
    }
}

struct WarningReviewSheet: View {
    @Environment(\.dismiss) private var dismiss
    let intent: PaymentIntent
    let onAccept: () -> Void

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 14) {
                    Text("Review before signing")
                        .font(.largeTitle.bold())
                    Text("Some context is unverified or AI-only. Continue only if you accept those limits.")
                        .foregroundStyle(.secondary)
                    Card {
                        VStack(alignment: .leading, spacing: 12) {
                            SectionHeader(title: "On-chain action", note: "final check")
                            FieldRow(title: "Payee", value: valueOr(intent.payeeDisplayName, "Unknown payee"))
                            FieldRow(title: "Recipient", value: valueOr(intent.to, "Missing recipient"))
                            FieldRow(title: "Network", value: valueOr(intent.network, "Unknown network"))
                            FieldRow(title: "Total", value: intent.totalDisplay)
                            FieldRow(title: "Key source", value: "Encrypted local keyring")
                        }
                    }
                    Card {
                        VStack(alignment: .leading, spacing: 10) {
                            SectionHeader(title: "Warnings", note: "explicit acceptance required")
                            ForEach(paymentWarningMessages(intent), id: \.self) { message in
                                RiskMessageRow(message: message, tone: "caution")
                            }
                        }
                    }
                }
                .padding()
            }
            .navigationTitle("Warning Review")
            .appInlineNavigationTitle()
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") { dismiss() }
                }
            }
            .safeAreaInset(edge: .bottom) {
                FloatingActionBar {
                    Button {
                        onAccept()
                    } label: {
                        Text("Accept unverified context and Sign")
                            .frame(maxWidth: .infinity)
                    }
                    .buttonStyle(.borderedProminent)
                    .controlSize(.large)
                }
            }
        }
    }
}

struct RiskMessageRow: View {
    let message: String
    let tone: String

    var body: some View {
        HStack(alignment: .top, spacing: 10) {
            Image(systemName: tone == "danger" ? "xmark.octagon.fill" : "exclamationmark.triangle.fill")
                .foregroundStyle(toneColor(tone))
            Text(message)
                .font(.subheadline)
                .foregroundStyle(.primary)
        }
        .padding(12)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(toneBackground(tone), in: RoundedRectangle(cornerRadius: 14))
    }
}

struct SectionHeader: View {
    let title: String
    let note: String

    var body: some View {
        HStack(alignment: .firstTextBaseline) {
            Text(title)
                .font(.headline)
            Spacer()
            Text(note)
                .font(.caption)
                .foregroundStyle(.secondary)
        }
    }
}

struct PaymentProgressView: View {
    @EnvironmentObject private var app: AppState
    let progress: PaymentProgress

    var body: some View {
        VStack(alignment: .leading, spacing: 18) {
            Capsule()
                .fill(Color.secondary.opacity(0.35))
                .frame(width: 56, height: 5)
                .frame(maxWidth: .infinity)
            Text(progress.title)
                .font(.largeTitle.bold())
            Text(progress.message)
                .foregroundStyle(.secondary)
            if let detail = progress.detail, !detail.isEmpty {
                FieldRow(title: progress.canDismiss ? "Transaction result" : "Local transaction", value: detail, copyAction: { app.copy(detail) })
            }
            if progress.canDismiss {
                Button {
                    app.closeProgress()
                } label: {
                    Text("Done").frame(maxWidth: .infinity)
                }
                .buttonStyle(.borderedProminent)
                .controlSize(.large)
            } else {
                ProgressView()
                    .frame(maxWidth: .infinity)
            }
        }
        .padding()
    }
}

struct HeaderCard: View {
    let title: String
    let subtitle: String
    let status: String

    var body: some View {
        Card {
            HStack(alignment: .top) {
                VStack(alignment: .leading, spacing: 4) {
                    Text(title)
                        .font(.largeTitle.bold())
                    Text(subtitle)
                        .foregroundStyle(.secondary)
                }
                Spacer()
                StatusPill(text: status)
            }
        }
    }
}

struct AddressCard: View {
    @EnvironmentObject private var app: AppState
    let title: String
    let address: String
    let note: String

    var body: some View {
        Card {
            VStack(alignment: .leading, spacing: 12) {
                HStack {
                    Text(title).font(.title2.bold())
                    Spacer()
                    Button("Copy") { app.copy(address) }
                        .buttonStyle(.bordered)
                }
                // M-5: a scannable QR code so the recipient never has to hand-copy a
                // 56-character address (a single wrong character sends funds nowhere).
                if !address.isEmpty {
                    HStack {
                        Spacer()
                        QRCodeImage(payload: address)
                        Spacer()
                    }
                }
                Text(address)
                    .font(.system(.body, design: .monospaced))
                    .textSelection(.enabled)
                    .padding()
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .background(Color.appSecondaryGroupedBackground, in: RoundedRectangle(cornerRadius: 16))
                Text(note)
                    .foregroundStyle(.secondary)
            }
        }
    }
}

/// M-5: renders a QR code for a receive address. Black modules on a white tile so
/// it scans in both light and dark mode; `.interpolation(.none)` keeps the modules
/// crisp when scaled. Falls back to nothing if generation fails (the copyable text
/// address below it is always available).
struct QRCodeImage: View {
    let payload: String

    var body: some View {
        if let cgImage = Self.make(from: payload) {
            Image(decorative: cgImage, scale: 1)
                .interpolation(.none)
                .resizable()
                .scaledToFit()
                .frame(width: 180, height: 180)
                .padding(12)
                .background(Color.white, in: RoundedRectangle(cornerRadius: 16))
                .accessibilityLabel("QR code for the receive address")
        }
    }

    private static func make(from string: String) -> CGImage? {
        guard let filter = CIFilter(name: "CIQRCodeGenerator") else { return nil }
        filter.setValue(Data(string.utf8), forKey: "inputMessage")
        filter.setValue("M", forKey: "inputCorrectionLevel")
        guard let output = filter.outputImage else { return nil }
        let scaled = output.transformed(by: CGAffineTransform(scaleX: 10, y: 10))
        return CIContext().createCGImage(scaled, from: scaled.extent)
    }
}

struct PaymentIntentRow: View {
    let intent: PaymentIntent

    private var state: String {
        paymentReviewState(intent)
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack {
                Text(intent.title)
                    .font(.headline)
                Spacer()
                Text("-\(intent.amount) \(intent.asset)")
                    .font(.subheadline.bold())
                    .foregroundStyle(.green)
            }
            HStack {
                TonePill(text: paymentStatusLabel(state), tone: paymentTone(state, canSign: isPaymentDetailSignable(intent)))
                TonePill(text: paymentRiskLabel(intent), tone: paymentRiskTone(intent))
            }
            Text(intent.summary)
                .font(.subheadline)
                .foregroundStyle(.secondary)
            Text("\(valueOr(intent.payeeDisplayName, "Unknown payee")) / \(valueOr(intent.network, "Unknown network"))")
                .font(.caption)
                .foregroundStyle(.secondary)
            Text(shortAddress(intent.to))
                .font(.caption.monospaced())
                .foregroundStyle(.secondary)
            HStack {
                Text("Context: \(paymentContextLabel(intent, state: state))")
                Spacer()
                Text(paymentWindowText(intent, state: state))
            }
            .font(.caption)
            .foregroundStyle(.secondary)
        }
        .padding(.vertical, 6)
    }
}

struct ConnectionRow: View {
    let connection: AgentConnection

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack {
                Text(connection.displayName)
                    .font(.headline)
                Spacer()
                StatusPill(text: connection.status)
            }
            Text(firstNonEmpty(connection.deviceLabel, connection.runtime))
                .font(.caption)
                .foregroundStyle(.secondary)
            Text(connection.scopeSummary)
                .font(.caption.monospaced())
                .foregroundStyle(.secondary)
                .lineLimit(2)
        }
        .padding(.vertical, 6)
    }
}

struct HistoryRow: View {
    let item: HistoryEntry

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack {
                Text(item.title)
                    .font(.headline)
                Spacer()
                Text("-\(item.amount) \(item.asset)")
                    .font(.subheadline.bold())
                    .foregroundStyle(.green)
            }
            StatusPill(text: "\(item.network) / \(item.status)")
            Text(Date(timeIntervalSince1970: Double(item.createdAtMs) / 1000), style: .date)
                .font(.caption)
                .foregroundStyle(.secondary)
            if !item.to.isEmpty {
                Text("To \(shortAddress(item.to))")
                    .font(.caption.monospaced())
                    .foregroundStyle(.secondary)
            }
            if !item.txHash.isEmpty {
                Text("Tx \(shortAddress(item.txHash))")
                    .font(.caption.monospaced())
                    .foregroundStyle(.blue)
            }
        }
        .padding(.vertical, 6)
    }
}

struct FieldRow: View {
    let title: String
    let value: String
    var copyAction: (() -> Void)?

    init(title: String, value: String, copyAction: (() -> Void)? = nil) {
        self.title = title
        self.value = value
        self.copyAction = copyAction
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack {
                Text(title)
                    .font(.caption.bold())
                    .foregroundStyle(.secondary)
                Spacer()
                if let copyAction {
                    Button("Copy", action: copyAction)
                        .font(.caption.bold())
                }
            }
            Text(value)
                .font(.system(.body, design: .monospaced))
                .textSelection(.enabled)
                .padding(12)
                .frame(maxWidth: .infinity, alignment: .leading)
                .background(Color.appSecondaryGroupedBackground, in: RoundedRectangle(cornerRadius: 14))
        }
    }
}

struct StatusPill: View {
    let text: String

    var body: some View {
        Text(text.isEmpty ? "Ready" : text)
            .font(.caption.bold())
            .padding(.horizontal, 12)
            .padding(.vertical, 7)
            .background(Color.green.opacity(0.12), in: Capsule())
            .foregroundStyle(.green)
    }
}

struct TonePill: View {
    let text: String
    let tone: String

    var body: some View {
        Text(text.isEmpty ? "Info" : text)
            .font(.caption.bold())
            .padding(.horizontal, 10)
            .padding(.vertical, 6)
            .background(toneBackground(tone), in: Capsule())
            .foregroundStyle(toneColor(tone))
    }
}

struct InfoCard: View {
    let title: String
    let bodyText: String

    var body: some View {
        Card {
            VStack(alignment: .leading, spacing: 8) {
                Text(title).font(.headline)
                Text(bodyText).foregroundStyle(.secondary)
            }
        }
    }
}

struct Card<Content: View>: View {
    @ViewBuilder var content: Content

    var body: some View {
        content
            .padding()
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(Color.appSystemBackground, in: RoundedRectangle(cornerRadius: 24))
            .overlay(
                RoundedRectangle(cornerRadius: 24)
                    .stroke(Color.appSeparator.opacity(0.3), lineWidth: 1)
            )
    }
}

struct FloatingActionBar<Content: View>: View {
    @ViewBuilder var content: Content

    var body: some View {
        content
            .padding(.horizontal)
            .padding(.top, 12)
            .padding(.bottom, 12)
            .frame(maxWidth: .infinity)
            .background(Color.appSystemBackground)
            .overlay(alignment: .top) {
                Divider()
            }
    }
}

extension Array where Element == HistoryEntry {
    func uniquedById() -> [HistoryEntry] {
        var seen = Set<String>()
        var output: [HistoryEntry] = []
        for item in self where !seen.contains(item.id) {
            seen.insert(item.id)
            output.append(item)
        }
        return output
    }
}

enum InboxFilter: String, CaseIterable, Identifiable {
    case pending = "Pending"
    case all = "All"
    case final = "Final"

    var id: String { rawValue }

    func matches(_ intent: PaymentIntent) -> Bool {
        let state = paymentReviewState(intent)
        switch self {
        case .all:
            return true
        case .final:
            return isFinalReviewState(state)
        case .pending:
            return isActiveInboxState(state)
        }
    }
}

struct InboxSection: Identifiable {
    var id: String
    var title: String
    var items: [PaymentIntent]

    static func sections(for items: [PaymentIntent], filter: InboxFilter) -> [InboxSection] {
        let order: [(String, String)] = [
            ("risk", "Risk review"),
            ("pending", "Awaiting signature"),
            ("execution", "Execution follow-up"),
            ("final", "Final outcomes"),
            ("other", "Other requests")
        ]
        return order.compactMap { id, title in
            let bucket = items.filter { inboxSectionId($0, filter: filter) == id }
            return bucket.isEmpty ? nil : InboxSection(id: id, title: title, items: bucket)
        }
    }

    private static func inboxSectionId(_ intent: PaymentIntent, filter: InboxFilter) -> String {
        let state = paymentReviewState(intent)
        if isFinalReviewState(state) { return "final" }
        if ["blocked", "missing_context", "needs_review", "source_review_required", "network_disabled"].contains(state) {
            return "risk"
        }
        if ["broadcasting", "signed_locally", "failed"].contains(state) { return "execution" }
        if ["pending", "awaiting_signature"].contains(state) { return "pending" }
        return filter == .final ? "final" : "other"
    }
}

struct TruthPanelSection: Identifiable {
    var id: String { title }
    var title: String
    var note: String
    var tone: String
    var rows: [TruthPanelRow]
}

struct TruthPanelRow: Identifiable {
    var id: String { [field, value, source, status, evidence].joined(separator: "|") }
    var field: String
    var value: String
    var source: String
    var status: String
    var evidence: String
    var tone: String
}

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

extension Color {
    static var appGroupedBackground: Color {
        #if canImport(UIKit)
        Color(UIColor.systemGroupedBackground)
        #elseif canImport(AppKit)
        Color(NSColor.windowBackgroundColor)
        #else
        Color.gray.opacity(0.08)
        #endif
    }

    static var appSecondaryGroupedBackground: Color {
        #if canImport(UIKit)
        Color(UIColor.secondarySystemGroupedBackground)
        #elseif canImport(AppKit)
        Color(NSColor.controlBackgroundColor)
        #else
        Color.gray.opacity(0.12)
        #endif
    }

    static var appSystemBackground: Color {
        #if canImport(UIKit)
        Color(UIColor.systemBackground)
        #elseif canImport(AppKit)
        Color(NSColor.windowBackgroundColor)
        #else
        Color.white
        #endif
    }

    static var appSeparator: Color {
        #if canImport(UIKit)
        Color(UIColor.separator)
        #elseif canImport(AppKit)
        Color(NSColor.separatorColor)
        #else
        Color.gray
        #endif
    }
}

extension View {
    @ViewBuilder
    func relayURLInputStyle() -> some View {
        #if canImport(UIKit)
        self.textInputAutocapitalization(.never)
            .keyboardType(.URL)
        #else
        self
        #endif
    }

    @ViewBuilder
    func appInlineNavigationTitle() -> some View {
        #if canImport(UIKit)
        self.navigationBarTitleDisplayMode(.inline)
        #else
        self
        #endif
    }
}
