import SwiftUI

/// The standalone app. The iMessage mini app lives in the MessagesExtension target.
@main
struct CharlesSprintApp: App {
    var body: some Scene {
        WindowGroup {
            RaceView(footnote: "Race your friends in iMessage: open a chat, tap +, then Charles Sprint.")
                .preferredColorScheme(.light)
        }
    }
}
