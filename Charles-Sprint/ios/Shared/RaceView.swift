import SwiftUI
import UIKit

struct FinishedRace {
    let name: String
    let time: Double
    /// Place on the shared leaderboard, when the post went through.
    let rank: Int?
}

/// The whole game: river, HUD, ROW button, and the title and finish panels.
/// In Messages, `shareLabel`/`onShare` turn "post time" into "send to chat".
struct RaceView: View {
    var challenge: ChatChallenge?
    var shareLabel: String?
    var footnote: String?
    var onShare: ((FinishedRace) -> Void)?

    @State private var engine = RaceEngine()
    @State private var board = LeaderboardModel()
    @State private var name = UserDefaults.standard.string(forKey: Keys.name) ?? ""
    @State private var postedEntry: Score?
    @State private var resultLine = ""
    @State private var posting = false
    @State private var haptics = UIImpactFeedbackGenerator(style: .light)
    @FocusState private var nameFocused: Bool

    var body: some View {
        ZStack {
            TimelineView(.animation(minimumInterval: nil, paused: engine.phase == .title || engine.phase == .done)) { timeline in
                let _ = engine.advance()
                let frame = timeline.date
                ZStack {
                    Canvas { context, size in
                        _ = frame
                        RaceRenderer(engine: engine, size: size).draw(in: &context)
                    }
                    .ignoresSafeArea()

                    TouchDownArea { row() }
                        .ignoresSafeArea()

                    VStack(spacing: 0) {
                        HUD(
                            time: formatTime(engine.clock),
                            meters: "\(Int(min(Course.length, engine.dist)))",
                            split: engine.speed > 0.5 ? formatSplit(500 / engine.speed) : "–"
                        )
                        Spacer()
                        RowButton(hit: engine.strokeAge < 0.09)
                    }
                    .padding(.horizontal, 12)
                    .padding(.top, 10)
                    .padding(.bottom, 20)
                    .allowsHitTesting(false)

                    if let call = engine.callout, call.until > RaceEngine.now {
                        GeometryReader { geo in
                            Text(call.text)
                                .font(Theme.bold(26))
                                .tracking(3.6)
                                .foregroundColor(.white)
                                .padding(.vertical, 8)
                                .padding(.horizontal, 18)
                                .background(Color.black)
                                .rotationEffect(.degrees(-4))
                                .position(x: geo.size.width / 2, y: geo.size.height * 0.36)
                        }
                        .allowsHitTesting(false)
                    }
                }
            }

            if engine.phase == .title { titlePanel }
            if engine.phase == .done { donePanel }
        }
        .background(Color.white)
        .foregroundColor(.black)
        .task { await board.refresh() }
        .onChange(of: engine.phase) { _, phase in
            if phase == .done { finished() }
        }
    }

    // MARK: Panels

    private var titlePanel: some View {
        Panel {
            VStack(spacing: -2) {
                Text("CHARLES")
                Text("SPRINT")
            }
            .font(Theme.bold(44))
            Text("500 m up the Charles, under the Anderson and Eliot bridges. Tap **ROW** to take a stroke. Fast, but don't rush the slide.")
                .font(Theme.text(16))
                .padding(.top, 10)
            if let best = challenge?.best {
                Text("BEAT \((challenge?.holder ?? "THE CHAT").uppercased()): \(formatTime(best))")
                    .font(Theme.bold(16))
                    .frame(maxWidth: .infinity)
                    .padding(8)
                    .overlay(Rectangle().strokeBorder(Color.black, lineWidth: 3))
                    .padding(.top, 12)
            }
            Button("START") { start() }
                .buttonStyle(BrutalButtonStyle())
                .padding(.top, 14)
            SectionLabel(text: "LEADERBOARD")
            BoardList(scores: board.scores, highlight: nil, error: board.error)
            if let footnote {
                Text(footnote).font(Theme.text(13)).padding(.top, 14)
            }
        }
    }

    private var donePanel: some View {
        Panel {
            Text("FINISH").font(Theme.bold(13)).tracking(2.6)
            Text(formatTime(engine.finalTime))
                .font(Theme.bold(46))
                .monospacedDigit()
                .padding(.top, 6)
            if !resultLine.isEmpty {
                Text(resultLine).font(Theme.text(16)).padding(.top, 6)
            }
            if postedEntry == nil {
                TextField("Your name or crew", text: $name)
                    .font(Theme.text(17))
                    .multilineTextAlignment(.center)
                    .textInputAutocapitalization(.words)
                    .autocorrectionDisabled()
                    .submitLabel(.send)
                    .focused($nameFocused)
                    .onSubmit { post() }
                    .onChange(of: name) { _, value in
                        if value.count > 20 { name = String(value.prefix(20)) }
                    }
                    .padding(12)
                    .overlay(Rectangle().strokeBorder(Color.black, lineWidth: 3))
                    .padding(.top, 12)
                Button(posting ? "POSTING…" : (shareLabel ?? "POST TIME")) { post() }
                    .buttonStyle(BrutalButtonStyle(filled: true))
                    .disabled(posting)
                    .padding(.top, 12)
            }
            SectionLabel(text: "LEADERBOARD")
            BoardList(scores: board.scores, highlight: postedEntry, error: board.error)
            Button("ROW AGAIN") { start() }
                .buttonStyle(BrutalButtonStyle())
                .padding(.top, 14)
        }
    }

    // MARK: Actions

    private func start() {
        nameFocused = false
        postedEntry = nil
        resultLine = ""
        haptics.prepare()
        engine.start()
    }

    private func row() {
        if engine.stroke() { haptics.impactOccurred() }
    }

    private func finished() {
        let time = engine.finalTime
        let best = UserDefaults.standard.double(forKey: Keys.best)
        var lines: [String] = []
        if best == 0 || time < best {
            UserDefaults.standard.set(time, forKey: Keys.best)
            lines.append("Personal best!")
        } else {
            lines.append("Your best: \(formatTime(best))")
        }
        if let target = challenge?.best {
            let who = challenge?.holder ?? "the chat"
            lines.append(time < target
                ? "You beat \(who)'s \(formatTime(target))."
                : String(format: "%.1f s behind %@.", time - target, who))
        }
        resultLine = lines.joined(separator: "\n")
        Task { await board.refresh() }
    }

    private func post() {
        let trimmed = name.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { nameFocused = true; return }
        guard !posting else { return }
        UserDefaults.standard.set(trimmed, forKey: Keys.name)
        nameFocused = false
        posting = true
        let time = engine.finalTime
        Task {
            var rank: Int?
            do {
                let result = try await board.submit(name: trimmed, time: time)
                rank = result.rank
                postedEntry = result.entry
                if result.record {
                    resultLine = "Course record!"
                } else if result.improved {
                    resultLine = "#\(result.rank) of \(result.total) on the board"
                } else {
                    resultLine = "Your best \(formatTime(result.entry.time)) stays #\(result.rank)"
                }
            } catch {
                resultLine = "Couldn't post: \(error.localizedDescription)"
            }
            posting = false
            onShare?(FinishedRace(name: trimmed, time: time, rank: rank))
        }
    }
}

// MARK: - Pieces

private struct HUD: View {
    let time: String
    let meters: String
    let split: String

    var body: some View {
        HStack(spacing: 0) {
            cell("TIME", time)
            Rectangle().fill(Color.black).frame(width: 3)
            cell("METERS", meters)
            Rectangle().fill(Color.black).frame(width: 3)
            cell("SPLIT /500", split)
        }
        .fixedSize(horizontal: false, vertical: true)
        .background(Color.white)
        .overlay(Rectangle().strokeBorder(Color.black, lineWidth: 3))
    }

    private func cell(_ label: String, _ value: String) -> some View {
        VStack(spacing: 1) {
            Text(label).font(Theme.bold(10)).tracking(1.4)
            Text(value).font(Theme.bold(21)).monospacedDigit()
        }
        .foregroundColor(.black)
        .frame(maxWidth: .infinity)
        .padding(.vertical, 6)
    }
}

private struct RowButton: View {
    let hit: Bool

    var body: some View {
        Text("ROW")
            .font(Theme.bold(30))
            .tracking(7.5)
            .containerRelativeFrame(.horizontal) { width, _ in min(width * 0.72, 300) }
            .frame(height: 88)
            .foregroundColor(hit ? .white : .black)
            .background(hit ? Color.black : Color.white)
            .overlay(Rectangle().strokeBorder(Color.black, lineWidth: 4))
            .background(Rectangle().fill(Color.black).offset(x: hit ? 2 : 6, y: hit ? 2 : 6))
            .offset(x: hit ? 4 : 0, y: hit ? 4 : 0)
    }
}

struct BoardList: View {
    let scores: [Score]
    let highlight: Score?
    let error: String?

    var body: some View {
        VStack(spacing: 0) {
            if scores.isEmpty {
                Text(error ?? "No times yet. Be the first.").font(Theme.text(16)).padding(.top, 8)
            }
            ForEach(Array(scores.enumerated()), id: \.element.id) { index, score in
                let me = score == highlight
                HStack(spacing: 10) {
                    Text("\(index + 1)").frame(width: 24, alignment: .leading)
                    Text(score.name).lineLimit(1).truncationMode(.tail)
                    Spacer(minLength: 8)
                    Text(formatTime(score.time)).monospacedDigit()
                }
                .font(Theme.bold(16))
                .padding(.vertical, 6)
                .padding(.horizontal, 4)
                .foregroundColor(me ? .white : .black)
                .background(me ? Color.black : Color.white)
                .overlay(alignment: .bottom) { Rectangle().fill(Color.black).frame(height: 2) }
            }
        }
        .padding(.top, 8)
    }
}
