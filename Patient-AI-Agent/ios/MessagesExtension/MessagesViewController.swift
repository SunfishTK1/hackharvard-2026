import Messages
import UIKit
import WebKit

/// Sage's iMessage extension. Cards Sage sends (Spectrum `customizedMiniApp`) open here: the card's
/// URL is a mini-app page on the Sage server, shown full height, with a native bridge so the page can
/// ask for Face ID (`window.webkit.messageHandlers.sageNative`). Everything else about the mini-apps
/// is the same web UI people get in Photon's extension.
final class MessagesViewController: MSMessagesAppViewController, WKNavigationDelegate, WKScriptMessageHandlerWithReply {
    private var webView: WKWebView!
    private let placeholder = UILabel()
    private var loadedURL: URL?

    override func viewDidLoad() {
        super.viewDidLoad()
        let background = UIColor(red: 0xF6 / 255, green: 0xF7 / 255, blue: 0xF9 / 255, alpha: 1)
        view.backgroundColor = background

        let configuration = WKWebViewConfiguration()
        configuration.applicationNameForUserAgent = "SageApp/1.0"
        configuration.userContentController.addScriptMessageHandler(WeakHandler(self), contentWorld: .page, name: "sageNative")
        webView = WKWebView(frame: view.bounds, configuration: configuration)
        webView.autoresizingMask = [.flexibleWidth, .flexibleHeight]
        webView.navigationDelegate = self
        webView.isOpaque = false
        webView.backgroundColor = background
        webView.isHidden = true
        view.addSubview(webView)

        placeholder.text = "Open a card from Sage in this chat to continue."
        placeholder.textColor = .secondaryLabel
        placeholder.font = .preferredFont(forTextStyle: .body)
        placeholder.numberOfLines = 0
        placeholder.textAlignment = .center
        placeholder.translatesAutoresizingMaskIntoConstraints = false
        view.addSubview(placeholder)
        NSLayoutConstraint.activate([
            placeholder.centerYAnchor.constraint(equalTo: view.centerYAnchor),
            placeholder.leadingAnchor.constraint(equalTo: view.layoutMarginsGuide.leadingAnchor),
            placeholder.trailingAnchor.constraint(equalTo: view.layoutMarginsGuide.trailingAnchor),
        ])
    }

    override func willBecomeActive(with conversation: MSConversation) {
        super.willBecomeActive(with: conversation)
        // The card the person tapped to open us; nil when opened from the app drawer.
        show(conversation.selectedMessage?.url)
    }

    override func didSelect(_ message: MSMessage, conversation: MSConversation) {
        super.didSelect(message, conversation: conversation)
        show(message.url)
    }

    override func didTransition(to presentationStyle: MSMessagesAppPresentationStyle) {
        super.didTransition(to: presentationStyle)
        if presentationStyle == .compact, loadedURL != nil { requestPresentationStyle(.expanded) }
    }

    private func show(_ url: URL?) {
        guard let url, Self.isSagePage(url) else {
            webView.isHidden = true
            placeholder.isHidden = false
            return
        }
        placeholder.isHidden = true
        webView.isHidden = false
        if url != loadedURL {
            loadedURL = url
            webView.load(URLRequest(url: url))
        }
        if presentationStyle == .compact { requestPresentationStyle(.expanded) }
    }

    /// Only Sage's own pages load here; card URLs from anywhere else are ignored.
    private static func isSagePage(_ url: URL) -> Bool {
        let base = SageConfig.baseURL
        return url.scheme == base.scheme && url.host == base.host && url.port == base.port
    }

    // MARK: Navigation

    func webView(_ webView: WKWebView, decidePolicyFor action: WKNavigationAction, decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        guard let url = action.request.url else { return decisionHandler(.cancel) }
        // Calendar files and other sites open outside Messages (Calendar, Safari).
        if Self.isSagePage(url), url.pathExtension != "ics" || action.navigationType != .linkActivated {
            return decisionHandler(.allow)
        }
        if ["about", "data", "blob"].contains(url.scheme ?? "") { return decisionHandler(.allow) }
        extensionContext?.open(url, completionHandler: nil)
        decisionHandler(.cancel)
    }

    // MARK: Native bridge

    /// `await window.webkit.messageHandlers.sageNative.postMessage({ type, ... })` from the page.
    /// - `faceid` { challenge, keyTag, reason } -> { publicKey, signature }, or rejects with a message.
    /// - `close` -> collapses the sheet back to the chat.
    func userContentController(_ controller: WKUserContentController, didReceive message: WKScriptMessage, replyHandler: @escaping (Any?, String?) -> Void) {
        guard message.frameInfo.isMainFrame, let url = message.frameInfo.request.url, Self.isSagePage(url),
              let body = message.body as? [String: Any], let type = body["type"] as? String else {
            return replyHandler(nil, "Not available here.")
        }
        switch type {
        case "faceid":
            guard let challenge = body["challenge"] as? String, let keyTag = body["keyTag"] as? String else {
                return replyHandler(nil, "Missing challenge.")
            }
            let reason = (body["reason"] as? String).flatMap { $0.isEmpty ? nil : $0 } ?? "Confirm it's you"
            Task {
                do {
                    let proof = try await FaceIDSigner.sign(challenge: challenge, keyTag: keyTag, reason: reason)
                    replyHandler(["publicKey": proof.publicKey, "signature": proof.signature], nil)
                } catch {
                    replyHandler(nil, FaceIDSigner.message(for: error))
                }
            }
        case "close":
            requestPresentationStyle(.compact)
            replyHandler(true, nil)
        default:
            replyHandler(nil, "Unknown request.")
        }
    }
}

/// The content controller keeps its handlers alive; this keeps it from keeping the controller alive.
private final class WeakHandler: NSObject, WKScriptMessageHandlerWithReply {
    private weak var target: WKScriptMessageHandlerWithReply?

    init(_ target: WKScriptMessageHandlerWithReply) {
        self.target = target
    }

    func userContentController(_ controller: WKUserContentController, didReceive message: WKScriptMessage, replyHandler: @escaping (Any?, String?) -> Void) {
        guard let target else { return replyHandler(nil, "Closed.") }
        target.userContentController(controller, didReceive: message, replyHandler: replyHandler)
    }
}
