// Payment detail, truth-panel & warning views
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
                    // Requester header + amount hero — matches prototype 11.
                    HStack(spacing: VPSpace.s3) {
                        VPTokenBadge(symbol: String(valueOr(intent.payeeDisplayName, intent.title).prefix(1)).uppercased())
                        VStack(alignment: .leading, spacing: 2) {
                            Text(intent.title)
                                .font(VPType.display(18, .semibold)).foregroundStyle(VPColor.textPrimary)
                            Text(intent.summary)
                                .font(VPType.sans(13)).foregroundStyle(VPColor.textMuted).lineLimit(2)
                        }
                        Spacer(minLength: 0)
                    }
                    VStack(spacing: VPSpace.s3) {
                        Text("\(valueOr(intent.amount, "0")) \(intent.asset)")
                            .font(VPType.display(34, .semibold)).foregroundStyle(VPColor.textPrimary)
                        HStack(spacing: VPSpace.s2) {
                            TonePill(text: paymentStatusLabel(displayState), tone: paymentTone(displayState, canSign: canSign))
                            TonePill(text: paymentRiskLabel(intent), tone: paymentRiskTone(intent))
                        }
                    }
                    .frame(maxWidth: .infinity)
                    .padding(VPSpace.s6)
                    .background(VPColor.surfaceCard, in: RoundedRectangle(cornerRadius: VPRadius.lg))
                    .overlay(RoundedRectangle(cornerRadius: VPRadius.lg).stroke(VPColor.borderSubtle, lineWidth: 1))
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
                            .foregroundStyle(VPColor.textMuted)
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
                        .foregroundStyle(VPColor.textMuted)
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
                    .foregroundStyle(VPColor.textMuted)
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
                        .foregroundStyle(VPColor.textMuted)
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
                HStack(spacing: VPSpace.s3) {
                    Button(role: .destructive, action: onReject) {
                        Text("Reject")
                    }
                    .buttonStyle(VPButtonStyle(kind: .secondary))
                    Button(action: requiresWarningStepUp ? onReviewWarnings : onSign) {
                        Text(requiresWarningStepUp ? "Review warnings" : intent.payButtonTitle)
                    }
                    .buttonStyle(VPButtonStyle(kind: requiresWarningStepUp ? .danger : .primary))
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
                .buttonStyle(VPButtonStyle(kind: .primary))
                Button(role: .destructive, action: onReject) {
                    Text("Reject request").frame(maxWidth: .infinity)
                }
                .buttonStyle(VPButtonStyle(kind: .secondary))
            }
        } else if ["missing_context", "needs_review", "source_review_required"].contains(normalized) && intent.status == PaymentStatus.pending.rawValue {
            HStack {
                Button(action: onRequestContext) {
                    Text("Request context").frame(maxWidth: .infinity)
                }
                .buttonStyle(VPButtonStyle(kind: .primary))
                Button(role: .destructive, action: onReject) {
                    Text("Reject request").frame(maxWidth: .infinity)
                }
                .buttonStyle(VPButtonStyle(kind: .secondary))
            }
        } else if normalized == "blocked" && intent.status == PaymentStatus.pending.rawValue {
            Button(role: .destructive, action: onReject) {
                Text("Reject request").frame(maxWidth: .infinity)
            }
            .buttonStyle(VPButtonStyle(kind: .danger))
        } else if normalized == "network_disabled" && intent.status == PaymentStatus.pending.rawValue {
            HStack {
                Button(action: onEnableNetwork) {
                    Text("Enable network").frame(maxWidth: .infinity)
                }
                .buttonStyle(VPButtonStyle(kind: .primary))
                Button(role: .destructive, action: onReject) {
                    Text("Reject request").frame(maxWidth: .infinity)
                }
                .buttonStyle(VPButtonStyle(kind: .secondary))
            }
        } else if normalized == "failed" {
            InfoCard(title: "Retry requires review", bodyText: "Retry only after re-checking fee, recipient, and the prior transaction state.")
        } else if normalized == "broadcasting" || normalized == "signed_locally" || normalized == "confirmed" {
            Button(action: onCopyTransaction) {
                Label("Copy transaction", systemImage: "doc.on.doc")
                    .frame(maxWidth: .infinity)
            }
            .buttonStyle(VPButtonStyle(kind: .secondary))
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
                        .foregroundStyle(VPColor.textMuted)
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
                    .buttonStyle(VPButtonStyle(kind: .primary))
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

