import Foundation
import Observation

struct Score: Codable, Identifiable, Equatable {
    let name: String
    let time: Double
    let at: String

    var id: String { name.lowercased() }
}

struct BoardResponse: Decodable {
    let scores: [Score]
    let total: Int
}

struct SubmitResponse: Decodable {
    let entry: Score
    let rank: Int
    let record: Bool
    let improved: Bool
    let scores: [Score]
    let total: Int
}

/// The shared leaderboard on the Charles Sprint server (same one the web game and agent use).
enum API {
    static let baseURL: URL = {
        if let value = Bundle.main.object(forInfoDictionaryKey: "CharlesAPIBaseURL") as? String,
           let url = URL(string: value), url.scheme != nil {
            return url
        }
        return URL(string: "https://sprint.hackharvard2026.velroi.com")!
    }()

    struct Failure: LocalizedError {
        let message: String
        var errorDescription: String? { message }
    }

    private struct ErrorBody: Decodable { let error: String }
    private struct Submission: Encodable { let name: String; let time: Double }

    static func leaderboard() async throws -> BoardResponse {
        var request = URLRequest(url: baseURL.appending(path: "api/leaderboard"))
        request.cachePolicy = .reloadIgnoringLocalCacheData
        return try await send(request)
    }

    static func submit(name: String, time: Double) async throws -> SubmitResponse {
        var request = URLRequest(url: baseURL.appending(path: "api/scores"))
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = try JSONEncoder().encode(Submission(name: name, time: time))
        return try await send(request)
    }

    private static func send<T: Decodable>(_ request: URLRequest) async throws -> T {
        var request = request
        request.timeoutInterval = 10
        let (data, response) = try await URLSession.shared.data(for: request)
        guard let http = response as? HTTPURLResponse else { throw Failure(message: "No response") }
        guard (200..<300).contains(http.statusCode) else {
            let message = (try? JSONDecoder().decode(ErrorBody.self, from: data))?.error ?? "HTTP \(http.statusCode)"
            throw Failure(message: message)
        }
        return try JSONDecoder().decode(T.self, from: data)
    }
}

@MainActor
@Observable
final class LeaderboardModel {
    private(set) var scores: [Score] = []
    private(set) var total = 0
    private(set) var error: String?

    func refresh() async {
        do {
            let board = try await API.leaderboard()
            scores = board.scores
            total = board.total
            error = nil
        } catch {
            self.error = scores.isEmpty ? "Leaderboard offline." : nil
        }
    }

    func submit(name: String, time: Double) async throws -> SubmitResponse {
        let result = try await API.submit(name: name, time: time)
        scores = result.scores
        total = result.total
        error = nil
        return result
    }
}
