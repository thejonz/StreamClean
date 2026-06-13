# StreamClean iPhone app

Native shell = **SwiftUI + `WKWebView`**. Your **Python backend** stays required: the phone loads `/` over HTTP/S and uses the existing HTML/JS app.

## Build (recommended: XcodeGen)

1. Install [XcodeGen](https://github.com/yonaskolb/XcodeGen) (`brew install xcodegen`).
2. From **this repo’s `ios/` folder**:
   ```bash
   cd ios
   xcodegen generate
   open StreamClean.xcodeproj
   ```
3. Pick the **Simulator** → Run.
4. In the simulator, tap **⚙️** → set URL to **`http://127.0.0.1:8765/`**  
   Ensure StreamClean is listening (e.g. `python run.py` with `--host 0.0.0.0` or default `127.0.0.1` reachable from Simulator).

### Physical iPhone / iPad

Simulator’s `127.0.0.1` is the **Mac**. A real phone needs your computer’s **LAN IP** (`http://192.168.x.x:8765/`) or **HTTPS** (tunnel or deployed server). ATS allows **local network** reads; arbitrary cleartext to the public internet stays off (`NSAllowsArbitraryLoads` = false).

### Without XcodeGen

Create a new **App** in Xcode → copy `App/*.swift`, `App/Info.plist`, and **`App/PrivacyInfo.xcprivacy`** into the target, set **Info.plist** path in Build Settings.

## Troubleshooting Xcode build

### “Missing app icon set named AppIcon”

Do not reference **`AppIcon`** unless you add **`Assets.xcassets/AppIcon`**. This project sets **`ASSETCATALOG_COMPILER_APPICON_NAME`** to empty via **`project.yml`**. If you re-run XcodeGen or create a fresh target and the error returns, clear **Primary App Icon Set Name** under **Asset Catalog Compiler** in Build Settings.

### “Signing for StreamClean requires a development team”

**Signing & Capabilities → Team** → choose a Personal Team (Simulator) or your Apple Developer Program team (device / App Store).

### Swift availability / WKWebView

`WKWebView.isInspectable` is wrapped in **`#available(iOS 16.4, *)`** because the target uses strict unguarded-availability warnings.

### Still failing

Copy the **first red error line** from the Issue navigator (**⌘6**) so logs can pinpoint signing vs Swift vs plist.

## Updating the UI

Changing `static/` in the backend does **not** require an App Store build; only restart or refresh Safari’s cache—the WebView pulls live pages from your server unless you introduce offline caching later.

## App Store notes

Use **HTTPS** in production, set **`AppServer.defaultBaseURLString`** in `Constants.swift` to your public origin, disclose VidAngel/third-party integrations in Review notes, supply icons/screenshots.
