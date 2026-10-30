// Color & View convenience extensions
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

extension Color {
    // Re-pointed to the Velar Teal design system (VPColor) so the legacy `app*`
    // surface helpers used across every screen now resolve to DS tokens. This
    // flips page/card/field backgrounds to the teal DS app-wide with no per-site
    // edits. (2026-06-20 — teal DS rollout to the remaining iOS screens.)
    static var appGroupedBackground: Color { VPColor.surfacePage }
    static var appSecondaryGroupedBackground: Color { VPColor.surfaceSunken }
    static var appSystemBackground: Color { VPColor.surfaceCard }
    static var appSeparator: Color { VPColor.borderSubtle }
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

// MARK: - Shared money & address formatting (code-quality review D9 / Q4,Q5, 2026-06-20)
//
// Single home on iOS for "decimal string -> integer base units" conversion and for
// shortening addresses/hashes, mirroring Android's AmountUnits / AddressFormat. Exact
// string / integer math only — never floating point. The SIGNING path is unchanged:
// production routes through the shared Rust core (see StellarService.xlmToStroops);
// only the native fallback math, the token base-units helper, and the display
// shortener are consolidated here so the previously duplicated copies can't drift.

enum AmountUnits {
    /// Native XLM -> stroops fallback (1 XLM = 10^7 stroops). This is the exact
    /// cross-check oracle for PaytobeWalletCoreConformanceTests; the production path
    /// uses the shared Rust core. Pure integer math — moved verbatim from
    /// StellarService.xlmToStroops's native branch.
    static func xlmToStroopsNative(_ text: String) throws -> Int64 {
        let clean = text.trimmingCharacters(in: .whitespacesAndNewlines)
        let parts = clean.split(separator: ".", omittingEmptySubsequences: false)
        guard !parts.isEmpty, (parts.count == 1 || parts.count == 2), let whole = Int64(parts[0]) else {
            throw AppError.invalidResponse("Invalid XLM amount.")
        }
        let fractional = parts.count == 2 ? String(parts[1]) : ""
        guard fractional.count <= 7, fractional.allSatisfy({ $0.isNumber }) else {
            throw AppError.invalidResponse("XLM supports at most 7 decimal places.")
        }
        let paddedFraction = fractional.padding(toLength: 7, withPad: "0", startingAt: 0)
        guard let stroopFraction = Int64(paddedFraction) else {
            throw AppError.invalidResponse("Invalid XLM amount.")
        }
        let amount = whole * 10_000_000 + stroopFraction
        guard amount > 0 else { throw AppError.invalidResponse("XLM amount must be greater than zero.") }
        return amount
    }

    /// Exact decimal -> integer base-unit string (e.g. ETH -> wei, SOL -> lamports).
    /// Moved verbatim from the former `TokenAmount.baseUnits`.
    static func baseUnits(_ amount: String, decimals: Int) throws -> String {
        let clean = amount.trimmingCharacters(in: .whitespacesAndNewlines)
        let parts = clean.split(separator: ".", omittingEmptySubsequences: false)
        guard !parts.isEmpty, parts.count <= 2 else {
            throw AppError.invalidResponse("Enter a valid amount, for example 1.5.")
        }
        let whole = String(parts[0])
        let frac = parts.count == 2 ? String(parts[1]) : ""
        guard whole.allSatisfy({ $0.isNumber }), frac.allSatisfy({ $0.isNumber }), frac.count <= decimals else {
            throw AppError.invalidResponse("This asset supports at most \(decimals) decimal places.")
        }
        let padded = frac + String(repeating: "0", count: decimals - frac.count)
        var digits = (whole.isEmpty ? "0" : whole) + padded
        while digits.count > 1, digits.first == "0" { digits.removeFirst() }
        guard digits.contains(where: { $0 != "0" }) else {
            throw AppError.invalidResponse("Amount must be greater than zero.")
        }
        return digits
    }
}

enum AddressFormat {
    private static let ellipsis = "…"

    /// 10 … 8 form for full addresses / hashes (e.g. `GB3JDWCQJC…N64VJBDQ`). Values of
    /// 18 chars or fewer are returned unchanged. Standardised on the "…" ellipsis to
    /// match Android's AddressFormat.medium (the old inline copy used ASCII "...").
    static func shortAddress(_ value: String) -> String {
        guard value.count > 18 else { return value }
        return "\(value.prefix(10))\(ellipsis)\(value.suffix(8))"
    }
}
