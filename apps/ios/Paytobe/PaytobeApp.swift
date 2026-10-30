import SwiftUI

@main
struct PaytobeApp: App {
    @StateObject private var appState = AppState()
    @Environment(\.scenePhase) private var scenePhase

    init() {
        VPFonts.registerBundled()
    }

    var body: some Scene {
        WindowGroup {
            ContentView()
                .environmentObject(appState)
                .onChange(of: scenePhase, initial: true) { _, newPhase in
                    appState.handleScenePhase(newPhase)
                }
        }
    }
}
