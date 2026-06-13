import SwiftUI
import WebKit

private enum ServerHints {
    static let deviceHint =
        """
        Simulator: http://127.0.0.1:8765 (with StreamClean bound to 127.0.0.1 or 0.0.0.0). \
        iPhone / iPad: use your laptop's LAN IP, e.g. http://192.168.1.xx:8765, or HTTPS via a tunnel.
        """
}

struct WebShellView: View {
    @AppStorage(AppServer.defaultsKeyBaseURL) private var baseURLString = AppServer.defaultBaseURLString
    @State private var editingURL = ""
    @State private var showSettings = false
    @State private var reloadToken = UUID()

    var body: some View {
        NavigationStack {
            ZStack {
                if let url = normalizedRootURL(from: baseURLString) {
                    StreamCleanWKWebView(url: url)
                        .id(reloadToken)
                        .ignoresSafeArea(edges: .bottom)
                } else {
                    invalidURLFallback
                }
            }
            .toolbar {
                ToolbarItem(placement: .topBarLeading) {
                    Button {
                        reloadToken = UUID()
                    } label: {
                        Label("Reload", systemImage: "arrow.clockwise")
                    }
                    .disabled(normalizedRootURL(from: baseURLString) == nil)
                }
                ToolbarItem(placement: .topBarTrailing) {
                    Button {
                        editingURL = baseURLString.trimmingCharacters(in: .whitespacesAndNewlines)
                        showSettings = true
                    } label: {
                        Label("Server URL", systemImage: "gearshape")
                    }
                }
            }
            .navigationTitle("StreamClean")
            .navigationBarTitleDisplayMode(.inline)
        }
        .sheet(isPresented: $showSettings) {
            Form {
                Section {
                    TextField("Base URL", text: $editingURL)
                        .keyboardType(.URL)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled(true)
                        .submitLabel(.done)
                } footer: {
                    Text(ServerHints.deviceHint)
                }
                Section {
                    Button("Save") {
                        baseURLString = editingURL.trimmingCharacters(in: .whitespacesAndNewlines)
                        showSettings = false
                        reloadToken = UUID()
                    }
                    .disabled(trimmedURL(editingURL) == nil)
                }
            }
            .presentationDetents([.medium, .large])
        }
    }

    private var invalidURLFallback: some View {
        VStack(spacing: 16) {
            Image(systemName: "exclamationmark.triangle.fill")
                .font(.largeTitle)
                .foregroundStyle(.yellow)
            Text("Set a server URL")
                .font(.headline)
            Text("Open Settings (gear) and paste your StreamClean URL.")
                .font(.subheadline)
                .multilineTextAlignment(.center)
                .foregroundStyle(.secondary)
                .padding(.horizontal)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }

    private func trimmedURL(_ s: String) -> Swift.URL? {
        let t = s.trimmingCharacters(in: .whitespacesAndNewlines)
        guard let u = Swift.URL(string: t),
              let scheme = u.scheme?.lowercased(),
              scheme == "http" || scheme == "https"
        else { return nil }
        return u
    }

    private func normalizedRootURL(from raw: String) -> Swift.URL? {
        guard let u = trimmedURL(raw) else { return nil }
        var s = u.absoluteString
        if !s.hasSuffix("/") {
            s += "/"
        }
        return Swift.URL(string: s)
    }
}

private struct StreamCleanWKWebView: UIViewRepresentable {
    let url: Swift.URL

    func makeCoordinator() -> Coordinator {
        Coordinator()
    }

    func makeUIView(context: Context) -> WKWebView {
        let config = WKWebViewConfiguration()
        config.allowsInlineMediaPlayback = true
        config.defaultWebpagePreferences.allowsContentJavaScript = true
        if #available(iOS 15.4, *) {
            config.limitsNavigationsToAppBoundDomains = false
        }
        let web = WKWebView(frame: .zero, configuration: config)
        web.navigationDelegate = context.coordinator
        web.scrollView.contentInsetAdjustmentBehavior = .automatic
        if #available(iOS 16.4, *) {
            web.isInspectable = true
        }
        context.coordinator.loadHome(in: web, url: url)
        return web
    }

    func updateUIView(_ webView: WKWebView, context: Context) {
        guard context.coordinator.lastLoaded?.absoluteString != url.absoluteString else { return }
        context.coordinator.loadHome(in: webView, url: url)
    }

    final class Coordinator: NSObject, WKNavigationDelegate {
        var lastLoaded: Swift.URL?

        func loadHome(in web: WKWebView, url: Swift.URL) {
            lastLoaded = url
            web.load(URLRequest(url: url))
        }
    }
}

#if DEBUG
struct WebShellView_Previews: PreviewProvider {
    static var previews: some View {
        WebShellView()
    }
}
#endif
