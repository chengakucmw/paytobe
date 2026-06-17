import SwiftUI

#if canImport(UIKit)
import UIKit
#elseif canImport(AppKit)
import AppKit
#endif

#if canImport(AVFoundation)
import AVFoundation
#endif

struct ContentView: View {
    @EnvironmentObject private var app: AppState

    var body: some View {
        TabView {
            WalletView()
                .tabItem { Label("Wallet", systemImage: "wallet.pass") }
            InboxView()
                .tabItem { Label("Inbox", systemImage: "tray.full") }
            HistoryView()
                .tabItem { Label("History", systemImage: "clock.arrow.circlepath") }
            SettingsView()
                .tabItem { Label("Settings", systemImage: "gearshape") }
        }
        .tint(.green)
        .sheet(item: $app.selectedIntent) { intent in
            PaymentDetailView(intent: intent)
                .presentationDetents([.medium, .large])
        }
        .sheet(item: $app.pairingSession) { session in
            PairingReviewView(session: session)
                .presentationDetents([.large])
        }
        .sheet(isPresented: $app.showingPairingScanner) {
            PairingScannerSheet { value in
                app.pairingInput = value
                app.showingPairingScanner = false
                app.reviewPairing()
            }
        }
        .sheet(item: $app.selectedConnection) { connection in
            ConnectionDetailView(connection: connection)
                .presentationDetents([.medium, .large])
        }
        .sheet(item: $app.progress) { progress in
            PaymentProgressView(progress: progress)
                .presentationDetents([.height(progress.canDismiss ? 300 : 240)])
                .interactiveDismissDisabled(!progress.canDismiss)
        }
        .alert("VelarumPay", isPresented: Binding(
            get: { app.errorMessage != nil },
            set: { if !$0 { app.errorMessage = nil } }
        )) {
            Button("OK", role: .cancel) {}
        } message: {
            Text(app.errorMessage ?? "")
        }
    }
}

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
                            note: "Use this address for XLM. Stellar accounts must be funded before they are active."
                        )
                        DemoCard()
                    } else {
                        EmptyWalletCard()
                    }
                    InfoCard(
                        title: "Receive Addresses",
                        bodyText: "iOS v1 focuses on Stellar XLM for the AgentFood demo. EVM and Solana signing are reserved for the next wallet-core integration pass."
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
                Text("Generate a local Stellar wallet for the iOS demo. The private seed is stored in this device Keychain.")
                    .foregroundStyle(.secondary)
                Button {
                    app.generateWallet()
                } label: {
                    Label("Generate Wallet", systemImage: "plus.circle.fill")
                        .frame(maxWidth: .infinity)
                }
                .buttonStyle(.borderedProminent)
                .controlSize(.large)
            }
        }
    }
}

struct DemoCard: View {
    @EnvironmentObject private var app: AppState

    var body: some View {
        Card {
            VStack(alignment: .leading, spacing: 12) {
                Text("AgentFood Demo")
                    .font(.title2.bold())
                Text("Register this phone with the relay, then ask the Telegram bot to order food and pay with XLM.")
                    .foregroundStyle(.secondary)
                HStack {
                    Button {
                        app.startDemoSession()
                    } label: {
                        Label("Start Demo", systemImage: "paperplane")
                    }
                    .buttonStyle(.borderedProminent)
                    Button {
                        app.syncInbox()
                    } label: {
                        Label("Sync", systemImage: "arrow.clockwise")
                    }
                    .buttonStyle(.bordered)
                }
                if let session = app.demoSessionId, !session.isEmpty {
                    FieldRow(title: "Session", value: session, copyAction: { app.copy(session) })
                    Button {
                        app.openTelegramDemo()
                    } label: {
                        Label("Open Telegram", systemImage: "message")
                            .frame(maxWidth: .infinity)
                    }
                    .buttonStyle(.bordered)
                }
            }
        }
    }
}

struct InboxView: View {
    @EnvironmentObject private var app: AppState

    private var pendingItems: [PaymentIntent] {
        app.inbox.filter { !$0.status.isEmpty }.sorted { $0.createdAtMs > $1.createdAtMs }
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
                }
                if pendingItems.isEmpty {
                    ContentUnavailableView("No payment requests", systemImage: "tray", description: Text("Connect the relay or sync after creating an AgentFood order."))
                } else {
                    ForEach(pendingItems) { intent in
                        PaymentIntentRow(intent: intent)
                            .contentShape(Rectangle())
                            .onTapGesture { app.selectedIntent = intent }
                    }
                }
            }
            .navigationTitle("Inbox")
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
        }
    }
}

struct SettingsView: View {
    @EnvironmentObject private var app: AppState
    @State private var relayDraft = ""

    var body: some View {
        NavigationStack {
            Form {
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
                    TextField("Pairing short code or velarumpay://pair URI", text: $app.pairingInput)
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
                        .foregroundStyle(.secondary)
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
                Section("Device") {
                    FieldRow(title: "Device ID", value: app.deviceId, copyAction: { app.copy(app.deviceId) })
                    FieldRow(title: "Device Token", value: app.deviceToken, copyAction: { app.copy(app.deviceToken) })
                }
                Section("Wallet") {
                    if let wallet = app.wallet {
                        FieldRow(title: "Stellar Address", value: wallet.address, copyAction: { app.copy(wallet.address) })
                    }
                    Button("Clear Local Wallet", role: .destructive) {
                        app.clearWallet()
                    }
                }
            }
            .navigationTitle("Settings")
            .onAppear { relayDraft = app.relayURL }
        }
    }
}

struct PairingScannerSheet: View {
    @Environment(\.dismiss) private var dismiss
    let onCode: (String) -> Void

    var body: some View {
        NavigationStack {
            VStack(spacing: 16) {
                #if canImport(UIKit) && canImport(AVFoundation)
                PairingQRScanner(onCode: onCode)
                    .clipShape(RoundedRectangle(cornerRadius: 20))
                    .padding()
                #else
                ContentUnavailableView("Scanner unavailable", systemImage: "camera", description: Text("Enter the pairing URI or short code manually."))
                    .padding()
                #endif
                InfoCard(
                    title: "Scan to connect",
                    bodyText: "Scan a VelarumPay pairing QR. The next screen reviews agent identity and scopes before any permission is granted."
                )
                .padding(.horizontal)
            }
            .navigationTitle("Scan Pairing QR")
            .appInlineNavigationTitle()
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Close") { dismiss() }
                }
            }
        }
    }
}

#if canImport(UIKit) && canImport(AVFoundation)
struct PairingQRScanner: UIViewControllerRepresentable {
    let onCode: (String) -> Void

    func makeUIViewController(context: Context) -> QRScannerViewController {
        QRScannerViewController(onCode: onCode)
    }

    func updateUIViewController(_ uiViewController: QRScannerViewController, context: Context) {}
}

final class QRScannerViewController: UIViewController, AVCaptureMetadataOutputObjectsDelegate {
    private let onCode: (String) -> Void
    private let session = AVCaptureSession()
    private var previewLayer: AVCaptureVideoPreviewLayer?
    private var didEmitCode = false

    init(onCode: @escaping (String) -> Void) {
        self.onCode = onCode
        super.init(nibName: nil, bundle: nil)
    }

    required init?(coder: NSCoder) {
        nil
    }

    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = .black
        configureCamera()
    }

    override func viewDidLayoutSubviews() {
        super.viewDidLayoutSubviews()
        previewLayer?.frame = view.bounds
    }

    private func configureCamera() {
        switch AVCaptureDevice.authorizationStatus(for: .video) {
        case .authorized:
            startSession()
        case .notDetermined:
            AVCaptureDevice.requestAccess(for: .video) { [weak self] granted in
                DispatchQueue.main.async {
                    granted ? self?.startSession() : self?.showPermissionMessage()
                }
            }
        default:
            showPermissionMessage()
        }
    }

    private func startSession() {
        guard let device = AVCaptureDevice.default(for: .video),
              let input = try? AVCaptureDeviceInput(device: device),
              session.canAddInput(input) else {
            showPermissionMessage()
            return
        }
        session.addInput(input)
        let output = AVCaptureMetadataOutput()
        guard session.canAddOutput(output) else {
            showPermissionMessage()
            return
        }
        session.addOutput(output)
        output.setMetadataObjectsDelegate(self, queue: DispatchQueue.main)
        output.metadataObjectTypes = [.qr]
        let layer = AVCaptureVideoPreviewLayer(session: session)
        layer.videoGravity = .resizeAspectFill
        layer.frame = view.bounds
        view.layer.addSublayer(layer)
        previewLayer = layer
        DispatchQueue.global(qos: .userInitiated).async { [session] in
            session.startRunning()
        }
    }

    private func showPermissionMessage() {
        let label = UILabel()
        label.text = "Camera is required to scan pairing QR codes."
        label.textColor = .white
        label.textAlignment = .center
        label.numberOfLines = 0
        label.translatesAutoresizingMaskIntoConstraints = false
        view.addSubview(label)
        NSLayoutConstraint.activate([
            label.leadingAnchor.constraint(equalTo: view.leadingAnchor, constant: 24),
            label.trailingAnchor.constraint(equalTo: view.trailingAnchor, constant: -24),
            label.centerYAnchor.constraint(equalTo: view.centerYAnchor)
        ])
    }

    func metadataOutput(_ output: AVCaptureMetadataOutput, didOutput metadataObjects: [AVMetadataObject], from connection: AVCaptureConnection) {
        guard !didEmitCode,
              let object = metadataObjects.compactMap({ $0 as? AVMetadataMachineReadableCodeObject }).first,
              let value = object.stringValue?.trimmingCharacters(in: .whitespacesAndNewlines),
              !value.isEmpty else {
            return
        }
        didEmitCode = true
        session.stopRunning()
        onCode(value)
    }
}
#endif

struct PairingReviewView: View {
    @EnvironmentObject private var app: AppState
    let session: PairingSession
    @State private var approvedScopes = Set<String>()

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 14) {
                    Text(session.displayName)
                        .font(.largeTitle.bold())
                    StatusPill(text: "\(session.status) / \(session.inputSource)")
                    FieldRow(title: "Runtime", value: session.runtime)
                    if !session.deviceLabel.isEmpty {
                        FieldRow(title: "Device label", value: session.deviceLabel)
                    }
                    if !session.source.isEmpty {
                        FieldRow(title: "Source", value: session.source)
                    }
                    FieldRow(title: "Expiration", value: dateText(session.expiresAtMs))
                    Text("Requested scopes")
                        .font(.headline)
                    ForEach(session.requestedScopes, id: \.self) { scope in
                        Toggle(isOn: Binding(
                            get: { approvedScopes.contains(scope) },
                            set: { isOn in
                                if isOn {
                                    approvedScopes.insert(scope)
                                } else {
                                    approvedScopes.remove(scope)
                                }
                            }
                        )) {
                            VStack(alignment: .leading, spacing: 3) {
                                Text(scopeDisplayName(scope))
                                Text(scope)
                                    .font(.caption.monospaced())
                                    .foregroundStyle(.secondary)
                            }
                        }
                    }
                    InfoCard(
                        title: "No signing permission",
                        bodyText: "Pairing is not payment approval. Agents can prepare requests or read their own status only; every payment still needs review and local signing on this device."
                    )
                    if session.isPending {
                        HStack {
                            Button(role: .destructive) {
                                app.rejectPairing(session)
                            } label: {
                                Text("Reject").frame(maxWidth: .infinity)
                            }
                            .buttonStyle(.bordered)
                            Button {
                                app.approvePairing(session, scopes: approvedScopes)
                            } label: {
                                Text("Approve Selected").frame(maxWidth: .infinity)
                            }
                            .buttonStyle(.borderedProminent)
                        }
                    } else {
                        InfoCard(title: "Session closed", bodyText: "This pairing session is \(session.status) and cannot be approved.")
                    }
                }
                .padding()
            }
            .navigationTitle("Pair Agent")
            .appInlineNavigationTitle()
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Close") { app.pairingSession = nil }
                }
            }
            .onAppear {
                if approvedScopes.isEmpty {
                    approvedScopes = Set(session.requestedScopes)
                }
            }
        }
    }
}

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
                    if !connection.isRevoked {
                        HStack {
                            Button {
                                app.updateConnection(connection, status: connection.status == "paused" ? "active" : "paused")
                            } label: {
                                Text(connection.status == "paused" ? "Resume Agent" : "Pause Agent")
                                    .frame(maxWidth: .infinity)
                            }
                            .buttonStyle(.bordered)
                            Button(role: .destructive) {
                                confirmingRevoke = true
                            } label: {
                                Text("Revoke").frame(maxWidth: .infinity)
                            }
                            .buttonStyle(.borderedProminent)
                        }
                    }
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
        }
    }
}

struct PaymentDetailView: View {
    @EnvironmentObject private var app: AppState
    let intent: PaymentIntent

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 14) {
                    Text(intent.title)
                        .font(.largeTitle.bold())
                    StatusPill(text: "\(intent.network) / \(intent.status)")
                    Text(intent.summary)
                        .foregroundStyle(.secondary)
                    FieldRow(title: "Amount", value: "\(intent.amount) \(intent.asset)")
                    FieldRow(title: "Recipient", value: intent.to, copyAction: { app.copy(intent.to) })
                    if !intent.orderId.isEmpty {
                        FieldRow(title: "Order", value: intent.orderId, copyAction: { app.copy(intent.orderId) })
                    }
                    if !intent.restaurantName.isEmpty {
                        FieldRow(title: "Restaurant", value: firstNonEmpty(intent.restaurantName, intent.restaurantCuisine))
                    }
                    if !intent.orderTotalUsd.isEmpty {
                        FieldRow(title: "Order Total", value: "$\(intent.orderTotalUsd)")
                    }
                    if intent.isPending {
                        HStack {
                            Button(role: .destructive) {
                                app.reject(intent)
                            } label: {
                                Text("Reject").frame(maxWidth: .infinity)
                            }
                            .buttonStyle(.bordered)
                            Button {
                                app.pay(intent)
                            } label: {
                                Text(intent.payButtonTitle).frame(maxWidth: .infinity)
                            }
                            .buttonStyle(.borderedProminent)
                        }
                    } else if !intent.txHash.isEmpty {
                        FieldRow(title: "Transaction", value: intent.txHash, copyAction: { app.copy(intent.txHash) })
                    }
                }
                .padding()
            }
            .navigationTitle("Payment")
            .appInlineNavigationTitle()
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

struct PaymentIntentRow: View {
    let intent: PaymentIntent

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
            StatusPill(text: "\(intent.network) / \(intent.status)")
            Text(intent.summary)
                .font(.subheadline)
                .foregroundStyle(.secondary)
            Text(shortAddress(intent.to))
                .font(.caption.monospaced())
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

func dateText(_ timestampMs: Int64) -> String {
    guard timestampMs > 0 else { return "Not available" }
    let date = Date(timeIntervalSince1970: Double(timestampMs) / 1000)
    return date.formatted(date: .abbreviated, time: .shortened)
}

extension Color {
    static var appGroupedBackground: Color {
        #if canImport(UIKit)
        Color(UIColor.systemGroupedBackground)
        #elseif canImport(AppKit)
        Color(NSColor.windowBackgroundColor)
        #else
        Color.gray.opacity(0.08)
        #endif
    }

    static var appSecondaryGroupedBackground: Color {
        #if canImport(UIKit)
        Color(UIColor.secondarySystemGroupedBackground)
        #elseif canImport(AppKit)
        Color(NSColor.controlBackgroundColor)
        #else
        Color.gray.opacity(0.12)
        #endif
    }

    static var appSystemBackground: Color {
        #if canImport(UIKit)
        Color(UIColor.systemBackground)
        #elseif canImport(AppKit)
        Color(NSColor.windowBackgroundColor)
        #else
        Color.white
        #endif
    }

    static var appSeparator: Color {
        #if canImport(UIKit)
        Color(UIColor.separator)
        #elseif canImport(AppKit)
        Color(NSColor.separatorColor)
        #else
        Color.gray
        #endif
    }
}

extension View {
    @ViewBuilder
    func relayURLInputStyle() -> some View {
        #if canImport(UIKit)
        self.textInputAutocapitalization(.never)
            .keyboardType(.URL)
        #else
        self
        #endif
    }

    @ViewBuilder
    func appInlineNavigationTitle() -> some View {
        #if canImport(UIKit)
        self.navigationBarTitleDisplayMode(.inline)
        #else
        self
        #endif
    }
}
