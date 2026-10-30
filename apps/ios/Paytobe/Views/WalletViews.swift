// Wallet & recovery-phrase views
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

/// Home / Wallet tab — restyled 2026-06-20 to the Velar Teal design system
/// (prototypes/html20260620 · screens/04-home.html). Visual only: every value
/// is read from the real AppState, no mock data is introduced.
struct WalletView: View {
    @EnvironmentObject private var app: AppState
    @State private var tokenSend: TokenSendRequest?

    var body: some View {
        ScrollView {
            VStack(spacing: VPSpace.s4) {
                VPBrandHeader(
                    onScan: { app.showingPairingScanner = true },
                    onInbox: { app.selectedTab = .inbox },
                    inboxBadge: !app.inbox.isEmpty
                )
                walletHero
                if !app.inbox.isEmpty { pendingTeaser }
                accountSection
                agentsSection
                WalletRelayCard()
            }
            .padding(.horizontal, VPSpace.s5)
            .padding(.top, VPSpace.s2)
            .padding(.bottom, VPSpace.s8)
        }
        .background(VPColor.surfacePage.ignoresSafeArea())
        .task { app.refreshBalances() }
        .sheet(item: $tokenSend) { request in
            SendTokenView(
                request: request,
                wallet: app.wallet,
                evmNetworks: app.networks.filter { $0.family == WalletNetworkConfig.familyEVM }
            )
        }
    }

    // Hero balance/status card (teal→ink gradient).
    private var walletHero: some View {
        VPHeroCard {
            VStack(alignment: .leading, spacing: VPSpace.s3) {
                HStack {
                    Text("STELLAR WALLET")
                        .font(VPType.sans(12, .bold))
                        .tracking(1.2)
                        .foregroundStyle(.white.opacity(0.72))
                    Spacer()
                    VPGlassChip(text: "Stellar mainnet")
                }
                if let wallet = app.wallet {
                    Text(shortAddress(wallet.address))
                        .font(VPType.mono(26, .semibold))
                        .foregroundStyle(.white)
                        .padding(.top, VPSpace.s1)
                    HStack(spacing: VPSpace.s2) {
                        VPBadge(
                            text: wallet.isBackupVerified ? "Backed up" : "Backup required",
                            tone: wallet.isBackupVerified ? .positive : .warning,
                            showDot: true
                        )
                        Button {
                            app.copy(wallet.address)
                        } label: {
                            HStack(spacing: 6) {
                                Text("Copy address").font(VPType.sans(13, .semibold))
                                Image(systemName: "doc.on.doc").font(.system(size: 12, weight: .semibold))
                            }
                            .foregroundStyle(.white)
                            .padding(.horizontal, 12).padding(.vertical, 6)
                            .background(.white.opacity(0.16), in: Capsule())
                        }
                        .buttonStyle(.plain)
                    }
                } else {
                    Text("No wallet yet")
                        .font(VPType.display(28, .semibold))
                        .foregroundStyle(.white)
                        .padding(.top, VPSpace.s1)
                    Text("Create or import in Settings → Security")
                        .font(VPType.sans(14))
                        .foregroundStyle(.white.opacity(0.78))
                }
                HStack(spacing: VPSpace.s2) {
                    VPQuickAction(icon: "qrcode", label: "Receive", onHero: true) { app.copy(app.wallet?.address ?? "") }
                    VPQuickAction(icon: "antenna.radiowaves.left.and.right", label: "Register", onHero: true) { app.registerRelay() }
                    VPQuickAction(icon: "arrow.clockwise", label: "Sync", onHero: true) { app.syncInbox(); app.refreshBalances() }
                    VPQuickAction(icon: "gearshape", label: "Settings", onHero: true) { app.openSecuritySettings() }
                }
                .padding(.top, VPSpace.s3)
            }
        }
    }

    // Pending-requests teaser (ink card → Inbox tab).
    private var pendingTeaser: some View {
        Button {
            app.selectedTab = .inbox
        } label: {
            HStack(spacing: VPSpace.s3) {
                ZStack {
                    Circle().fill(.white.opacity(0.12)).frame(width: 44, height: 44)
                    Image(systemName: "tray.full").font(.system(size: 18, weight: .semibold)).foregroundStyle(VPColor.mint)
                }
                VStack(alignment: .leading, spacing: 2) {
                    Text("\(app.inbox.count) request\(app.inbox.count == 1 ? "" : "s") awaiting review")
                        .font(VPType.sans(16, .semibold)).foregroundStyle(.white)
                    Text("Tap to review before signing")
                        .font(VPType.sans(13)).foregroundStyle(.white.opacity(0.7))
                }
                Spacer()
                VPBadge(text: "Review", tone: .warning)
            }
            .padding(VPSpace.s5)
            .frame(maxWidth: .infinity)
            .background(VPColor.surfaceInk, in: RoundedRectangle(cornerRadius: VPRadius.lg))
        }
        .buttonStyle(.plain)
    }

    // Assets — bound (token + network) rows. One address can back several assets
    // (e.g. "ETH · Ethereum" and "USDC · Base" both use the EVM address).
    private var accountSection: some View {
        VStack(alignment: .leading, spacing: VPSpace.s2) {
            VPSectionHeader(title: "Assets")
            if let wallet = app.wallet {
                Button {
                    app.copy(wallet.address)
                } label: {
                    HStack(spacing: VPSpace.s3) {
                        VPTokenBadge(symbol: WalletAssetRegistry.xlm.symbol, gradient: WalletAssetRegistry.xlm.gradient)
                        VStack(alignment: .leading, spacing: 2) {
                            Text(WalletAssetRegistry.xlm.displayName).font(VPType.sans(16, .semibold)).foregroundStyle(VPColor.textPrimary)
                            Text("\(app.assetBalances[WalletAssetRegistry.xlm.id] ?? "0") XLM · \(shortAddress(wallet.address))").font(VPType.mono(13)).foregroundStyle(VPColor.textMuted)
                        }
                        Spacer()
                        VPBadge(text: "Mainnet", tone: .brand)
                    }
                    .padding(VPSpace.s4)
                    .frame(maxWidth: .infinity)
                    .background(VPColor.surfaceCard, in: RoundedRectangle(cornerRadius: VPRadius.lg))
                    .overlay(RoundedRectangle(cornerRadius: VPRadius.lg).stroke(VPColor.borderSubtle, lineWidth: 1))
                }
                .buttonStyle(.plain)
                // EVM + Solana addresses from the shared wallet core (wallet.evmAddress / .solanaAddress).
                if let evm = wallet.evmAddress {
                    otherChainRow(kind: .evm, symbol: WalletAssetRegistry.ethereum.symbol,
                                  name: WalletAssetRegistry.ethereum.displayName, address: evm,
                                  gradient: WalletAssetRegistry.ethereum.gradient,
                                  balance: app.assetBalances[WalletAssetRegistry.ethereum.id] ?? "0",
                                  sendRequest: { makeRequest(for: WalletAssetRegistry.ethereum, fromAddress: evm) })
                    // USDC on Base is a distinct bound asset (same EVM address, different contract).
                    otherChainRow(kind: .evm, symbol: WalletAssetRegistry.usdcBase.symbol,
                                  name: WalletAssetRegistry.usdcBase.displayName, address: evm,
                                  gradient: WalletAssetRegistry.usdcBase.gradient,
                                  balance: app.assetBalances[WalletAssetRegistry.usdcBase.id] ?? "0",
                                  sendRequest: { makeRequest(for: WalletAssetRegistry.usdcBase, fromAddress: evm) })
                }
                if let sol = wallet.solanaAddress {
                    otherChainRow(kind: .solana, symbol: WalletAssetRegistry.sol.symbol,
                                  name: WalletAssetRegistry.sol.displayName, address: sol,
                                  gradient: WalletAssetRegistry.sol.gradient,
                                  balance: app.assetBalances[WalletAssetRegistry.sol.id] ?? "0",
                                  sendRequest: { makeRequest(for: WalletAssetRegistry.sol, fromAddress: sol) })
                }
            } else {
                emptyHint("No account yet", "Set up a wallet to see your Stellar address here.")
            }
        }
    }

    // An EVM/Solana address row, with copy + send actions.
    private func otherChainRow(kind: TokenSendKind, symbol: String, name: String, address: String, gradient: [Color], balance: String = "0", sendRequest: (() -> TokenSendRequest)? = nil) -> some View {
        HStack(spacing: VPSpace.s3) {
            VPTokenBadge(symbol: symbol, gradient: gradient)
            VStack(alignment: .leading, spacing: 2) {
                Text(name).font(VPType.sans(16, .semibold)).foregroundStyle(VPColor.textPrimary)
                Text("\(balance) \(symbol) · \(shortAddress(address))").font(VPType.mono(13)).foregroundStyle(VPColor.textMuted)
            }
            Spacer()
            Button {
                app.copy(address)
            } label: {
                Image(systemName: "doc.on.doc").font(.system(size: 14, weight: .semibold))
                    .foregroundStyle(VPColor.textMuted)
                    .padding(8)
            }
            .buttonStyle(.plain)
            if let sendRequest {
                Button {
                    tokenSend = sendRequest()
                } label: {
                    Text("Send").font(VPType.sans(13, .semibold)).foregroundStyle(.white)
                        .padding(.horizontal, 14).padding(.vertical, 7)
                        .background(VPColor.surfaceInk, in: Capsule())
                }
                .buttonStyle(.plain)
            } else {
                // Bound asset whose on-device send isn't available yet. Receive still works via Copy.
                Text("Soon").font(VPType.sans(13, .semibold)).foregroundStyle(VPColor.textMuted)
                    .padding(.horizontal, 14).padding(.vertical, 7)
                    .background(VPColor.surfaceSunken, in: Capsule())
            }
        }
        .padding(VPSpace.s4)
        .frame(maxWidth: .infinity)
        .background(VPColor.surfaceCard, in: RoundedRectangle(cornerRadius: VPRadius.lg))
        .overlay(RoundedRectangle(cornerRadius: VPRadius.lg).stroke(VPColor.borderSubtle, lineWidth: 1))
    }

    // Build a bound send request from a registry asset (single source). EVM RPC is resolved from
    // the device's network list by the asset's chainId, falling back to the asset's own RPC.
    private func makeRequest(for asset: WalletAsset, fromAddress: String) -> TokenSendRequest {
        let kind = asset.kind ?? .evm
        let rpc: String
        let chainId: Int64
        switch kind {
        case .solana:
            rpc = SolanaService.mainnetRPC
            chainId = 0
        case .evm:
            let net = app.networks.first { $0.family == WalletNetworkConfig.familyEVM && $0.chainId == asset.chainId }
            let netRpc = net?.defaultRPCURL ?? ""
            rpc = netRpc.isEmpty ? asset.fallbackRpc : netRpc
            chainId = asset.chainId
        }
        return TokenSendRequest(kind: kind, symbol: asset.symbol, chainName: asset.chainName,
                                fromAddress: fromAddress, rpcURL: rpc, chainId: chainId,
                                tokenContract: asset.tokenContract, decimals: asset.decimals)
    }

    // Connected agents.
    private var agentsSection: some View {
        VStack(alignment: .leading, spacing: VPSpace.s2) {
            VPSectionHeader(title: "Connected agents")
            if app.connections.isEmpty {
                emptyHint("No agents connected", "Scan an agent's code to grant scoped, revocable access.")
            } else {
                VStack(spacing: VPSpace.s2) {
                    ForEach(app.connections) { connection in
                        Button {
                            app.selectedConnection = connection
                        } label: {
                            HStack(spacing: VPSpace.s3) {
                                ZStack {
                                    RoundedRectangle(cornerRadius: VPRadius.sm).fill(VPColor.brandSoft).frame(width: 38, height: 38)
                                    Image(systemName: "cpu").font(.system(size: 16, weight: .semibold)).foregroundStyle(VPColor.textBrand)
                                }
                                VStack(alignment: .leading, spacing: 2) {
                                    Text(connection.displayName).font(VPType.sans(16, .semibold)).foregroundStyle(VPColor.textPrimary)
                                    Text(connection.status).font(VPType.sans(13)).foregroundStyle(VPColor.textMuted)
                                }
                                Spacer()
                                VPBadge(text: "Active", tone: .positive, showDot: true)
                            }
                            .padding(VPSpace.s4)
                            .frame(maxWidth: .infinity)
                            .background(VPColor.surfaceCard, in: RoundedRectangle(cornerRadius: VPRadius.lg))
                            .overlay(RoundedRectangle(cornerRadius: VPRadius.lg).stroke(VPColor.borderSubtle, lineWidth: 1))
                        }
                        .buttonStyle(.plain)
                    }
                }
            }
        }
    }

    private func emptyHint(_ title: String, _ subtitle: String) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(title).font(VPType.sans(15, .semibold)).foregroundStyle(VPColor.textSecondary)
            Text(subtitle).font(VPType.sans(13)).foregroundStyle(VPColor.textMuted)
        }
        .padding(VPSpace.s4)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(VPColor.surfaceSunken, in: RoundedRectangle(cornerRadius: VPRadius.lg))
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
                    .foregroundStyle(VPColor.textMuted)
                Button {
                    app.openSecuritySettings()
                } label: {
                    Label("Open Settings", systemImage: "gearshape")
                        .frame(maxWidth: .infinity)
                }
                .buttonStyle(VPButtonStyle(kind: .primary))
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
                Text("Register this device with a Paytobe relay, connect trusted agents, then review incoming requests before signing.")
                    .foregroundStyle(VPColor.textMuted)
                HStack {
                    Button {
                        app.registerRelay()
                    } label: {
                        Label("Register", systemImage: "antenna.radiowaves.left.and.right")
                    }
                    .buttonStyle(VPButtonStyle(kind: .primary))
                    Button {
                        app.syncInbox()
                    } label: {
                        Label("Sync", systemImage: "arrow.clockwise")
                    }
                    .buttonStyle(VPButtonStyle(kind: .secondary))
                }
                if app.relayURL.isEmpty {
                    Text("Set a relay URL in Settings before registering or syncing.")
                        .font(.footnote)
                        .foregroundStyle(VPColor.textMuted)
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
                            .foregroundStyle(VPColor.textMuted)
                    }
                    Spacer()
                    TonePill(text: wallet.isBackupVerified ? "Verified" : "Required", tone: wallet.isBackupVerified ? "success" : "warning")
                }
                if let path = wallet.derivationPath, !path.isEmpty {
                    FieldRow(title: "Stellar path", value: path)
                }
                Text(wallet.isBackupVerified ? "This wallet is ready for local signing." : "Back up and verify the recovery phrase before signing Payment Requests.")
                    .foregroundStyle(VPColor.textMuted)
                Button {
                    onBackup()
                } label: {
                    Label(wallet.isBackupVerified ? "Review Backup" : "Back Up Now", systemImage: "lock.shield")
                        .frame(maxWidth: .infinity)
                }
                .buttonStyle(VPButtonStyle(kind: .primary))
                .controlSize(.large)
            }
        }
    }
}

struct RecoveryPhraseBackupSheet: View {
    @EnvironmentObject private var app: AppState
    @Environment(\.dismiss) private var dismiss
    let wallet: StellarWallet

    // Three steps: reveal the phrase -> study it -> OKX-style "tap a few words in order".
    private enum Stage { case reveal, phrase, verify }
    @State private var stage: Stage = .reveal
    @State private var challenge: SeedChallenge?
    @State private var selected: [SeedOption] = []
    @State private var showMismatch = false

    private var words: [String] {
        wallet.recoveryPhrase?.split(whereSeparator: { $0.isWhitespace }).map(String.init) ?? []
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
                    } else {
                        switch stage {
                        case .reveal:
                            revealButton
                        case .phrase:
                            phraseSection
                        case .verify:
                            if let challenge {
                                verifySection(challenge)
                            } else {
                                revealButton
                            }
                        }
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

    // Step 1 — reveal gate.
    private var revealButton: some View {
        Button {
            stage = .phrase
        } label: {
            Label("Show Recovery Phrase", systemImage: "eye")
                .frame(maxWidth: .infinity)
        }
        .buttonStyle(VPButtonStyle(kind: .primary))
        .controlSize(.large)
    }

    // Step 2 — study the phrase, then move on to verification.
    private var phraseSection: some View {
        VStack(alignment: .leading, spacing: 16) {
            if showMismatch {
                Label("That didn't match. Re-read your phrase in order, then verify again.", systemImage: "exclamationmark.triangle.fill")
                    .font(.footnote.bold())
                    .foregroundStyle(VPColor.warningText)
                    .padding(VPSpace.s3)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .background(VPColor.warningSoft, in: RoundedRectangle(cornerRadius: VPRadius.sm))
            }
            MnemonicGrid(words: words)
                .textSelection(.disabled)
            Button {
                startVerification()
            } label: {
                Label("I've written it down — Verify", systemImage: "checkmark.shield")
                    .frame(maxWidth: .infinity)
            }
            .buttonStyle(VPButtonStyle(kind: .primary))
            .controlSize(.large)
        }
    }

    // Step 3 — tap the correct word for each numbered blank, in order.
    @ViewBuilder
    private func verifySection(_ challenge: SeedChallenge) -> some View {
        let positions = challenge.positions
        VStack(alignment: .leading, spacing: 16) {
            Text("Verify your backup")
                .font(VPType.display(18, .semibold))
                .foregroundStyle(VPColor.textPrimary)
            Text("Tap the correct word for each blank, in order.")
                .font(.subheadline)
                .foregroundStyle(VPColor.textMuted)

            // Numbered blanks. Tapping a filled blank clears it (and everything after it).
            VStack(spacing: VPSpace.s2) {
                ForEach(Array(positions.enumerated()), id: \.offset) { idx, position in
                    slotRow(
                        index: position + 1,
                        word: idx < selected.count ? selected[idx].word : nil,
                        active: idx == selected.count
                    ) {
                        if idx < selected.count { selected = Array(selected.prefix(idx)) }
                    }
                }
            }

            // Shuffled candidate pool (3-up). Used chips grey out.
            LazyVGrid(columns: Array(repeating: GridItem(.flexible(), spacing: VPSpace.s2), count: 3), spacing: VPSpace.s2) {
                ForEach(challenge.options) { option in
                    let used = selected.contains(option)
                    Button {
                        if !used && selected.count < positions.count { selected.append(option) }
                    } label: {
                        Text(option.word)
                            .font(VPType.mono(14, .medium))
                            .lineLimit(1)
                            .minimumScaleFactor(0.7)
                            .frame(maxWidth: .infinity)
                            .padding(.vertical, VPSpace.s3)
                            .padding(.horizontal, VPSpace.s2)
                            .background(used ? VPColor.surfaceSunken : VPColor.surfaceCard, in: RoundedRectangle(cornerRadius: VPRadius.pill))
                            .overlay(RoundedRectangle(cornerRadius: VPRadius.pill).stroke(used ? VPColor.borderSubtle : VPColor.borderDefault, lineWidth: 1))
                            .foregroundStyle(used ? VPColor.textMuted : VPColor.textPrimary)
                    }
                    .buttonStyle(.plain)
                    .disabled(used)
                }
            }

            Button {
                submitVerification(challenge)
            } label: {
                Label("Confirm", systemImage: "checkmark.shield")
                    .frame(maxWidth: .infinity)
            }
            .buttonStyle(VPButtonStyle(kind: .primary))
            .controlSize(.large)
            .disabled(selected.count != positions.count)

            Button {
                stage = .phrase
            } label: {
                Text("Review phrase again")
                    .frame(maxWidth: .infinity)
            }
            .buttonStyle(VPButtonStyle(kind: .secondary))
            .controlSize(.large)
        }
    }

    private func slotRow(index: Int, word: String?, active: Bool, onClear: @escaping () -> Void) -> some View {
        HStack(spacing: VPSpace.s2) {
            Text("#\(index)")
                .font(VPType.sans(13, .semibold))
                .foregroundStyle(VPColor.textMuted)
            Text(word ?? "Tap a word")
                .font(VPType.mono(15, .medium))
                .foregroundStyle(word == nil ? VPColor.textMuted : VPColor.textPrimary)
            Spacer(minLength: 0)
        }
        .padding(.horizontal, VPSpace.s3)
        .padding(.vertical, VPSpace.s3)
        .background(word != nil ? VPColor.brandSoft : VPColor.surfaceCard, in: RoundedRectangle(cornerRadius: VPRadius.sm))
        .overlay(
            RoundedRectangle(cornerRadius: VPRadius.sm)
                .stroke((word != nil || active) ? VPColor.brand : VPColor.borderDefault, lineWidth: 1)
        )
        .contentShape(Rectangle())
        .onTapGesture { if word != nil { onClear() } }
    }

    private func startVerification() {
        challenge = SeedVerification.make(words: words)
        selected = []
        showMismatch = false
        stage = .verify
    }

    private func submitVerification(_ challenge: SeedChallenge) {
        let chosen = selected.map { $0.word }
        if SeedVerification.isCorrect(words: words, positions: challenge.positions, selectedWords: chosen) {
            app.markWalletBackupVerified()
            dismiss()
        } else {
            // Decision: a wrong answer sends the user back to re-read the phrase, then retry.
            showMismatch = true
            selected = []
            self.challenge = nil
            stage = .phrase
        }
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
                    .buttonStyle(VPButtonStyle(kind: .primary))
                    .controlSize(.large)
                    if let preview {
                        Card {
                            VStack(alignment: .leading, spacing: 12) {
                                Text("Address preview")
                                    .font(.headline)
                                FieldRow(title: "Mnemonic type", value: preview.displayMnemonicType)
                                FieldRow(title: "Stellar path", value: preview.derivationPath ?? "m/44'/148'/0'")
                                FieldRow(title: "Stellar address", value: preview.address)
                                if let evm = preview.evmAddress {
                                    FieldRow(title: "EVM address", value: evm)
                                }
                                if let sol = preview.solanaAddress {
                                    FieldRow(title: "Solana address", value: sol)
                                }
                                Text(backupConfirmed ? "This wallet will be marked as backed up." : "Backup verification will be required before signing.")
                                    .foregroundStyle(VPColor.textMuted)
                                Button {
                                    app.restoreWallet(mnemonic: phraseText, backupVerified: backupConfirmed)
                                    dismiss()
                                } label: {
                                    Label("Import to this Device", systemImage: "square.and.arrow.down")
                                        .frame(maxWidth: .infinity)
                                }
                                .buttonStyle(VPButtonStyle(kind: .primary))
                                .controlSize(.large)
                            }
                        }
                    }
                    if !errorMessage.isEmpty {
                        Text(errorMessage)
                            .font(.footnote.bold())
                            .foregroundStyle(VPColor.negative)
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
        // 3-column word chips, matching prototype 02 (.words / .word).
        LazyVGrid(columns: Array(repeating: GridItem(.flexible(), spacing: VPSpace.s2), count: 3), spacing: VPSpace.s2) {
            ForEach(Array(words.enumerated()), id: \.offset) { index, word in
                HStack(spacing: 6) {
                    Text("\(index + 1)")
                        .font(VPType.sans(12, .semibold))
                        .foregroundStyle(VPColor.textMuted)
                    Text(word)
                        .font(VPType.mono(14, .medium))
                        .foregroundStyle(VPColor.textPrimary)
                    Spacer(minLength: 0)
                }
                .padding(.horizontal, VPSpace.s3)
                .padding(.vertical, VPSpace.s3)
                .background(VPColor.surfaceSunken, in: RoundedRectangle(cornerRadius: VPRadius.sm))
            }
        }
    }
}

// MARK: - EVM / Solana send flow (iOS gains real sending, via the shared core)

enum TokenSendKind: String, Identifiable {
    case evm, solana
    var id: String { rawValue }
    var symbol: String { self == .evm ? "ETH" : "SOL" }
    var title: String { self == .evm ? "Send ETH" : "Send SOL" }
}

struct TokenSendRequest: Identifiable {
    let id = UUID()
    let kind: TokenSendKind
    let symbol: String
    let chainName: String
    let fromAddress: String
    let rpcURL: String
    let chainId: Int64
    var tokenContract: String? = nil   // nil = native coin · set = ERC-20 token (e.g. Base USDC)
    var decimals: Int = 18             // 18 native EVM · 9 SOL · 6 USDC
}

/// Which wallet address backs an asset (one address can back several assets).
enum WalletAddressKind { case stellar, evm, solana }

/// One bound (token + network) asset. The single in-app source for the home + send screens —
/// mirrors the protocol transfer-assets registry, so symbol / chain / contract / decimals live
/// in ONE place instead of being retyped at each call site.
struct WalletAsset {
    let id: String                 // registry rail, e.g. "base_usdc"
    let symbol: String
    let chainName: String
    let kind: TokenSendKind?       // .evm / .solana = sendable via SendTokenView; nil = display-only (XLM)
    let addressKind: WalletAddressKind
    let chainId: Int64
    let tokenContract: String?     // nil = native coin · set = ERC-20
    let decimals: Int
    let gradient: [Color]
    let fallbackRpc: String        // used only if the network isn't in the device's network list

    var displayName: String { "\(symbol) · \(chainName)" }
}

enum WalletAssetRegistry {
    static let xlm = WalletAsset(id: "stellar_xlm", symbol: "XLM", chainName: "Stellar",
                                 kind: nil, addressKind: .stellar, chainId: 0, tokenContract: nil,
                                 decimals: 7, gradient: [Color(hex: 0x1A1A2E), Color(hex: 0x0F1626)], fallbackRpc: "")
    static let ethereum = WalletAsset(id: "ethereum_eth", symbol: "ETH", chainName: "Ethereum",
                                 kind: .evm, addressKind: .evm, chainId: 1, tokenContract: nil,
                                 decimals: 18, gradient: [Color(hex: 0x627EEA), Color(hex: 0x2B2F36)], fallbackRpc: "")
    static let usdcBase = WalletAsset(id: "base_usdc", symbol: "USDC", chainName: "Base",
                                 kind: .evm, addressKind: .evm, chainId: 8453,
                                 tokenContract: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
                                 decimals: 6, gradient: [Color(hex: 0x2775CA), Color(hex: 0x14315F)],
                                 fallbackRpc: "https://mainnet.base.org")
    static let sol = WalletAsset(id: "solana_sol", symbol: "SOL", chainName: "Solana",
                                 kind: .solana, addressKind: .solana, chainId: 0, tokenContract: nil,
                                 decimals: 9, gradient: [Color(hex: 0x9945FF), Color(hex: 0x14F195)], fallbackRpc: "")
}

/// Self-contained EVM / Solana send sheet. Derives the signing key from the wallet's
/// recovery phrase via the shared core, then signs + broadcasts via `EvmService` /
/// `SolanaService` (network I/O is native; the signature comes from the shared Rust
/// core, byte-compatible with Android).
struct SendTokenView: View {
    let request: TokenSendRequest
    let wallet: StellarWallet?
    /// All verified EVM networks the device knows (built-in + user-added). Lets the user pick
    /// which EVM chain to send on instead of being pinned to the first one.
    let evmNetworks: [WalletNetworkConfig]
    @Environment(\.dismiss) private var dismiss

    @State private var destination = ""
    @State private var amount = ""
    @State private var statusLine: String?
    @State private var resultID: String?
    @State private var errorText: String?
    @State private var sending = false
    @State private var selectedChainId: Int64
    /// Live network-fee estimate (read-only); nil while loading or when it can't be priced.
    @State private var feeText: String?

    private let evm = EvmService()
    private let solana = SolanaService()

    init(request: TokenSendRequest, wallet: StellarWallet?, evmNetworks: [WalletNetworkConfig]) {
        self.request = request
        self.wallet = wallet
        self.evmNetworks = evmNetworks
        _selectedChainId = State(initialValue: request.chainId)
    }

    /// The EVM network the user picked (defaults to the request's chain).
    private var selectedNetwork: WalletNetworkConfig? {
        evmNetworks.first { $0.chainId == selectedChainId } ?? evmNetworks.first
    }

    /// Asset-first: the symbol of the currently-bound asset (the network's native coin for EVM).
    private var amountSymbol: String {
        if request.tokenContract != nil { return request.symbol }
        switch request.kind {
        case .solana: return "SOL"
        case .evm:
            let sym = selectedNetwork?.currencySymbol ?? ""
            return sym.isEmpty ? "ETH" : sym
        }
    }

    /// Title shows the full bound asset "SYMBOL · Chain" (not just the token).
    private var navTitle: String {
        if request.tokenContract != nil { return "Send \(request.symbol) · \(request.chainName)" }
        switch request.kind {
        case .solana: return "Send SOL · Solana"
        case .evm: return "Send \(amountSymbol) · \(selectedNetwork?.name ?? "Ethereum")"
        }
    }

    /// "Validate address type up front": the destination must match the selected chain family.
    private var destinationValid: Bool {
        let d = destination.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !d.isEmpty else { return false }
        switch request.kind {
        case .evm: return d.range(of: "^0x[0-9a-fA-F]{40}$", options: .regularExpression) != nil
        case .solana: return d.range(of: "^[1-9A-HJ-NP-Za-km-z]{32,48}$", options: .regularExpression) != nil
        }
    }

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: VPSpace.s4) {
                    Card {
                        VStack(alignment: .leading, spacing: 8) {
                            Text("Sending from").font(.headline)
                            Text(request.fromAddress)
                                .font(VPType.mono(12))
                                .foregroundStyle(VPColor.textMuted)
                                .textSelection(.enabled)
                        }
                    }
                    if request.kind == .evm, request.tokenContract == nil, evmNetworks.count > 1 {
                        Card {
                            VStack(alignment: .leading, spacing: 8) {
                                Text("Asset").font(.subheadline.bold())
                                Picker("Asset", selection: $selectedChainId) {
                                    ForEach(evmNetworks) { net in
                                        Text(net.currencySymbol.isEmpty ? net.name : "\(net.currencySymbol) · \(net.name)")
                                            .tag(net.chainId)
                                    }
                                }
                                .pickerStyle(.menu)
                                .frame(maxWidth: .infinity, alignment: .leading)
                            }
                        }
                    }
                    Card {
                        VStack(alignment: .leading, spacing: 12) {
                            Text("Amount · \(amountSymbol)").font(.subheadline.bold())
                            TextField("0.0", text: $amount)
                                .keyboardType(.decimalPad)
                                .textFieldStyle(.roundedBorder)
                            Text("Recipient address").font(.subheadline.bold())
                            TextField(request.kind == .evm ? "0x…" : "Base58 address", text: $destination)
                                .textFieldStyle(.roundedBorder)
                                .autocorrectionDisabled(true)
                            if !destination.isEmpty && !destinationValid {
                                Text(request.kind == .evm ? "Enter a valid 0x… EVM address." : "Enter a valid Solana (base58) address.")
                                    .font(.footnote.bold())
                                    .foregroundStyle(VPColor.negative)
                            }
                            if let feeText {
                                Divider().overlay(VPColor.borderSubtle)
                                HStack(spacing: VPSpace.s2) {
                                    Text("Network fee").font(.subheadline).foregroundStyle(VPColor.textMuted)
                                    Spacer()
                                    Text(feeText).font(VPType.mono(13)).foregroundStyle(VPColor.textPrimary)
                                }
                            }
                        }
                    }
                    if let statusLine {
                        Text(statusLine).font(.footnote).foregroundStyle(VPColor.textMuted)
                    }
                    if let resultID {
                        Card {
                            VStack(alignment: .leading, spacing: 8) {
                                Label("Broadcast", systemImage: "checkmark.seal.fill")
                                    .foregroundStyle(VPColor.mint).font(.headline)
                                FieldRow(title: request.kind == .evm ? "Transaction hash" : "Signature", value: resultID)
                            }
                        }
                    }
                    if let errorText {
                        Text(errorText).font(.footnote.bold()).foregroundStyle(VPColor.negative)
                    }
                    Button {
                        Task { await performSend() }
                    } label: {
                        Label(sending ? "Sending…" : "Send \(amountSymbol)", systemImage: "paperplane.fill")
                            .frame(maxWidth: .infinity)
                    }
                    .buttonStyle(VPButtonStyle(kind: .primary))
                    .controlSize(.large)
                    .disabled(sending || amount.isEmpty || !destinationValid)
                }
                .padding()
            }
            .navigationTitle(navTitle)
            .appInlineNavigationTitle()
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Close") { dismiss() }
                }
            }
            .background(VPColor.surfacePage.ignoresSafeArea())
            .task(id: selectedChainId) { await refreshFee() }
        }
    }

    private func performSend() async {
        guard let wallet, let phrase = wallet.recoveryPhrase, !phrase.isEmpty else {
            errorText = "This device has no recovery phrase available to sign with."
            return
        }
        sending = true
        errorText = nil
        resultID = nil
        statusLine = "Preparing transaction…"
        let to = destination.trimmingCharacters(in: .whitespacesAndNewlines)
        do {
            switch request.kind {
            case .evm:
                let keys = try evmDerive(mnemonic: phrase, passphrase: "")
                if let contract = request.tokenContract {
                    // ERC-20 (e.g. USDC · Base): value 0, recipient/amount in calldata, sent to the contract.
                    let hash = try await evm.sendErc20(
                        rpcURL: request.rpcURL,
                        chainId: request.chainId,
                        fromAddress: keys.address, privateKey: keys.privateKey,
                        tokenContract: contract, toAddress: to,
                        amount: amount, decimals: request.decimals
                    ) { line in await MainActor.run { statusLine = line } }
                    await MainActor.run { resultID = hash; statusLine = nil }
                } else {
                    let net = selectedNetwork
                    let hash = try await evm.sendNative(
                        rpcURL: net?.defaultRPCURL ?? request.rpcURL,
                        chainId: net?.chainId ?? request.chainId,
                        fromAddress: keys.address, privateKey: keys.privateKey,
                        toAddress: to, amountEther: amount
                    ) { line in await MainActor.run { statusLine = line } }
                    await MainActor.run { resultID = hash; statusLine = nil }
                }
            case .solana:
                let keys = try solanaDerive(mnemonic: phrase, passphrase: "")
                let sig = try await solana.sendSol(
                    rpcURL: request.rpcURL, secretSeed: keys.secretSeed,
                    toAddress: to, amountSol: amount
                ) { line in await MainActor.run { statusLine = line } }
                await MainActor.run { resultID = sig; statusLine = nil }
            }
        } catch {
            await MainActor.run {
                statusLine = nil
                errorText = (error as? LocalizedError)?.errorDescription ?? error.localizedDescription
            }
        }
        await MainActor.run { sending = false }
    }

    /// Fetches the live network fee for the selected chain (EVM: live gasPrice × 21000;
    /// Solana: the fixed 5000-lamport base signature fee). Read-only and fail-safe — on any
    /// error the fee line simply stays hidden, so it never blocks sending.
    private func refreshFee() async {
        let text: String?
        switch request.kind {
        case .evm:
            if request.tokenContract != nil {
                // ERC-20 gas (≈100k) differs from native (21k); skip the estimate, show fee at broadcast.
                text = nil
            } else {
                let net = selectedNetwork
                let symbol = (net?.currencySymbol.isEmpty == false) ? (net?.currencySymbol ?? "ETH") : "ETH"
                if let ether = await evm.estimateNativeFeeEther(rpcURL: net?.defaultRPCURL ?? request.rpcURL) {
                    text = "≈ \(ether) \(symbol)"
                } else {
                    text = nil
                }
            }
        case .solana:
            text = "≈ \(TokenAmount.fromBaseUnits("5000", decimals: 9)) SOL"
        }
        await MainActor.run { feeText = text }
    }
}

