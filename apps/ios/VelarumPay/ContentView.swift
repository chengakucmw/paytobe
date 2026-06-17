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
                    ContentUnavailableView("No payment requests", systemImage: "tray", description: Text("Connect the relay or sync after creating an AgentFood order."))
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
    @State private var showingWarningReview = false

    private var reviewState: String {
        paymentReviewState(intent)
    }

    private var canSign: Bool {
        isPaymentDetailSignable(intent)
    }

    private var requiresWarningStepUp: Bool {
        paymentRequiresWarningStepUp(intent)
    }

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 14) {
                    Text(intent.title)
                        .font(.largeTitle.bold())
                    HStack {
                        TonePill(text: paymentStatusLabel(reviewState), tone: paymentTone(reviewState, canSign: canSign))
                        TonePill(text: paymentRiskLabel(intent), tone: paymentRiskTone(intent))
                    }
                    Text(intent.summary)
                        .foregroundStyle(.secondary)
                    PaymentFactsCard(intent: intent)
                    PaymentStateCard(intent: intent, state: reviewState, canSign: canSign)
                    TruthPanelCard(intent: intent)
                    PaymentContextCard(intent: intent)
                    PaymentDetailActions(
                        intent: intent,
                        state: reviewState,
                        canSign: canSign,
                        requiresWarningStepUp: requiresWarningStepUp,
                        onReject: { app.reject(intent) },
                        onSign: { app.pay(intent) },
                        onReviewWarnings: { showingWarningReview = true },
                        onCopyTransaction: { app.copy(intent.txHash) },
                        onRequestContext: { app.statusText = "Context requested" }
                    )
                }
                .padding()
            }
            .navigationTitle("Payment")
            .appInlineNavigationTitle()
            .sheet(isPresented: $showingWarningReview) {
                WarningReviewSheet(intent: intent) {
                    showingWarningReview = false
                    app.pay(intent)
                }
                .presentationDetents([.medium, .large])
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
                FieldRow(title: "Asset", value: valueOr(intent.asset, "Unknown asset"))
                FieldRow(title: "Amount", value: "\(valueOr(intent.amount, "0")) \(valueOr(intent.asset, ""))")
                FieldRow(title: "Recipient", value: valueOr(intent.to, "Missing recipient"), copyAction: intent.to.isEmpty ? nil : { app.copy(intent.to) })
                if !intent.payeeDisplayName.isEmpty {
                    FieldRow(title: "Payee", value: intent.payeeDisplayName)
                }
                if !intent.memo.isEmpty {
                    FieldRow(title: "Memo", value: intent.memo, copyAction: { app.copy(intent.memo) })
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
                            .foregroundStyle(.secondary)
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
                        .foregroundStyle(.secondary)
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
                    .foregroundStyle(.secondary)
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
                        .foregroundStyle(.secondary)
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

    var body: some View {
        VStack(spacing: 10) {
            if canSign {
                HStack {
                    Button(role: .destructive, action: onReject) {
                        Text("Reject").frame(maxWidth: .infinity)
                    }
                    .buttonStyle(.bordered)
                    Button(action: requiresWarningStepUp ? onReviewWarnings : onSign) {
                        Text(requiresWarningStepUp ? "Review warnings" : intent.payButtonTitle)
                            .frame(maxWidth: .infinity)
                    }
                    .buttonStyle(.borderedProminent)
                }
            } else {
                nonSigningActions
            }
        }
    }

    @ViewBuilder
    private var nonSigningActions: some View {
        let normalized = normalizeReviewState(state)
        if ["missing_context", "needs_review", "source_review_required"].contains(normalized) && intent.status == PaymentStatus.pending.rawValue {
            HStack {
                Button(action: onRequestContext) {
                    Text("Request context").frame(maxWidth: .infinity)
                }
                .buttonStyle(.borderedProminent)
                Button(role: .destructive, action: onReject) {
                    Text("Reject request").frame(maxWidth: .infinity)
                }
                .buttonStyle(.bordered)
            }
        } else if normalized == "blocked" && intent.status == PaymentStatus.pending.rawValue {
            Button(role: .destructive, action: onReject) {
                Text("Reject request").frame(maxWidth: .infinity)
            }
            .buttonStyle(.borderedProminent)
        } else if normalized == "failed" {
            InfoCard(title: "Retry requires review", bodyText: "Retry only after re-checking fee, recipient, and the prior transaction state.")
        } else if normalized == "broadcasting" || normalized == "signed_locally" || normalized == "confirmed" {
            Button(action: onCopyTransaction) {
                Label("Copy transaction", systemImage: "doc.on.doc")
                    .frame(maxWidth: .infinity)
            }
            .buttonStyle(.bordered)
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
                        .foregroundStyle(.secondary)
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
                    Button {
                        onAccept()
                    } label: {
                        Text("Accept unverified context and Sign")
                            .frame(maxWidth: .infinity)
                    }
                    .buttonStyle(.borderedProminent)
                    .controlSize(.large)
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

extension PaymentIntent {
    var payeeDisplayName: String {
        firstNonEmpty(payeeName ?? "", restaurantName)
    }

    var sourceLabel: String {
        "Requested by \(sourceDeviceId.isEmpty ? "Agent" : sourceDeviceId) via \(sourceChannel.isEmpty ? "unknown" : sourceChannel)"
    }

    var estimatedFeeDisplay: String {
        guard let fee = paymentRequest?.payment.estimatedFee, !fee.isEmpty else { return "" }
        return asset.isEmpty ? fee : "\(fee) \(asset)"
    }

    var totalDisplay: String {
        let total = firstNonEmpty(paymentRequest?.payment.total ?? "", amount)
        return asset.isEmpty ? total : "\(total) \(asset)"
    }

    var transactionIdText: String {
        firstNonEmpty(transactionId ?? "", transactionContextSnapshot?.transactionId ?? "")
    }
}

func sortInboxIntents(_ left: PaymentIntent, _ right: PaymentIntent) -> Bool {
    let leftState = paymentReviewState(left)
    let rightState = paymentReviewState(right)
    let leftRank = inboxSortRank(leftState)
    let rightRank = inboxSortRank(rightState)
    if leftRank != rightRank { return leftRank < rightRank }
    if leftRank <= 4, left.expiresAtMs > 0, right.expiresAtMs > 0, left.expiresAtMs != right.expiresAtMs {
        return left.expiresAtMs < right.expiresAtMs
    }
    return left.createdAtMs > right.createdAtMs
}

func inboxSortRank(_ state: String) -> Int {
    switch normalizeReviewState(state) {
    case "blocked": return 0
    case "network_disabled": return 1
    case "missing_context": return 2
    case "source_review_required", "needs_review": return 3
    case "pending", "awaiting_signature": return 4
    case "failed": return 5
    case "broadcasting", "signed_locally": return 6
    default:
        return isFinalReviewState(state) ? 20 : 10
    }
}

func paymentReviewState(_ intent: PaymentIntent) -> String {
    let status = normalizeReviewState(intent.status)
    if intent.isExpired && !isFinalReviewState(status) && status != "failed" && status != "broadcasting" && status != "signed_locally" {
        return "expired"
    }
    if ["broadcasting", "signed_locally", "failed"].contains(status) || isFinalReviewState(status) {
        return status
    }
    let review = normalizeReviewState(intent.reviewState ?? "")
    if !review.isEmpty && !["ready", "pending", "awaiting_signature"].contains(review) {
        return review
    }
    if (intent.riskFindings ?? []).contains(where: \.isBlocker) { return "blocked" }
    if intent.paymentRequest?.risk.reviewStatus == "missing_context" || intent.paymentRequest?.context?.status == "missing" {
        return "missing_context"
    }
    if let snapshot = intent.transactionContextSnapshot, !snapshot.missingContext.isEmpty, intent.signingAllowed == false {
        return "missing_context"
    }
    return status.isEmpty ? "pending" : status
}

func normalizeReviewState(_ state: String) -> String {
    let value = state.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        .replacingOccurrences(of: "-", with: "_")
        .replacingOccurrences(of: " ", with: "_")
    switch value {
    case "pending_user_approval", "awaiting_user_signature":
        return "pending"
    case "broadcasted":
        return "broadcasting"
    case "signed":
        return "signed_locally"
    case "null":
        return ""
    default:
        return value
    }
}

func isActiveInboxState(_ state: String) -> Bool {
    [
        "pending",
        "awaiting_signature",
        "missing_context",
        "blocked",
        "network_disabled",
        "broadcasting",
        "failed",
        "needs_review",
        "source_review_required",
        "signed_locally"
    ].contains(normalizeReviewState(state))
}

func isFinalReviewState(_ state: String) -> Bool {
    ["confirmed", "rejected", "expired", "cancelled"].contains(normalizeReviewState(state))
}

func isPaymentDetailSignable(_ intent: PaymentIntent) -> Bool {
    let state = paymentReviewState(intent)
    return intent.canSign && ["pending", "awaiting_signature", "needs_review", "source_review_required"].contains(state)
}

func paymentRequiresWarningStepUp(_ intent: PaymentIntent) -> Bool {
    guard isPaymentDetailSignable(intent) else { return false }
    let state = paymentReviewState(intent)
    if ["needs_review", "source_review_required"].contains(state) { return true }
    if paymentRiskTone(intent) == "caution" { return true }
    return paymentWarningMessages(intent).isEmpty == false
}

func paymentRiskLabel(_ intent: PaymentIntent) -> String {
    if let request = intent.paymentRequest {
        if request.risk.level == "danger" || request.risk.reviewStatus == "blocked" { return "Risk blocked" }
        if request.risk.level == "caution" || request.risk.reviewStatus != "ready" { return "Needs review" }
        return "Low risk"
    }
    if (intent.riskFindings ?? []).contains(where: \.isBlocker) { return "Risk blocked" }
    if !(intent.riskFindings ?? []).isEmpty { return "Needs review" }
    return "Local review"
}

func paymentRiskTone(_ intent: PaymentIntent) -> String {
    if (intent.riskFindings ?? []).contains(where: \.isBlocker) { return "danger" }
    if let level = intent.paymentRequest?.risk.level.lowercased(), ["danger", "caution", "safe"].contains(level) {
        return level == "danger" ? "danger" : level == "caution" ? "caution" : "safe"
    }
    if !(intent.riskFindings ?? []).isEmpty { return "caution" }
    return "info"
}

func paymentTone(_ state: String, canSign: Bool) -> String {
    let value = normalizeReviewState(state)
    if canSign && value == "pending" { return "safe" }
    if canSign { return "caution" }
    if value == "confirmed" { return "safe" }
    if ["broadcasting", "signed_locally", "expired", "cancelled"].contains(value) { return "info" }
    if ["missing_context", "needs_review", "source_review_required", "network_disabled"].contains(value) { return "caution" }
    return "danger"
}

func paymentStatusLabel(_ state: String) -> String {
    switch normalizeReviewState(state) {
    case "missing_context": return "Missing context"
    case "blocked": return "Risk blocked"
    case "network_disabled": return "Network disabled"
    case "needs_review": return "Needs review"
    case "source_review_required": return "Source review"
    case "signed_locally": return "Signed locally"
    case "broadcasting": return "Broadcasting"
    case "failed": return "Failed"
    case "confirmed": return "Confirmed"
    case "rejected": return "Rejected"
    case "expired": return "Expired"
    case "cancelled": return "Cancelled"
    default: return "Awaiting signature"
    }
}

func paymentStateTitle(_ state: String, canSign: Bool) -> String {
    let value = normalizeReviewState(state)
    if canSign && value == "pending" { return "Ready to sign" }
    if canSign { return "Source review required" }
    if ["missing_context", "needs_review", "source_review_required"].contains(value) { return "Context needs review" }
    if value == "blocked" { return "Blocked by risk policy" }
    if value == "network_disabled" { return "Network disabled" }
    if value == "broadcasting" { return "Broadcasting" }
    if value == "signed_locally" { return "Signed locally" }
    if value == "failed" { return "Broadcast failed" }
    if value == "confirmed" { return "Signed locally" }
    if value == "rejected" { return "Rejected" }
    if value == "expired" { return "Expired" }
    return "Not signable"
}

func paymentStateCopy(_ intent: PaymentIntent, state: String, canSign: Bool) -> String {
    let value = normalizeReviewState(state)
    if canSign && value == "pending" {
        return "Payment facts and local risk checks are ready. You can reject the request or continue to local signing on this device."
    }
    if canSign {
        return "Warnings remain. Review the source groups and accept the unverified context before signing."
    }
    if value == "missing_context" {
        return "Required transaction context or evidence is missing. Payment facts remain visible, but signing is unavailable until the agent repairs the context."
    }
    if ["needs_review", "source_review_required"].contains(value) {
        return "Critical context needs review before signing can resume. Request more context or reject the request."
    }
    if value == "blocked" {
        return "A blocking risk rule prevents this request from being signed."
    }
    if value == "network_disabled" {
        return "This request targets a network that is not enabled or verified in the wallet."
    }
    if value == "broadcasting" {
        return "A local signature exists and the transaction has been submitted. Do not sign again."
    }
    if value == "signed_locally" {
        return "The transaction was signed on this device. Continue tracking it from activity instead of signing again."
    }
    if value == "failed" {
        return "The request was signed, but broadcast failed. Retry only after re-checking fee, recipient, and prior transaction state."
    }
    if value == "confirmed" {
        return "The request is final and already recorded. No new signature is allowed."
    }
    if value == "rejected" {
        return "You rejected this Payment Request. Nothing was signed."
    }
    if value == "expired" {
        return "The approval window is closed. Ask the agent to create a new request if payment is still needed."
    }
    return paymentBlockedReason(intent)
}

func paymentRiskMessages(_ intent: PaymentIntent) -> [String] {
    let findings = intent.riskFindings ?? []
    var messages = findings.map { finding in
        let prefix = finding.isBlocker ? "Blocked" : "Warning"
        return "\(prefix): \(valueOr(finding.message, finding.code))"
    }
    if paymentReviewState(intent) == "missing_context", messages.isEmpty {
        messages.append("Warning: Transaction context or evidence was not received.")
    }
    return Array(Set(messages)).sorted()
}

func paymentWarningMessages(_ intent: PaymentIntent) -> [String] {
    let warnings = (intent.riskFindings ?? [])
        .filter { !$0.isBlocker }
        .map { valueOr($0.message, $0.code) }
    if warnings.isEmpty && paymentRequiresWarningStepUpWithoutMessages(intent) {
        return ["Some claims come from AI, observed pages, or incomplete evidence. They are not verified payment facts."]
    }
    return Array(Set(warnings)).sorted()
}

private func paymentRequiresWarningStepUpWithoutMessages(_ intent: PaymentIntent) -> Bool {
    let state = paymentReviewState(intent)
    return isPaymentDetailSignable(intent) && (["needs_review", "source_review_required"].contains(state) || paymentRiskTone(intent) == "caution")
}

func paymentBlockedReason(_ intent: PaymentIntent) -> String {
    let state = paymentReviewState(intent)
    if let blocker = (intent.riskFindings ?? []).first(where: \.isBlocker) {
        return valueOr(blocker.message, blocker.code)
    }
    if intent.isExpired || state == "expired" { return "Payment request expired." }
    if isFinalReviewState(state) { return "This request is final and cannot be signed." }
    if state == "missing_context" { return "Transaction context is missing or incomplete." }
    if state == "failed" { return "Failed requests must be reviewed before retry." }
    if !intent.isPending { return "Payment request is already \(intent.status)." }
    if intent.signingAllowed == false { return "Signing is disabled by the request risk policy." }
    return "This request is not signable."
}

func paymentContextLabel(_ intent: PaymentIntent, state: String) -> String {
    if state == "missing_context" { return "Missing" }
    if intent.transactionContextSnapshot != nil { return "Ready" }
    if !(intent.transactionId ?? "").isEmpty { return "Context ref" }
    return intent.isStandardPaymentRequest ? "Not received" : "Legacy"
}

func paymentWindowText(_ intent: PaymentIntent, state: String) -> String {
    if state == "expired" { return "Expired" }
    if isFinalReviewState(state) { return "Final" }
    if intent.expiresAtMs > Int64(Date().timeIntervalSince1970 * 1000) {
        return "Expires \(dateText(intent.expiresAtMs))"
    }
    return "Expired"
}

func truthPanelSections(for intent: PaymentIntent) -> [TruthPanelSection] {
    var verified = [
        TruthPanelRow(
            field: "Payment amount",
            value: "\(valueOr(intent.amount, "0")) \(valueOr(intent.asset, ""))",
            source: "Payment fact",
            status: "Payment request fact",
            evidence: "Parsed from Payment Request",
            tone: "safe"
        ),
        TruthPanelRow(
            field: "Network and asset",
            value: "\(valueOr(intent.network, "Unknown network")) / \(valueOr(intent.asset, "Unknown asset"))",
            source: "Payment fact",
            status: "Payment request fact",
            evidence: "Hard fields shown before signing",
            tone: "safe"
        )
    ]
    if !intent.to.isEmpty {
        verified.append(
            TruthPanelRow(
                field: "Recipient address",
                value: shortAddress(intent.to),
                source: "Payment fact",
                status: intent.payeeVerified == true ? "Address verified" : "Payment request fact",
                evidence: "On-chain recipient remains visible before signing",
                tone: intent.payeeVerified == true ? "safe" : "info"
            )
        )
    }

    var merchantClaims: [TruthPanelRow] = []
    var merchantAI: [TruthPanelRow] = []
    var userAI: [TruthPanelRow] = []
    var missing: [TruthPanelRow] = []
    let snapshot = intent.transactionContextSnapshot
    var evidenceById: [String: String] = [:]
    for item in snapshot?.evidence ?? [] {
        if !item.evidenceId.isEmpty { evidenceById[item.evidenceId] = item.title }
        if !item.type.isEmpty, evidenceById[item.type] == nil { evidenceById[item.type] = item.title }
    }

    for field in snapshot?.truthFields ?? [] {
        let row = truthRow(from: field, evidenceById: evidenceById)
        switch truthBucket(for: field, row: row) {
        case "missing":
            missing.append(row)
        case "merchant_ai":
            merchantAI.append(row)
        case "user_ai":
            userAI.append(row)
        case "merchant_claims":
            merchantClaims.append(row)
        default:
            verified.append(row)
        }
    }

    for item in snapshot?.missingContext ?? [] {
        missing.append(
            TruthPanelRow(
                field: valueOr(item.field, "Missing context"),
                value: "Unavailable",
                source: "Missing",
                status: statusLabel("missing"),
                evidence: valueOr(item.reason, "Required context or evidence did not arrive."),
                tone: toneForSeverity(item.severity, fallback: "caution")
            )
        )
    }

    for finding in intent.riskFindings ?? [] {
        missing.append(
            TruthPanelRow(
                field: valueOr(finding.field, labelForRiskCode(finding.code)),
                value: finding.isBlocker ? "Blocked" : "Needs review",
                source: "Risk policy",
                status: finding.isBlocker ? "Blocked" : "Needs review",
                evidence: valueOr(finding.message, copyForRiskCode(finding.code)),
                tone: finding.isBlocker ? "danger" : "caution"
            )
        )
    }

    if snapshot == nil && intent.isStandardPaymentRequest {
        missing.append(
            TruthPanelRow(
                field: "Transaction Context",
                value: "Not received",
                source: "Missing",
                status: "Missing",
                evidence: "Payment Facts remain visible, but transaction context evidence was not received.",
                tone: intent.signingAllowed == false ? "danger" : "caution"
            )
        )
    }

    return [
        truthSection(title: "Verified facts", note: "payment and verified proof", fallbackTone: "safe", rows: verified),
        truthSection(title: "Merchant claims", note: "website or API statements", fallbackTone: "info", rows: merchantClaims),
        truthSection(title: "Merchant AI claims", note: "not signed terms", fallbackTone: "caution", rows: merchantAI),
        truthSection(title: "Your AI interpretation", note: "agent reasoning only", fallbackTone: "info", rows: userAI),
        truthSection(title: "Missing or risky", note: "needs correction or acceptance", fallbackTone: "caution", rows: missing)
    ].compactMap { $0 }
}

func truthSection(title: String, note: String, fallbackTone: String, rows: [TruthPanelRow]) -> TruthPanelSection? {
    guard !rows.isEmpty else { return nil }
    return TruthPanelSection(title: title, note: note, tone: worstTone(rows.map(\.tone), fallback: fallbackTone), rows: rows)
}

func truthRow(from field: TransactionTruthField, evidenceById: [String: String]) -> TruthPanelRow {
    let source = sourceLabel(field.sourceType)
    let status = statusLabel(field.verificationStatus)
    let evidence = firstNonEmpty(
        evidenceById[field.evidenceRef] ?? "",
        field.evidenceRef,
        defaultEvidenceCopy(sourceType: field.sourceType, verificationStatus: field.verificationStatus)
    )
    return TruthPanelRow(
        field: valueOr(field.field, "Context field"),
        value: truthValue(field),
        source: source,
        status: status,
        evidence: evidence,
        tone: truthTone(sourceType: field.sourceType, verificationStatus: field.verificationStatus)
    )
}

func truthBucket(for field: TransactionTruthField, row: TruthPanelRow) -> String {
    if ["missing", "conflicted"].contains(field.verificationStatus) || field.sourceType == "unknown" || row.tone == "danger" {
        return "missing"
    }
    if field.sourceType == "merchant_ai_claim" || field.verificationStatus == "ai_claim_only" {
        return "merchant_ai"
    }
    if field.sourceType == "user_agent_inferred" || field.verificationStatus == "inferred_only" {
        return "user_ai"
    }
    if isStrongVerification(field.verificationStatus) || field.sourceType == "payment_request_fact" || field.sourceType == "wallet_derived" || field.sourceType == "platform_verified" {
        return "verified"
    }
    if ["merchant_web_observed", "merchant_api_response", "merchant_signed_quote"].contains(field.sourceType) {
        return "merchant_claims"
    }
    return row.tone == "caution" ? "missing" : "verified"
}

func truthValue(_ field: TransactionTruthField) -> String {
    let value = valueOr(field.value, "Unavailable")
    guard !field.currency.isEmpty, !value.contains(field.currency) else { return value }
    return "\(value) \(field.currency)"
}

func truthTone(sourceType: String, verificationStatus: String) -> String {
    if ["conflicted", "missing"].contains(verificationStatus) { return "danger" }
    if sourceType == "merchant_ai_claim" || verificationStatus == "ai_claim_only" ||
        sourceType == "user_agent_inferred" || verificationStatus == "inferred_only" ||
        verificationStatus == "observed_only" || verificationStatus == "unverified" ||
        sourceType == "unknown" {
        return "caution"
    }
    if isStrongVerification(verificationStatus) || sourceType == "payment_request_fact" || sourceType == "wallet_derived" {
        return "safe"
    }
    return "info"
}

func isStrongVerification(_ value: String) -> Bool {
    [
        "signature_verified",
        "domain_verified",
        "address_verified",
        "api_authenticated",
        "payment_request_fact",
        "wallet_derived"
    ].contains(value)
}

func sourceLabel(_ value: String) -> String {
    switch value {
    case "payment_request_fact": return "Payment fact"
    case "wallet_derived": return "Wallet derived"
    case "user_provided": return "You provided"
    case "user_agent_inferred": return "Your AI inferred"
    case "merchant_web_observed": return "Website observed"
    case "merchant_ai_claim": return "Merchant AI said"
    case "merchant_api_response": return "Merchant API"
    case "merchant_signed_quote": return "Signed quote"
    case "platform_verified": return "Velarum verified"
    case "external_verified": return "Third-party verified"
    case "unknown": return "Unknown source"
    case "missing": return "Missing"
    default: return titleize(value, fallback: "Unknown source")
    }
}

func statusLabel(_ value: String) -> String {
    switch value {
    case "signature_verified": return "Signature verified"
    case "domain_verified": return "Domain verified"
    case "address_verified": return "Address verified"
    case "api_authenticated": return "API authenticated"
    case "observed_only": return "Observed only"
    case "ai_claim_only": return "AI claim only"
    case "inferred_only": return "Inferred only"
    case "conflicted": return "Conflicted"
    case "missing": return "Missing"
    case "unverified": return "Unverified"
    case "payment_request_fact": return "Payment request fact"
    case "wallet_derived": return "Wallet derived"
    default: return titleize(value, fallback: "Unverified")
    }
}

func labelForRiskCode(_ code: String) -> String {
    if code.contains("amount") { return "Amount match" }
    if code.contains("payee") || code.contains("recipient") { return "Payee match" }
    if code.contains("asset") { return "Asset match" }
    if code.contains("network") { return "Network match" }
    if code.contains("missing") { return "Transaction Context" }
    if code.contains("ai") { return "AI-only critical field" }
    return titleize(code, fallback: "Risk finding")
}

func copyForRiskCode(_ code: String) -> String {
    if code.contains("amount") { return "Payment amount conflicts with transaction context." }
    if code.contains("payee") || code.contains("recipient") { return "Payee or recipient evidence conflicts with the Payment Request." }
    if code.contains("asset") { return "Asset evidence conflicts with the Payment Request." }
    if code.contains("network") { return "Network evidence conflicts with the Payment Request." }
    if code.contains("missing") { return "Required transaction context or evidence was not received." }
    if code.contains("ai") { return "A critical field only comes from AI or observed text, so it cannot be treated as verified." }
    return "Review this source before signing."
}

func defaultEvidenceCopy(sourceType: String, verificationStatus: String) -> String {
    if sourceType == "merchant_ai_claim" || verificationStatus == "ai_claim_only" {
        return "No signed terms or verified evidence attached."
    }
    if sourceType == "user_agent_inferred" || verificationStatus == "inferred_only" {
        return "Agent reasoning only; it does not prove merchant identity or payment terms."
    }
    if verificationStatus == "observed_only" {
        return "Observed source only; not verified by signed quote."
    }
    if verificationStatus == "missing" {
        return "Required evidence did not arrive."
    }
    return "Evidence reference was not attached."
}

func toneForSeverity(_ severity: String, fallback: String) -> String {
    let value = severity.lowercased()
    if value.contains("block") || value.contains("error") || value.contains("danger") { return "danger" }
    if value.contains("warn") || value.contains("review") || value.contains("caution") { return "caution" }
    return fallback
}

func worstTone(_ tones: [String], fallback: String) -> String {
    if tones.contains("danger") { return "danger" }
    if tones.contains("caution") { return "caution" }
    if tones.contains("info") { return "info" }
    return fallback
}

func truthToneLabel(_ tone: String) -> String {
    switch tone {
    case "danger": return "Blocked"
    case "caution": return "Review"
    case "safe": return "Verified"
    default: return "Info"
    }
}

func toneColor(_ tone: String) -> Color {
    switch tone {
    case "safe": return .green
    case "caution": return .orange
    case "danger": return .red
    default: return .blue
    }
}

func toneBackground(_ tone: String) -> Color {
    toneColor(tone).opacity(0.12)
}

func titleize(_ value: String, fallback: String) -> String {
    let clean = value.replacingOccurrences(of: "_", with: " ").replacingOccurrences(of: "-", with: " ").trimmingCharacters(in: .whitespacesAndNewlines)
    guard let first = clean.first else { return fallback }
    return String(first).uppercased() + clean.dropFirst()
}

func valueOr(_ value: String, _ fallback: String) -> String {
    let clean = value.trimmingCharacters(in: .whitespacesAndNewlines)
    return clean.isEmpty || clean.lowercased() == "null" ? fallback : clean
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
