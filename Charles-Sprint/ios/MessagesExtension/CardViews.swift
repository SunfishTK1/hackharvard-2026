import Messages
import SwiftUI

/// The card art: drawn live in the transcript bubble, and rendered to an image for the
/// template layout that devices without the app (and notifications) show.
struct CardArt: View {
    let challenge: ChatChallenge

    var body: some View {
        ZStack {
            Color.white
            Hatch()
            VStack(alignment: .leading, spacing: 3) {
                Text("CHARLES SPRINT").font(Theme.bold(12)).tracking(2)
                if let last = challenge.last {
                    Text(formatTime(last)).font(Theme.bold(38)).monospacedDigit()
                    Text("\(challenge.lastName ?? "Someone") · 500 M").font(Theme.bold(12)).lineLimit(1)
                } else {
                    Text("ROW 500 M").font(Theme.bold(30))
                    Text("TAP TO RACE").font(Theme.bold(12)).tracking(1.5)
                }
                Rectangle().fill(Color.black).frame(height: 3).padding(.vertical, 4)
                HStack(spacing: 6) {
                    Text("CHAT BEST").tracking(1.5)
                    Spacer(minLength: 4)
                    Text(challenge.best.map { "\(formatTime($0)) \(challenge.holder ?? "")" } ?? "–").lineLimit(1)
                }
                .font(Theme.bold(11))
            }
            .foregroundColor(.black)
            .padding(12)
            .background(Color.white)
            .overlay(Rectangle().strokeBorder(Color.black, lineWidth: 4))
            .background(Rectangle().fill(Color.black).offset(x: 6, y: 6))
            .padding(EdgeInsets(top: 12, leading: 14, bottom: 18, trailing: 20))
        }
    }
}

/// Diagonal line hatching, the game's riverbank texture.
struct Hatch: View {
    var body: some View {
        Canvas { context, size in
            var lines = Path()
            var c = -size.height
            while c < size.width + size.height {
                lines.move(to: CGPoint(x: c, y: size.height))
                lines.addLine(to: CGPoint(x: c + size.height, y: 0))
                c += 10
            }
            context.stroke(lines, with: .color(.black), lineWidth: 1.4)
        }
    }
}

enum CardLayout {
    @MainActor
    static func make(_ challenge: ChatChallenge, rank: Int?) -> MSMessageLayout {
        let template = MSMessageTemplateLayout()
        let renderer = ImageRenderer(content: CardArt(challenge: challenge).frame(width: 300, height: 186))
        renderer.scale = 3
        template.image = renderer.uiImage
        template.imageTitle = "CHARLES SPRINT"
        template.imageSubtitle = "500 M"
        if let last = challenge.last {
            template.caption = "\(challenge.lastName ?? "Someone") rowed \(formatTime(last))"
            template.trailingCaption = formatTime(last)
        } else {
            template.caption = "Charles Sprint"
            template.trailingCaption = "500 M"
        }
        template.subcaption = challenge.best.map { "Chat best \(formatTime($0)) · \(challenge.holder ?? "")" } ?? "Tap to row 500 m up the Charles"
        template.trailingSubcaption = rank.map { "#\($0) overall" }
        return MSMessageLiveLayout(alternateLayout: template)
    }
}

/// The app drawer view.
struct CompactView: View {
    let challenge: ChatChallenge
    let start: () -> Void
    let invite: () -> Void

    @State private var board = LeaderboardModel()

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack(alignment: .firstTextBaseline) {
                Text("CHARLES SPRINT").font(Theme.bold(22))
                Spacer()
                Text("500 M").font(Theme.bold(13)).tracking(1.5)
            }
            if let best = challenge.best {
                Text("Chat best \(formatTime(best)) · \(challenge.holder ?? "")").font(Theme.bold(16))
            } else {
                Text("Row 500 m up the Charles. Tap ROW for each stroke, and don't rush the slide.")
                    .font(Theme.text(15))
            }
            HStack(spacing: 12) {
                Button("RACE", action: start).buttonStyle(BrutalButtonStyle(filled: true))
                Button("SEND CARD", action: invite).buttonStyle(BrutalButtonStyle())
            }
            if let record = board.scores.first {
                Text("Course record \(formatTime(record.time)) · \(record.name)").font(Theme.bold(13))
            }
            Spacer(minLength: 0)
        }
        .foregroundColor(.black)
        .padding(16)
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .top)
        .background(Color.white)
        .task { await board.refresh() }
    }
}
