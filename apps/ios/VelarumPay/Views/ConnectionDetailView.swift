// Connection detail view
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
                            .buttonStyle(VPButtonStyle(kind: .secondary))
                            Button(role: .destructive) {
                                confirmingRevoke = true
                            } label: {
                                Text("Revoke").frame(maxWidth: .infinity)
                            }
                            .buttonStyle(VPButtonStyle(kind: .danger))
                        }
                    }
                }
            }
        }
    }
}

