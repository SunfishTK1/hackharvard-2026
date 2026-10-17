import CoreGraphics
import Foundation
import Observation

/// Race physics, ported from the web game. Per-frame values are not observed (the view reads
/// them inside a TimelineView); only `phase` and `finalTime` drive SwiftUI updates.
@Observable
final class RaceEngine {
    enum Phase { case title, countdown, race, done }

    struct Puddle {
        let side: CGFloat
        /// Where the boat was when the blades came out; the puddle stays in that water.
        let strokeAt: Double
        let born: Double
    }

    struct Callout {
        let text: String
        let until: TimeInterval
    }

    private(set) var phase: Phase = .title
    private(set) var finalTime = 0.0

    @ObservationIgnored private(set) var mode: Phase = .title
    @ObservationIgnored private(set) var clock = 0.0
    @ObservationIgnored private(set) var dist = 0.0
    @ObservationIgnored private(set) var speed = 0.0
    @ObservationIgnored private(set) var strokeAge = 9.0
    @ObservationIgnored private(set) var puddles: [Puddle] = []
    @ObservationIgnored private(set) var callout: Callout?
    @ObservationIgnored private var countdown = 0.0
    @ObservationIgnored private var lastTap = 0.0
    @ObservationIgnored private var rushes = 0
    @ObservationIgnored private var lastFrame: TimeInterval?

    static var now: TimeInterval { ProcessInfo.processInfo.systemUptime }

    func start() {
        mode = .countdown
        phase = .countdown
        countdown = 2.2
        clock = 0; dist = 0; speed = 0; rushes = 0; lastTap = 0; strokeAge = 9
        puddles = []
        finalTime = 0
        lastFrame = nil
        call("ATTENTION…", for: 1.1)
    }

    /// One stroke. Returns false when not racing.
    @discardableResult
    func stroke() -> Bool {
        guard mode == .race else { return false }
        let now = Self.now
        let gap = now - lastTap
        lastTap = now
        var power = 1.0
        if gap < 0.2 {
            power = 0.3
            rushes += 1
            if rushes % 3 == 1 { call("DON'T RUSH!", for: 0.7) }
        }
        speed += 3.5 * power * (1 - speed / 16)
        strokeAge = 0
        for side: CGFloat in [-1, 1] {
            puddles.append(Puddle(side: side, strokeAt: dist, born: clock))
        }
        return true
    }

    /// Steps the simulation to the current time. Called once per frame.
    func advance() {
        let now = Self.now
        let dt = min(0.05, now - (lastFrame ?? now))
        lastFrame = now
        switch mode {
        case .countdown:
            countdown -= dt
            if countdown <= 0 {
                mode = .race
                call("ROW!", for: 0.6)
                DispatchQueue.main.async { self.phase = .race }
            }
        case .race:
            clock += dt
            speed *= exp(-0.55 * dt)
            dist += speed * dt
            strokeAge += dt
            if dist >= Course.length {
                dist = Course.length
                finish()
            }
        case .done:
            speed *= exp(-1.2 * dt)
            dist += speed * dt
            strokeAge += dt
        case .title:
            break
        }
        puddles.removeAll { clock - $0.born >= 1.2 }
    }

    private func finish() {
        mode = .done
        let time = clock
        call("FINISH!", for: 0.9)
        // Let the boat glide over the line before the results panel covers it.
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.6) { [weak self] in
            guard let self, self.mode == .done else { return }
            self.finalTime = time
            self.phase = .done
        }
    }

    private func call(_ text: String, for seconds: TimeInterval) {
        callout = Callout(text: text, until: Self.now + seconds)
    }
}
