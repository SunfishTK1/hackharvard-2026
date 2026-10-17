import Messages
import SwiftUI
import UIKit

/// The Charles Sprint iMessage mini app.
///
/// - transcript: draws the live card bubble for the chat's race (MSMessageLiveLayout).
/// - compact: a launcher in the app drawer.
/// - expanded: the full race. Finishing posts to the shared leaderboard and updates the card
///   in the same MSSession, so the chat keeps one card that shows the latest result. Cards
///   sent by the Spectrum agent work the same way, and the agent sees the update.
final class MessagesViewController: MSMessagesAppViewController {
    private let model = ChatModel()
    private var hostView: UIView?

    override func viewDidLoad() {
        super.viewDidLoad()
        let actions = ChatActions(
            start: { [weak self] in self?.requestPresentationStyle(.expanded) },
            invite: { [weak self] in self?.insertCard() },
            share: { [weak self] race in self?.share(race) }
        )
        let host = UIHostingController(rootView: ExtensionRoot(model: model, actions: actions))
        host.view.backgroundColor = .white
        addChild(host)
        host.view.frame = view.bounds
        host.view.autoresizingMask = [.flexibleWidth, .flexibleHeight]
        view.addSubview(host.view)
        host.didMove(toParent: self)
        hostView = host.view
    }

    override func willBecomeActive(with conversation: MSConversation) {
        super.willBecomeActive(with: conversation)
        // In the transcript, selectedMessage is the bubble being drawn; otherwise it is the card
        // the user tapped to open us (nil when opened from the app drawer).
        model.challenge = ChatChallenge(url: conversation.selectedMessage?.url)
        apply(presentationStyle)
    }

    override func willTransition(to presentationStyle: MSMessagesAppPresentationStyle) {
        super.willTransition(to: presentationStyle)
        apply(presentationStyle)
    }

    override func didSelect(_ message: MSMessage, conversation: MSConversation) {
        super.didSelect(message, conversation: conversation)
        model.challenge = ChatChallenge(url: message.url)
    }

    /// Height of the live bubble in the transcript.
    override func contentSizeThatFits(_ size: CGSize) -> CGSize {
        CGSize(width: size.width, height: (size.width * 0.62).rounded())
    }

    private func apply(_ style: MSMessagesAppPresentationStyle) {
        model.style = style
        // Let taps on the transcript bubble fall through to Messages, which opens us expanded.
        hostView?.isUserInteractionEnabled = style != .transcript
    }

    /// Updates the chat's card with this result and sends it.
    private func share(_ race: FinishedRace) {
        guard let conversation = activeConversation else { return }
        var challenge = model.challenge
        challenge.add(name: race.name, time: race.time)
        model.challenge = challenge
        let message = makeMessage(challenge, rank: race.rank, session: conversation.selectedMessage?.session)
        message.summaryText = "\(race.name) rowed the Charles Sprint in \(formatTime(race.time))"
        conversation.send(message) { error in
            // send() needs a recent user action; fall back to the compose field.
            if error != nil { DispatchQueue.main.async { conversation.insert(message) } }
        }
        requestPresentationStyle(.compact)
    }

    /// Puts a fresh race card in the compose field so the user can add a note and send it.
    private func insertCard() {
        guard let conversation = activeConversation else { return }
        let message = makeMessage(model.challenge, rank: nil, session: nil)
        message.summaryText = "Charles Sprint: row 500 m up the Charles"
        conversation.insert(message)
    }

    private func makeMessage(_ challenge: ChatChallenge, rank: Int?, session: MSSession?) -> MSMessage {
        let message = MSMessage(session: session ?? MSSession())
        message.url = challenge.url(base: API.baseURL)
        message.layout = CardLayout.make(challenge, rank: rank)
        return message
    }
}

@MainActor
@Observable
final class ChatModel {
    var style: MSMessagesAppPresentationStyle = .compact
    var challenge = ChatChallenge()
}

struct ChatActions {
    let start: () -> Void
    let invite: () -> Void
    let share: (FinishedRace) -> Void
}

struct ExtensionRoot: View {
    let model: ChatModel
    let actions: ChatActions

    var body: some View {
        Group {
            switch model.style {
            case .transcript:
                CardArt(challenge: model.challenge)
            case .expanded:
                RaceView(challenge: model.challenge, shareLabel: "SEND TO CHAT", onShare: actions.share)
            default:
                CompactView(challenge: model.challenge, start: actions.start, invite: actions.invite)
            }
        }
        .environment(\.colorScheme, .light)
    }
}
