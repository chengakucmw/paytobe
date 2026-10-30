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
        PaytobeRootView()
    }
}

struct PaytobeRootView: View {
    @EnvironmentObject private var app: AppState

    var body: some View {
        if app.isHydrating {
            PaytobeHydratingView()
        } else {
            mainContent
        }
    }

    private var mainContent: some View {
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
        .tint(VPColor.brand)
        .sheet(item: $app.selectedIntent) { intent in
            PaymentDetailView(intent: intent)
                .environmentObject(app)
        }
        .sheet(item: $app.pairingSession) { session in
            PairingReviewView(session: session)
                .environmentObject(app)
        }
        .sheet(isPresented: $app.showingConnectInvitation) {
            ConnectInvitationView()
                .environmentObject(app)
                .presentationDetents([.medium, .large])
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
            "Paytobe",
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

/// Lightweight cold-launch splash shown while AppState.hydrate() loads the wallet +
/// local stores off the main thread, so an existing user never sees the empty /
/// "no wallet" tab state flash before hydration completes.
struct PaytobeHydratingView: View {
    var body: some View {
        ProgressView()
            .controlSize(.large)
            .tint(VPColor.brand)
            .frame(maxWidth: .infinity, maxHeight: .infinity)
    }
}
