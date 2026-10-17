import CoreGraphics
import Foundation

/// The 500 m course from the web game, with the same numbers so times compare across versions.
enum Course {
    static let length = 500.0
    /// Points per meter on screen.
    static let px: CGFloat = 4
    static let bridges = [Bridge(at: 250, name: "ANDERSON BRIDGE"), Bridge(at: 440, name: "ELIOT BRIDGE")]

    struct Bridge {
        let at: Double
        let name: String
    }
}

/// m:ss.s
func formatTime(_ seconds: Double) -> String {
    let tenths = Int((seconds * 10).rounded())
    return String(format: "%d:%02d.%d", tenths / 600, (tenths / 10) % 60, tenths % 10)
}

/// m:ss, for the split.
func formatSplit(_ seconds: Double) -> String {
    let s = Int(min(599, seconds))
    return String(format: "%d:%02d", s / 60, s % 60)
}

enum Keys {
    static let name = "charles-name"
    static let best = "charles-best"
}
