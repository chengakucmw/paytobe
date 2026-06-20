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
                    VPQuickAction(icon: "arrow.clockwise", label: "Sync", onHero: true) { app.syncInbox() }
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

    // Account — the Stellar address as an asset-style row.
    private var accountSection: some View {
        VStack(alignment: .leading, spacing: VPSpace.s2) {
            VPSectionHeader(title: "Account")
            if let wallet = app.wallet {
                Button {
                    app.copy(wallet.address)
                } label: {
                    HStack(spacing: VPSpace.s3) {
                        VPTokenBadge(symbol: "XLM", gradient: [Color(hex: 0x1A1A2E), Color(hex: 0x0F1626)])
                        VStack(alignment: .leading, spacing: 2) {
                            Text("Stellar Lumens").font(VPType.sans(16, .semibold)).foregroundStyle(VPColor.textPrimary)
                            Text(shortAddress(wallet.address)).font(VPType.mono(13)).foregroundStyle(VPColor.textMuted)
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
                    otherChainRow(symbol: "ETH", name: "Ethereum / EVM", address: evm,
                                  gradient: [Color(hex: 0x627EEA), Color(hex: 0x2B2F36)])
                }
                if let sol = wallet.solanaAddress {
                    otherChainRow(symbol: "SOL", name: "Solana", address: sol,
                                  gradient: [Color(hex: 0x9945FF), Color(hex: 0x14F195)])
                }
            } else {
                emptyHint("No account yet", "Set up a wallet to see your Stellar address here.")
            }
        }
    }

    // An EVM/Solana address row, styled like the Stellar account row above.
    private func otherChainRow(symbol: String, name: String, address: String, gradient: [Color]) -> some View {
        Button {
            app.copy(address)
        } label: {
            HStack(spacing: VPSpace.s3) {
                VPTokenBadge(symbol: symbol, gradient: gradient)
                VStack(alignment: .leading, spacing: 2) {
                    Text(name).font(VPType.sans(16, .semibold)).foregroundStyle(VPColor.textPrimary)
                    Text(shortAddress(address)).font(VPType.mono(13)).foregroundStyle(VPColor.textMuted)
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
                Text("Register this device with a VelarumPay relay, connect trusted agents, then review incoming requests before signing.")
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
                                .foregroundStyle(VPColor.negative)
                        }
                        Button {
                            verify()
                        } label: {
                            Label("Verify Backup", systemImage: "checkmark.shield")
                                .frame(maxWidth: .infinity)
                        }
                        .buttonStyle(VPButtonStyle(kind: .primary))
                        .controlSize(.large)
                    } else {
                        Button {
                            showingWords = true
                        } label: {
                            Label("Show Recovery Phrase", systemImage: "eye")
                                .frame(maxWidth: .infinity)
                        }
                        .buttonStyle(VPButtonStyle(kind: .primary))
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

