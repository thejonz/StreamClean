import Foundation

enum AppServer {
    static let defaultsKeyBaseURL = "streamclean.base_url.v1"

    /// Physical devices cannot reach localhost on your Mac — use LAN IP (`ifconfig`), tunnel, or your deployed host (HTTPS preferred).
    static let defaultBaseURLString = "http://192.168.1.100:8765"
}
