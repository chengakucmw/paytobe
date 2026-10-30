// Settings & network-config views
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

struct SettingsView: View {
    @EnvironmentObject private var app: AppState
    @State private var relayDraft = ""
    @State private var showingBackup = false
    @State private var showingImport = false
    @State private var showingAddNetwork = false

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    ProfileIdentityHeader()
                }
                .listRowBackground(Color.clear)
                Section("Security") {
                    Text("Settings > Security is the only place for wallet creation, recovery phrase backup, import, and recovery flows. Signing stays locked until the offline backup is verified.")
                        .font(.footnote)
                        .foregroundStyle(VPColor.textMuted)
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
                        .foregroundStyle(VPColor.textMuted)
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
                    Button {
                        app.createConnectInvitation()
                    } label: {
                        Label(app.isCreatingConnectKey ? "Creating Connect Key…" : "Create one-time Connect Key", systemImage: "link.badge.plus")
                    }
                    .disabled(app.isCreatingConnectKey)
                    TextField("Pairing short code or Paytobe://pair URI", text: $app.pairingInput)
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
                        .foregroundStyle(VPColor.textMuted)
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
                        .foregroundStyle(VPColor.textMuted)
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
            .scrollContentBackground(.hidden)
            .background(VPColor.surfacePage.ignoresSafeArea())
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

/// Profile identity header (avatar + copyable address) — matches prototype 18.
struct ProfileIdentityHeader: View {
    @EnvironmentObject private var app: AppState
    var body: some View {
        VStack(spacing: VPSpace.s3) {
            ZStack {
                Circle()
                    .fill(LinearGradient(colors: [VPColor.teal400, VPColor.teal700], startPoint: .topLeading, endPoint: .bottomTrailing))
                    .frame(width: 72, height: 72)
                Text("V").font(VPType.display(30, .bold)).foregroundStyle(.white)
            }
            if let wallet = app.wallet {
                Button { app.copy(wallet.address) } label: {
                    HStack(spacing: 6) {
                        Text(shortAddress(wallet.address)).font(VPType.mono(14))
                        Image(systemName: "doc.on.doc").font(.system(size: 12, weight: .semibold))
                    }
                    .foregroundStyle(VPColor.textSecondary)
                    .padding(.horizontal, 12).padding(.vertical, 6)
                    .background(VPColor.surfaceSunken, in: Capsule())
                }
                .buttonStyle(.plain)
            } else {
                Text("No wallet yet").font(VPType.sans(14)).foregroundStyle(VPColor.textMuted)
            }
        }
        .frame(maxWidth: .infinity)
        .padding(.vertical, VPSpace.s2)
    }
}

struct NetworkConfigRow: View {
    let network: WalletNetworkConfig

    var body: some View {
        HStack(alignment: .top, spacing: 12) {
            Image(systemName: network.source == WalletNetworkConfig.sourceBuiltIn ? "checkmark.seal.fill" : "network")
                .foregroundStyle(VPColor.positive)
            VStack(alignment: .leading, spacing: 4) {
                Text(network.name)
                    .font(.headline)
                Text(network.displayLine)
                    .font(.caption)
                    .foregroundStyle(VPColor.textMuted)
                if !network.defaultRPCURL.isEmpty {
                    Text(network.defaultRPCURL)
                        .font(.caption.monospaced())
                        .foregroundStyle(VPColor.textMuted)
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
                            .foregroundStyle(VPColor.textMuted)
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
                        .foregroundColor(verifiedFingerprint.isEmpty ? VPColor.textMuted : VPColor.positive)
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
