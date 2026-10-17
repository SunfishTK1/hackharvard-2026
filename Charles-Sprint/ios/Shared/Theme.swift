import SwiftUI
import UIKit

/// Black and white, heavy borders, hard shadows: the web game's look.
enum Theme {
    /// Fixed-size bold, for the HUD, canvas labels and buttons where layout must not move.
    static func bold(_ size: CGFloat) -> Font { .custom("HelveticaNeue-Bold", fixedSize: size) }
    /// Body text that follows Dynamic Type.
    static func text(_ size: CGFloat) -> Font { .custom("HelveticaNeue-Medium", size: size, relativeTo: .body) }
}

struct BrutalButtonStyle: ButtonStyle {
    var filled = false

    func makeBody(configuration: Configuration) -> some View {
        let dark = filled != configuration.isPressed
        configuration.label
            .font(Theme.bold(18))
            .tracking(3.6)
            .lineLimit(1)
            .minimumScaleFactor(0.7)
            .frame(maxWidth: .infinity)
            .padding(14)
            .foregroundColor(dark ? .white : .black)
            .background(dark ? Color.black : Color.white)
            .overlay(Rectangle().strokeBorder(Color.black, lineWidth: 3))
    }
}

/// A bordered card with a hard drop shadow, centered in a scroll view that covers the race.
struct Panel<Content: View>: View {
    private let content: Content

    init(@ViewBuilder content: () -> Content) {
        self.content = content()
    }

    var body: some View {
        GeometryReader { geo in
            ScrollView {
                VStack(spacing: 0) { content }
                    .multilineTextAlignment(.center)
                    .foregroundColor(.black)
                    .padding(.horizontal, 20)
                    .padding(.vertical, 22)
                    .frame(maxWidth: 360)
                    .background(Color.white)
                    .overlay(Rectangle().strokeBorder(Color.black, lineWidth: 4))
                    .background(Rectangle().fill(Color.black).offset(x: 8, y: 8))
                    .padding(24)
                    .frame(maxWidth: .infinity, minHeight: geo.size.height)
            }
            .scrollBounceBehavior(.basedOnSize)
        }
        .background(Color.white)
    }
}

struct SectionLabel: View {
    let text: String

    var body: some View {
        Text(text).font(Theme.bold(13)).tracking(2.6).padding(.top, 18)
    }
}

/// Fires on touch-down (not tap-up) for every finger, so stroke rhythm feels immediate.
struct TouchDownArea: UIViewRepresentable {
    let onTouch: () -> Void

    func makeUIView(context: Context) -> TouchView {
        let view = TouchView()
        view.isMultipleTouchEnabled = true
        view.backgroundColor = .clear
        view.onTouch = onTouch
        return view
    }

    func updateUIView(_ view: TouchView, context: Context) {
        view.onTouch = onTouch
    }

    final class TouchView: UIView {
        var onTouch: (() -> Void)?

        override func touchesBegan(_ touches: Set<UITouch>, with event: UIEvent?) {
            for _ in touches { onTouch?() }
        }
    }
}
