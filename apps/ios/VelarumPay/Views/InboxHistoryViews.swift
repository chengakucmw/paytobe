// Inbox & History list views
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
            .scrollContentBackground(.hidden)
            .background(VPColor.surfacePage.ignoresSafeArea())
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
            .scrollContentBackground(.hidden)
            .background(VPColor.surfacePage.ignoresSafeArea())
        }
    }
}

