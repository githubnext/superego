import AppKit
import WebKit

// No activation, ordered windows, notifications or Dock presence in headless mode.
final class Shell: NSObject, NSApplicationDelegate, WKNavigationDelegate, WKScriptMessageHandler {
    let env = ProcessInfo.processInfo.environment
    var window: NSWindow!
    var web: WKWebView!
    var headless: Bool { env["SUPEREGO_HEADLESS"] == "1" }
    func fail(_ message: String) -> Never {
        fputs("Native spike: \(message)\n", stderr)
        exit(1)
    }
    func applicationDidFinishLaunching(_ notification: Notification) {
        guard let home = env["SUPEREGO_HOME"] else { fail("Set SUPEREGO_HOME explicitly") }
        try? FileManager.default.createDirectory(atPath: home, withIntermediateDirectories: true)
        let endpoint = URL(fileURLWithPath: home).appendingPathComponent("native-endpoint.json")
        func runningURL() -> URL? {
            guard let data = try? Data(contentsOf: endpoint),
                  let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
                  let pid = obj["pid"] as? Int32, kill(pid, 0) == 0,
                  let url = obj["url"] as? String else { return nil }
            return URL(string: url)
        }
        if runningURL() == nil {
            let process = Process()
            process.executableURL = URL(fileURLWithPath: "/usr/bin/nohup")
            process.arguments = [Bundle.main.bundleURL.appendingPathComponent("Contents/MacOS/superego-daemon").path]
            process.standardInput = FileHandle.nullDevice
            let log = home + "/native-daemon.log"
            FileManager.default.createFile(atPath: log, contents: nil)
            let output = FileHandle(forWritingAtPath: log)!
            process.standardOutput = output; process.standardError = output
            do { try process.run() } catch { fail("\(error)") }
        }
        var url: URL?
        for _ in 0..<200 {
            url = runningURL()
            if url != nil { break }
            Thread.sleep(forTimeInterval: 0.1)
        }
        guard let url else { fail("Daemon endpoint timed out; see native-daemon.log") }
        let config = WKWebViewConfiguration()
        if headless {
            config.websiteDataStore = .nonPersistent()
            config.userContentController.add(self, name: "smoke")
            config.userContentController.addUserScript(WKUserScript(source: "window.addEventListener('error', e => window.webkit.messageHandlers.smoke.postMessage(String(e.message)));", injectionTime: .atDocumentStart, forMainFrameOnly: true))
        }
        web = WKWebView(frame: NSRect(x: 0, y: 0, width: 1200, height: 800), configuration: config)
        web.navigationDelegate = self
        window = NSWindow(contentRect: web.frame, styleMask: [.titled, .closable, .resizable, .miniaturizable], backing: .buffered, defer: false)
        window.title = "Superego Native Spike"; window.contentView = web
        if !headless { window.makeKeyAndOrderFront(nil); NSApp.activate(ignoringOtherApps: true) }
        web.load(URLRequest(url: url))
        if headless { DispatchQueue.main.asyncAfter(deadline: .now() + 50) { self.fail("Smoke timed out") } }
    }
    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        guard headless else { return }
        fputs("Native WebKit navigation finished\n", stderr)
        // Force an offscreen layout pass; an unordered window otherwise has no paint demand.
        web.takeSnapshot(with: nil) { _, error in
            if let error { fputs("Initial snapshot: \(error)\n", stderr) }
        }
        guard let scriptURL = Bundle.main.url(forResource: "smoke", withExtension: "js"),
              let script = try? String(contentsOf: scriptURL, encoding: .utf8) else { fail("Missing smoke.js") }
        web.callAsyncJavaScript(script, arguments: [:], in: nil, in: .page, completionHandler: { result in
            switch result {
            case .failure(let error): self.fail("\(error)")
            case .success(let value):
                print("WEBKIT SMOKE: \(value)")
                self.web.takeSnapshot(with: nil) { image, error in
                    if let error { self.fail("Snapshot: \(error)") }
                    if let path = self.env["SUPEREGO_NATIVE_SNAPSHOT"] {
                        guard let data = image?.tiffRepresentation, let rep = NSBitmapImageRep(data: data),
                              let png = rep.representation(using: .png, properties: [:]) else { self.fail("No snapshot image") }
                        do { try png.write(to: URL(fileURLWithPath: path)) } catch { self.fail("Snapshot: \(error)") }
                    }
                    exit(0)
                }
            }
        })
    }
    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) { fail("Navigation: \(error)") }
    func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) { fail("Navigation: \(error)") }
    func webViewWebContentProcessDidTerminate(_ webView: WKWebView) { fail("WebKit content process terminated") }
    func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage) { fputs("WebKit: \(message.body)\n", stderr) }
}
let app = NSApplication.shared
let shell = Shell()
app.setActivationPolicy(shell.headless ? .prohibited : .regular)
app.delegate = shell
app.run()
