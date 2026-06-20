// Reusable UI components (cards, pills, rows, bars)
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

