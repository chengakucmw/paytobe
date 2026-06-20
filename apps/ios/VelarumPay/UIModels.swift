// Small view-model types (inbox filter/sections, truth-panel rows)
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

