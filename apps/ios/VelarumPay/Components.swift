// Reusable UI components (cards, pills, rows, bars)
// Extracted verbatim from ContentView.swift — behavior-preserving split (2026-06-20).

import SwiftUI
import CoreImage
import CoreText

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
                .foregroundStyle(VPColor.textMuted)
        }
    }
}

/// Payment progress / confirmed sheet — restyled to the teal DS (prototype 09).
/// Honest about state: a green check + "Done" only when the lifecycle is actually
/// dismissible; otherwise a spinner. No fabricated step timestamps.
struct PaymentProgressView: View {
    @EnvironmentObject private var app: AppState
    let progress: PaymentProgress

    var body: some View {
        VStack(spacing: VPSpace.s5) {
            Capsule()
                .fill(VPColor.ink200)
                .frame(width: 44, height: 5)
                .padding(.top, VPSpace.s2)

            VStack(spacing: VPSpace.s3) {
                ZStack {
                    Circle()
                        .fill(progress.canDismiss ? VPColor.positiveSoft : VPColor.brandSoft)
                        .frame(width: 84, height: 84)
                    if progress.canDismiss {
                        Image(systemName: "checkmark")
                            .font(.system(size: 36, weight: .bold))
                            .foregroundStyle(VPColor.positive)
                    } else {
                        ProgressView().scaleEffect(1.4).tint(VPColor.brand)
                    }
                }
                Text(progress.title)
                    .font(VPType.display(24, .semibold))
                    .foregroundStyle(VPColor.textPrimary)
                    .multilineTextAlignment(.center)
                Text(progress.message)
                    .font(VPType.sans(14))
                    .foregroundStyle(VPColor.textSecondary)
                    .multilineTextAlignment(.center)
            }
            .frame(maxWidth: .infinity)
            .padding(.top, VPSpace.s2)

            if let detail = progress.detail, !detail.isEmpty {
                Button {
                    app.copy(detail)
                } label: {
                    HStack(spacing: VPSpace.s3) {
                        ZStack {
                            RoundedRectangle(cornerRadius: VPRadius.sm).fill(VPColor.brandSoft).frame(width: 38, height: 38)
                            Image(systemName: "link").font(.system(size: 15, weight: .semibold)).foregroundStyle(VPColor.textBrand)
                        }
                        VStack(alignment: .leading, spacing: 2) {
                            Text(progress.canDismiss ? "Transaction" : "Local transaction")
                                .font(VPType.sans(14, .semibold)).foregroundStyle(VPColor.textPrimary)
                            Text(detail)
                                .font(VPType.mono(13)).foregroundStyle(VPColor.textMuted)
                                .lineLimit(1).truncationMode(.middle)
                        }
                        Spacer(minLength: 0)
                        Image(systemName: "doc.on.doc").font(.system(size: 14)).foregroundStyle(VPColor.textMuted)
                    }
                    .padding(VPSpace.s4)
                    .frame(maxWidth: .infinity)
                    .background(VPColor.surfaceCard, in: RoundedRectangle(cornerRadius: VPRadius.lg))
                    .overlay(RoundedRectangle(cornerRadius: VPRadius.lg).stroke(VPColor.borderSubtle, lineWidth: 1))
                }
                .buttonStyle(.plain)
            }

            Spacer(minLength: 0)

            if progress.canDismiss {
                Button {
                    app.closeProgress()
                } label: {
                    Text("Done")
                        .font(VPType.sans(16, .semibold))
                        .foregroundStyle(.white)
                        .frame(maxWidth: .infinity)
                        .padding(.vertical, 15)
                        .background(VPColor.ink900, in: RoundedRectangle(cornerRadius: VPRadius.pill))
                }
                .buttonStyle(.plain)
            }
        }
        .padding(VPSpace.s5)
        .frame(maxWidth: .infinity)
        .background(VPColor.surfacePage)
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
                        .foregroundStyle(VPColor.textMuted)
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
                    .foregroundStyle(VPColor.textMuted)
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

    // Inbox request card — matches prototype 10 (token · name · amount · status).
    var body: some View {
        HStack(spacing: VPSpace.s3) {
            VPTokenBadge(symbol: String(valueOr(intent.payeeDisplayName, intent.title).prefix(1)).uppercased())
            VStack(alignment: .leading, spacing: 5) {
                HStack(spacing: VPSpace.s2) {
                    Text(valueOr(intent.payeeDisplayName, intent.title))
                        .font(VPType.sans(16, .semibold)).foregroundStyle(VPColor.textPrimary).lineLimit(1)
                    Spacer(minLength: 0)
                    Text("\(intent.amount) \(intent.asset)")
                        .font(VPType.mono(15, .semibold)).foregroundStyle(VPColor.textPrimary)
                }
                HStack(spacing: VPSpace.s2) {
                    Text(intent.summary)
                        .font(VPType.sans(13)).foregroundStyle(VPColor.textMuted).lineLimit(1)
                    Spacer(minLength: 0)
                    TonePill(text: paymentStatusLabel(state), tone: paymentTone(state, canSign: isPaymentDetailSignable(intent)))
                }
            }
        }
        .padding(.vertical, VPSpace.s2)
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
                .foregroundStyle(VPColor.textMuted)
            Text(connection.scopeSummary)
                .font(.caption.monospaced())
                .foregroundStyle(VPColor.textMuted)
                .lineLimit(2)
        }
        .padding(.vertical, 6)
    }
}

struct HistoryRow: View {
    let item: HistoryEntry

    // Activity row — matches prototype 15 (icon · title · date · amount · status).
    var body: some View {
        HStack(spacing: VPSpace.s3) {
            ZStack {
                Circle().fill(VPColor.surfaceSunken).frame(width: 40, height: 40)
                Image(systemName: "arrow.up.right")
                    .font(.system(size: 16, weight: .semibold))
                    .foregroundStyle(VPColor.textSecondary)
            }
            VStack(alignment: .leading, spacing: 3) {
                Text(item.title)
                    .font(VPType.sans(16, .semibold)).foregroundStyle(VPColor.textPrimary).lineLimit(1)
                Text(Date(timeIntervalSince1970: Double(item.createdAtMs) / 1000), style: .date)
                    .font(VPType.sans(13)).foregroundStyle(VPColor.textMuted)
            }
            Spacer(minLength: 0)
            VStack(alignment: .trailing, spacing: 4) {
                Text("\(item.amount) \(item.asset)")
                    .font(VPType.mono(15, .semibold)).foregroundStyle(VPColor.textPrimary)
                StatusPill(text: item.status)
            }
        }
        .padding(.vertical, VPSpace.s2)
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
                    .foregroundStyle(VPColor.textMuted)
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
            .font(VPType.sans(12, .semibold))
            .padding(.horizontal, 11)
            .padding(.vertical, 5)
            .background(VPColor.brandSoft, in: Capsule())
            .foregroundStyle(VPColor.textBrand)
    }
}

struct TonePill: View {
    let text: String
    let tone: String

    var body: some View {
        HStack(spacing: 4) {
            Image(systemName: toneIcon(tone))
            Text(text.isEmpty ? "Info" : text)
        }
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
                Text(bodyText).foregroundStyle(VPColor.textMuted)
            }
        }
    }
}

struct Card<Content: View>: View {
    @ViewBuilder var content: Content

    var body: some View {
        content
            .padding(VPSpace.s5)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(VPColor.surfaceCard, in: RoundedRectangle(cornerRadius: VPRadius.lg))
            .overlay(
                RoundedRectangle(cornerRadius: VPRadius.lg)
                    .stroke(VPColor.borderSubtle, lineWidth: 1)
            )
            .shadow(color: VPColor.ink900.opacity(0.06), radius: 8, x: 0, y: 4)
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

// ============================================================================
// MARK: - Velar Teal Design System (foundation)
// Added 2026-06-20 to align iOS with prototypes/html20260620 (teal DS).
// Tokens mirror ds/tokens/*.css. Visual only — no business logic.
// ============================================================================

extension Color {
    /// Create a Color from a 0xRRGGBB hex literal.
    init(hex: UInt, alpha: Double = 1) {
        self.init(
            .sRGB,
            red: Double((hex >> 16) & 0xFF) / 255,
            green: Double((hex >> 8) & 0xFF) / 255,
            blue: Double(hex & 0xFF) / 255,
            opacity: alpha
        )
    }
}

/// Semantic color roles — mirror ds/tokens/colors.css SEMANTIC ALIASES.
enum VPColor {
    // Brand · Velar Teal
    static let brand        = Color(hex: 0x0FA48E)
    static let brandStrong  = Color(hex: 0x0B8676)
    static let brandSoft    = Color(hex: 0xE6F7F4)
    static let teal400      = Color(hex: 0x2BB6A2)
    static let teal700      = Color(hex: 0x0C6B5F)
    static let mint         = Color(hex: 0x43E3BD)
    // Ink (green-tinted neutral)
    static let ink900       = Color(hex: 0x0B1310)
    static let ink700       = Color(hex: 0x28342F)
    static let ink500       = Color(hex: 0x64726B)
    static let ink400       = Color(hex: 0x8B978F)
    static let ink200       = Color(hex: 0xD8DEDA)
    static let ink100       = Color(hex: 0xECF0EE)
    static let ink50        = Color(hex: 0xF6F8F7)
    // Text
    static let textPrimary   = ink900
    static let textSecondary = Color(hex: 0x45524C)
    static let textMuted     = ink400
    static let textBrand     = brandStrong
    // Surfaces
    static let surfacePage   = ink50
    static let surfaceCard   = Color.white
    static let surfaceSunken = ink100
    static let surfaceInk    = ink900
    // Borders
    static let borderSubtle  = ink100
    static let borderDefault = ink200
    // Semantic roles
    static let positive      = Color(hex: 0x1FB57A)
    static let positiveSoft  = Color(hex: 0xE4F7EE)
    static let negative      = Color(hex: 0xE5484D)
    static let negativeSoft  = Color(hex: 0xFCEBEC)
    static let warning       = Color(hex: 0xF5A524)
    static let warningSoft   = Color(hex: 0xFDF3E2)
    static let warningText   = Color(hex: 0x9A6800)
    static let info          = Color(hex: 0x2B8AEF)
    static let infoSoft      = Color(hex: 0xE7F1FD)
}

enum VPSpace {
    static let s1: CGFloat = 4
    static let s2: CGFloat = 8
    static let s3: CGFloat = 12
    static let s4: CGFloat = 16
    static let s5: CGFloat = 20
    static let s6: CGFloat = 24
    static let s8: CGFloat = 32
    static let s10: CGFloat = 40
}

enum VPRadius {
    static let sm: CGFloat = 12
    static let md: CGFloat = 16
    static let lg: CGFloat = 20
    static let xl: CGFloat = 24
    static let pill: CGFloat = 999
}

/// Brand type ramp — resolves the bundled OFL fonts by PostScript name per weight.
/// The static TTFs use weight-specific family names ("Manrope SemiBold", …), so we
/// cannot rely on family + .weight(); we name each face explicitly. Falls back to
/// the system font until VPFonts.registerBundled() runs at launch.
enum VPType {
    static func display(_ size: CGFloat, _ weight: Font.Weight = .semibold) -> Font {
        .custom(VPFonts.displayName(weight), size: size)
    }
    static func sans(_ size: CGFloat, _ weight: Font.Weight = .regular) -> Font {
        .custom(VPFonts.sansName(weight), size: size)
    }
    static func mono(_ size: CGFloat, _ weight: Font.Weight = .regular) -> Font {
        .custom(VPFonts.monoName(weight), size: size)
    }
}

/// Registers the bundled .ttf files (in the app's Fonts/ folder reference) at launch
/// and maps a SwiftUI Font.Weight to the matching bundled PostScript name.
enum VPFonts {
    private static var didRegister = false

    static func registerBundled() {
        guard !didRegister else { return }
        didRegister = true
        #if canImport(UIKit)
        let inFolder = Bundle.main.urls(forResourcesWithExtension: "ttf", subdirectory: "Fonts") ?? []
        let atRoot = Bundle.main.urls(forResourcesWithExtension: "ttf", subdirectory: nil) ?? []
        for url in (inFolder + atRoot) {
            CTFontManagerRegisterFontsForURL(url as CFURL, .process, nil)
        }
        #endif
    }

    static func displayName(_ w: Font.Weight) -> String {
        if w == .bold || w == .heavy || w == .black { return "SpaceGrotesk-Bold" }
        if w == .medium || w == .regular || w == .light || w == .thin || w == .ultraLight { return "SpaceGrotesk-Medium" }
        return "SpaceGrotesk-SemiBold"
    }
    static func sansName(_ w: Font.Weight) -> String {
        if w == .bold || w == .heavy || w == .black { return "Manrope-Bold" }
        if w == .semibold { return "Manrope-SemiBold" }
        if w == .medium { return "Manrope-Medium" }
        return "Manrope-Regular"
    }
    static func monoName(_ w: Font.Weight) -> String {
        if w == .bold || w == .heavy || w == .black || w == .semibold { return "JetBrainsMono-SemiBold" }
        if w == .medium { return "JetBrainsMono-Medium" }
        return "JetBrainsMono-Regular"
    }
}

// MARK: DS components used by the Home screen

/// Tone scale for badges/pills, mirroring the prototype's .badge--* variants.
enum VPTone { case neutral, brand, positive, negative, warning, info, ink }

struct VPBadge: View {
    let text: String
    var tone: VPTone = .neutral
    var showDot: Bool = false

    private var fg: Color {
        switch tone {
        case .neutral: return VPColor.ink700
        case .brand: return VPColor.textBrand
        case .positive: return VPColor.positive
        case .negative: return VPColor.negative
        case .warning: return VPColor.warningText
        case .info: return VPColor.info
        case .ink: return .white
        }
    }
    private var bg: Color {
        switch tone {
        case .neutral: return VPColor.ink100
        case .brand: return VPColor.brandSoft
        case .positive: return VPColor.positiveSoft
        case .negative: return VPColor.negativeSoft
        case .warning: return VPColor.warningSoft
        case .info: return VPColor.infoSoft
        case .ink: return VPColor.ink900
        }
    }
    var body: some View {
        HStack(spacing: 6) {
            if showDot { Circle().fill(fg).frame(width: 6, height: 6) }
            Text(text).font(VPType.sans(12, .semibold))
        }
        .padding(.horizontal, 10)
        .padding(.vertical, 4)
        .foregroundStyle(fg)
        .background(bg, in: Capsule())
    }
}

/// Frosted chip used on the hero gradient (e.g. "Stellar mainnet").
struct VPGlassChip: View {
    let text: String
    var body: some View {
        Text(text)
            .font(VPType.sans(13, .semibold))
            .foregroundStyle(.white)
            .padding(.horizontal, 12)
            .padding(.vertical, 6)
            .background(.white.opacity(0.16), in: Capsule())
            .overlay(Capsule().stroke(.white.opacity(0.18), lineWidth: 1))
    }
}

/// Teal→ink gradient "hero" container (the balance/status card surface).
struct VPHeroCard<Content: View>: View {
    @ViewBuilder var content: Content
    var body: some View {
        content
            .padding(VPSpace.s6)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(
                LinearGradient(
                    colors: [VPColor.brand, VPColor.teal700, VPColor.ink900],
                    startPoint: .topLeading, endPoint: .bottomTrailing
                ),
                in: RoundedRectangle(cornerRadius: VPRadius.xl)
            )
            .overlay(
                RoundedRectangle(cornerRadius: VPRadius.xl)
                    .fill(
                        RadialGradient(
                            colors: [Color.white.opacity(0.20), .clear],
                            center: .topTrailing, startRadius: 0, endRadius: 170
                        )
                    )
                    .allowsHitTesting(false)
            )
            .shadow(color: VPColor.brand.opacity(0.28), radius: 18, x: 0, y: 10)
    }
}

/// Circular icon + label quick action (Receive / Register / …).
struct VPQuickAction: View {
    let icon: String
    let label: String
    var onHero: Bool = false
    let action: () -> Void
    var body: some View {
        Button(action: action) {
            VStack(spacing: VPSpace.s2) {
                ZStack {
                    Circle()
                        .fill(onHero ? Color.white.opacity(0.16) : VPColor.ink900)
                        .frame(width: 54, height: 54)
                    Image(systemName: icon)
                        .font(.system(size: 19, weight: .semibold))
                        .foregroundStyle(.white)
                }
                Text(label)
                    .font(VPType.sans(13, .semibold))
                    .foregroundStyle(onHero ? Color.white.opacity(0.82) : VPColor.textSecondary)
            }
            .frame(maxWidth: .infinity)
        }
        .buttonStyle(.plain)
    }
}

/// Section header with an optional trailing action ("Assets / See all").
struct VPSectionHeader: View {
    let title: String
    var actionLabel: String? = nil
    var action: (() -> Void)? = nil
    var body: some View {
        HStack(alignment: .firstTextBaseline) {
            Text(title).font(VPType.display(18, .semibold)).foregroundStyle(VPColor.textPrimary)
            Spacer()
            if let actionLabel, let action {
                Button(actionLabel, action: action)
                    .font(VPType.sans(14, .semibold))
                    .foregroundStyle(VPColor.textBrand)
            }
        }
        .padding(.top, VPSpace.s2)
    }
}

/// Circular token monogram.
struct VPTokenBadge: View {
    let symbol: String
    var gradient: [Color] = [VPColor.teal400, VPColor.teal700]
    var body: some View {
        ZStack {
            Circle().fill(LinearGradient(colors: gradient, startPoint: .topLeading, endPoint: .bottomTrailing))
                .frame(width: 44, height: 44)
            Text(symbol).font(VPType.display(15, .bold)).foregroundStyle(.white)
        }
    }
}

/// Brand header (logo + name + scan/inbox icon buttons).
struct VPBrandHeader: View {
    var onScan: () -> Void
    var onInbox: () -> Void
    var inboxBadge: Bool = false
    var body: some View {
        HStack(spacing: VPSpace.s3) {
            ZStack {
                RoundedRectangle(cornerRadius: 12)
                    .fill(LinearGradient(colors: [VPColor.teal400, VPColor.brandStrong], startPoint: .topLeading, endPoint: .bottomTrailing))
                    .frame(width: 40, height: 40)
                Image(systemName: "arrow.up").font(.system(size: 18, weight: .bold)).foregroundStyle(.white)
            }
            VStack(alignment: .leading, spacing: 0) {
                Text("VelarumPay").font(VPType.display(20, .bold)).foregroundStyle(VPColor.textPrimary)
                Text("Self-custody wallet").font(VPType.sans(13)).foregroundStyle(VPColor.textMuted)
            }
            Spacer()
            VPIconButton(icon: "qrcode.viewfinder", action: onScan)
            VPIconButton(icon: "bell", badge: inboxBadge, action: onInbox)
        }
        .padding(.top, VPSpace.s2)
    }
}

struct VPIconButton: View {
    let icon: String
    var badge: Bool = false
    let action: () -> Void
    var body: some View {
        Button(action: action) {
            Image(systemName: icon)
                .font(.system(size: 18, weight: .medium))
                .foregroundStyle(VPColor.textPrimary)
                .frame(width: 44, height: 44)
                .background(VPColor.surfaceCard, in: Circle())
                .overlay(alignment: .topTrailing) {
                    if badge {
                        Circle().fill(VPColor.negative).frame(width: 8, height: 8).offset(x: -8, y: 8)
                    }
                }
                .shadow(color: VPColor.ink900.opacity(0.06), radius: 4, x: 0, y: 2)
        }
        .buttonStyle(.plain)
    }
}

/// DS pill button style (mirrors the prototype .btn variants). Apply with
/// `.buttonStyle(VPButtonStyle(kind: .primary))`.
struct VPButtonStyle: ButtonStyle {
    enum Kind { case primary, brand, secondary, danger }
    var kind: Kind = .primary

    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .font(VPType.sans(16, .semibold))
            .foregroundStyle(foreground)
            .frame(maxWidth: .infinity)
            .padding(.vertical, 14)
            .background(background, in: RoundedRectangle(cornerRadius: VPRadius.pill))
            .overlay {
                if let border {
                    RoundedRectangle(cornerRadius: VPRadius.pill).stroke(border, lineWidth: 1)
                }
            }
            .opacity(configuration.isPressed ? 0.85 : 1)
            .scaleEffect(configuration.isPressed ? 0.98 : 1)
    }

    private var foreground: Color {
        switch kind {
        case .primary, .brand, .danger: return .white
        case .secondary: return VPColor.textPrimary
        }
    }
    private var background: Color {
        switch kind {
        case .primary: return VPColor.ink900
        case .brand: return VPColor.brand
        case .secondary: return VPColor.surfaceCard
        case .danger: return VPColor.negative
        }
    }
    private var border: Color? { kind == .secondary ? VPColor.borderDefault : nil }
}

