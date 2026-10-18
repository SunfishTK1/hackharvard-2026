import SwiftUI

/// The standalone app. Sage lives in Messages (the MessagesExtension target); this screen explains
/// that and lets you check Face ID works before you need it.
@main
struct SageApp: App {
    var body: some Scene {
        WindowGroup {
            HomeView()
                .preferredColorScheme(.light)
        }
    }
}

struct HomeView: View {
    @State private var status: String?
    @State private var working = false

    var body: some View {
        VStack(alignment: .leading, spacing: 18) {
            Text("Sage")
                .font(.system(size: 40, weight: .bold))
            Text("Your study assistant for clinical research. Text Sage in Messages; the cards Sage sends open right in the chat, and Face ID confirms it's you when you sign a form or open your documents.")
                .font(.body)
                .foregroundStyle(.secondary)
            Button {
                Task { await testFaceID() }
            } label: {
                Label(working ? "Checking…" : "Test Face ID", systemImage: "faceid")
                    .font(.headline)
                    .frame(maxWidth: .infinity)
                    .padding(.vertical, 14)
            }
            .buttonStyle(.borderedProminent)
            .tint(Color(red: 0.29, green: 0.20, blue: 0.75))
            .disabled(working)
            if let status {
                Text(status)
                    .font(.callout)
                    .foregroundStyle(.secondary)
            }
            Spacer()
        }
        .padding(24)
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    private func testFaceID() async {
        working = true
        defer { working = false }
        do {
            _ = try await FaceIDSigner.sign(challenge: UUID().uuidString, keyTag: "self-test", reason: "Check that Face ID works with Sage")
            status = "Face ID works. You're ready to sign with Sage."
        } catch {
            status = FaceIDSigner.message(for: error)
        }
    }
}
