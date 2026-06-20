// Pairing scanner / review views
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
        label.text = "Camera is required to scan QR codes."
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
                                    .foregroundStyle(VPColor.textMuted)
                            }
                        }
                    }
                    InfoCard(
                        title: "No signing permission",
                        bodyText: "Pairing is not payment approval. Agents can prepare requests or read their own status only; every payment still needs review and local signing on this device."
                    )
                    if !session.isPending {
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
            .safeAreaInset(edge: .bottom) {
                if session.isPending {
                    FloatingActionBar {
                        HStack {
                            Button(role: .destructive) {
                                app.rejectPairing(session)
                            } label: {
                                Text("Reject").frame(maxWidth: .infinity)
                            }
                            .buttonStyle(VPButtonStyle(kind: .secondary))
                            Button {
                                app.approvePairing(session, scopes: approvedScopes)
                            } label: {
                                Text("Approve Selected").frame(maxWidth: .infinity)
                            }
                            .buttonStyle(VPButtonStyle(kind: .primary))
                        }
                    }
                }
            }
        }
    }
}

