import SwiftUI

@main
struct VelarumPayApp: App {
    @StateObject private var appState = AppState()
    @Environment(\.scenePhase) private var scenePhase

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
