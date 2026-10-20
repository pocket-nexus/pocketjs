// WebSignIn.swift — a sign-in window for a companion service
// (tools/companion/services/x.ts): a WKWebView at a site's login page, in a
// private data store, that waits for the named cookies to appear and prints
// them on stdout as one JSON line, then quits.
//
//   pocket-websignin --url https://x.com/i/flow/login --domain x.com \
//     --cookies auth_token,ct0 --title "Sign in to X" [--timeout 600]
//
// Output, one line: {"cookies":{"auth_token":"…","ct0":"…"}} once every named
// cookie is set for the domain, {"closed":true} when the window is closed
// first, {"timeout":true} after --timeout seconds. Nothing is written to
// disk: the data store is non-persistent and the caller keeps the cookies.

import AppKit
import WebKit

func argument(_ name: String) -> String? {
  let args = CommandLine.arguments
  guard let index = args.firstIndex(of: name), index + 1 < args.count else { return nil }
  return args[index + 1]
}

func emit(_ object: [String: Any]) {
  if let data = try? JSONSerialization.data(withJSONObject: object), let line = String(data: data, encoding: .utf8) {
    FileHandle.standardOutput.write((line + "\n").data(using: .utf8)!)
  }
}

struct Options {
  let start: URL
  let domain: String
  let wanted: [String]
  let title: String
  let timeout: TimeInterval
}

final class SignIn: NSObject, NSApplicationDelegate, NSWindowDelegate {
  let options: Options
  let window: NSWindow
  let web: WKWebView
  var finished = false

  init(_ options: Options) {
    self.options = options
    let config = WKWebViewConfiguration()
    config.websiteDataStore = .nonPersistent()
    web = WKWebView(frame: NSRect(x: 0, y: 0, width: 480, height: 720), configuration: config)
    // The site serves its full login flow to a desktop Safari.
    web.customUserAgent = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15"
    window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 480, height: 720), styleMask: [.titled, .closable, .resizable], backing: .buffered, defer: false)
    super.init()
    window.title = options.title
    window.contentView = web
    window.delegate = self
    window.center()
  }

  func applicationDidFinishLaunching(_ notification: Notification) {
    web.load(URLRequest(url: options.start))
    window.makeKeyAndOrderFront(nil)
    NSApp.activate(ignoringOtherApps: true)
    Timer.scheduledTimer(withTimeInterval: 1, repeats: true) { [weak self] _ in self?.check() }
    Timer.scheduledTimer(withTimeInterval: options.timeout, repeats: false) { [weak self] _ in self?.finish(["timeout": true], code: 1) }
  }

  func check() {
    web.configuration.websiteDataStore.httpCookieStore.getAllCookies { [weak self] cookies in
      guard let self, !self.finished else { return }
      var found: [String: String] = [:]
      for cookie in cookies where cookie.domain == self.options.domain || cookie.domain.hasSuffix("." + self.options.domain) {
        if self.options.wanted.contains(cookie.name), !cookie.value.isEmpty { found[cookie.name] = cookie.value }
      }
      if found.count == self.options.wanted.count { self.finish(["cookies": found], code: 0) }
    }
  }

  func windowWillClose(_ notification: Notification) {
    finish(["closed": true], code: 1)
  }

  func finish(_ result: [String: Any], code: Int32) {
    if finished { return }
    finished = true
    emit(result)
    exit(code)
  }
}

guard let start = argument("--url").flatMap(URL.init(string:)),
      let domain = argument("--domain"),
      let wanted = argument("--cookies")?.split(separator: ",").map(String.init), !wanted.isEmpty
else {
  FileHandle.standardError.write("usage: pocket-websignin --url <url> --domain <domain> --cookies <a,b> [--title <t>] [--timeout <s>]\n".data(using: .utf8)!)
  exit(2)
}

let app = NSApplication.shared
app.setActivationPolicy(.regular)
let delegate = SignIn(Options(
  start: start,
  domain: domain,
  wanted: wanted,
  title: argument("--title") ?? "Sign in",
  timeout: TimeInterval(argument("--timeout") ?? "600") ?? 600
))
app.delegate = delegate
app.run()
