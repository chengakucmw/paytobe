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
