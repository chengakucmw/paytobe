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

