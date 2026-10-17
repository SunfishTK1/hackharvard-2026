import Foundation

/// A chat's race state, carried in the iMessage card's URL so every device in the conversation
/// (and the Spectrum agent) can read it:
///   https://sprint.../?src=imessage&best=48.2&holder=Ana&t=52.3&n=Thomas&runs=3
/// best/holder: the chat's best time. t/n: the latest finish. The same URL opens the web game.
struct ChatChallenge: Equatable {
    var best: Double?
    var holder: String?
    var last: Double?
    var lastName: String?
    var runs = 0

    init() {}

    init(url: URL?) {
        guard let url, let items = URLComponents(url: url, resolvingAgainstBaseURL: false)?.queryItems else { return }
        func value(_ key: String) -> String? {
            items.first { $0.name == key }?.value.flatMap { $0.isEmpty ? nil : String($0.prefix(20)) }
        }
        best = value("best").flatMap { Double($0) }.flatMap { $0 > 0 ? $0 : nil }
        holder = value("holder")
        last = value("t").flatMap { Double($0) }.flatMap { $0 > 0 ? $0 : nil }
        lastName = value("n")
        runs = value("runs").flatMap { Int($0) } ?? 0
    }

    /// Adds a finished run. Returns true when it is a new chat best.
    @discardableResult
    mutating func add(name: String, time: Double) -> Bool {
        let t = (time * 10).rounded() / 10
        last = t
        lastName = name
        runs += 1
        if let best, best <= t { return false }
        best = t
        holder = name
        return true
    }

    func url(base: URL) -> URL {
        guard var components = URLComponents(url: base, resolvingAgainstBaseURL: false) else { return base }
        var items = [URLQueryItem(name: "src", value: "imessage")]
        if let best {
            items.append(URLQueryItem(name: "best", value: String(format: "%.1f", best)))
            items.append(URLQueryItem(name: "holder", value: holder ?? ""))
        }
        if let last {
            items.append(URLQueryItem(name: "t", value: String(format: "%.1f", last)))
            items.append(URLQueryItem(name: "n", value: lastName ?? ""))
        }
        if runs > 0 { items.append(URLQueryItem(name: "runs", value: String(runs))) }
        components.queryItems = items
        return components.url ?? base
    }
}
