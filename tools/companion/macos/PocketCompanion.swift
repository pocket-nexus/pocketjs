// Pocket Companion — menu-bar app for Pocket Link (docs/POCKET-LINK.md).
//
// The app owns no link logic. It starts the bundled daemon
// (Contents/MacOS/pocket-companion, compiled from tools/companion.ts) as a
// child process, or attaches to a daemon already running for the same store,
// and drives it through the local control API named by control.json.
//
// Built by tools/companion-app.ts:
//   swiftc -parse-as-library -swift-version 5 PocketCompanion.swift

import AppKit
import CoreImage
import CoreImage.CIFilterBuiltins
import SwiftUI

// MARK: - Control API model

struct ControlInfo: Decodable {
  let port: Int
  let token: String
  let pid: Int32
}

struct CompanionStatus: Decodable {
  struct Companion: Decodable {
    let id: String
    let name: String
    let port: Int
    let addresses: [String]
    let allowPrivate: Bool
  }
  struct Linked: Decodable, Identifiable {
    let id: String
    let name: String
    let model: String
    let target: String
    let address: String
    let since: Double
  }
  struct Paired: Decodable, Identifiable {
    let id: String
    let name: String
    let model: String
    let lastAddress: String
    let lastSeen: Double
  }
  struct App: Decodable, Identifiable {
    let id: String
    let title: String
    let version: String
    let bytes: Int
  }
  struct Pairing: Decodable {
    let open: Bool
    let uri: String?
    let expiresAt: Double?
  }
  let companion: Companion
  let consoles: [Linked]
  let paired: [Paired]
  let apps: [App]
  let appsDirs: [String]
  let appsDir: String
  let pairing: Pairing
}

// MARK: - Daemon

@MainActor
final class Daemon: ObservableObject {
  static let shared = Daemon()

  @Published var status: CompanionStatus?
  @Published var problem: String?
  /// The console that paired while the pairing window was showing.
  @Published var justPaired: String?

  private var child: Process?
  private var control: ControlInfo?
  private var poll: Timer?
  private var pairedBefore: Set<String> = []
  private var launchedAt = Date.distantPast

  let storeDir: URL = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
    .appendingPathComponent("Pocket Companion", isDirectory: true)
  private lazy var session: URLSession = {
    let config = URLSessionConfiguration.ephemeral
    config.connectionProxyDictionary = [:]
    config.timeoutIntervalForRequest = 3
    return URLSession(configuration: config)
  }()

  var running: Bool { status != nil }
  var ownsDaemon: Bool { child?.isRunning == true }

  func start() {
    try? FileManager.default.createDirectory(at: storeDir, withIntermediateDirectories: true)
    if let info = readControl(), processAlive(info.pid) {
      control = info
    } else {
      launch()
    }
    poll = Timer.scheduledTimer(withTimeInterval: 1, repeats: true) { _ in
      Task { @MainActor in await Daemon.shared.refresh() }
    }
    Task {
      await refresh()
      // `open … --args --show-window --pair` opens the pairing window at launch.
      guard CommandLine.arguments.contains("--pair") else { return }
      for _ in 0..<20 where status == nil {
        try? await Task.sleep(nanoseconds: 250_000_000)
        await refresh()
      }
      if status != nil { await openPairing() }
    }
    if let flag = CommandLine.arguments.firstIndex(of: "--snapshot"), flag + 1 < CommandLine.arguments.count {
      let path = CommandLine.arguments[flag + 1]
      Timer.scheduledTimer(withTimeInterval: 4, repeats: false) { _ in
        Task { @MainActor in Snapshot.write(to: URL(fileURLWithPath: path)) }
      }
    }
  }

  func stop() {
    poll?.invalidate()
    if let child, child.isRunning {
      child.terminate()
      child.waitUntilExit()
    }
  }

  private func launch() {
    guard let binary = Bundle.main.url(forAuxiliaryExecutable: "pocket-companion") else {
      problem = "The bundled pocket-companion daemon is missing."
      return
    }
    var arguments = ["serve", "--parent-pid", String(getpid())]
    if let repoApps = Bundle.main.object(forInfoDictionaryKey: "PocketRepoAppsDir") as? String,
       FileManager.default.fileExists(atPath: repoApps) {
      arguments += ["--apps", repoApps]
    }
    let process = Process()
    process.executableURL = binary
    process.arguments = arguments
    let logs = FileManager.default.urls(for: .libraryDirectory, in: .userDomainMask)[0]
      .appendingPathComponent("Logs/Pocket Companion", isDirectory: true)
    try? FileManager.default.createDirectory(at: logs, withIntermediateDirectories: true)
    let logURL = logs.appendingPathComponent("companion.log")
    if !FileManager.default.fileExists(atPath: logURL.path) {
      FileManager.default.createFile(atPath: logURL.path, contents: nil)
    }
    if let handle = try? FileHandle(forWritingTo: logURL) {
      handle.seekToEndOfFile()
      process.standardOutput = handle
      process.standardError = handle
    }
    process.terminationHandler = { proc in
      Task { @MainActor in
        let daemon = Daemon.shared
        guard daemon.child === proc else { return }
        daemon.control = nil
        daemon.status = nil
        daemon.problem = "The companion daemon exited (status \(proc.terminationStatus)). See ~/Library/Logs/Pocket Companion/companion.log."
      }
    }
    do {
      try process.run()
      child = process
      launchedAt = Date()
      problem = nil
    } catch {
      problem = "Cannot start the companion daemon: \(error.localizedDescription)"
    }
  }

  func restart() {
    stop()
    control = nil
    status = nil
    launch()
    poll = Timer.scheduledTimer(withTimeInterval: 1, repeats: true) { _ in
      Task { @MainActor in await Daemon.shared.refresh() }
    }
  }

  private func readControl() -> ControlInfo? {
    guard let data = try? Data(contentsOf: storeDir.appendingPathComponent("control.json")) else { return nil }
    return try? JSONDecoder().decode(ControlInfo.self, from: data)
  }

  private func processAlive(_ pid: Int32) -> Bool {
    kill(pid, 0) == 0
  }

  func refresh() async {
    if control == nil || !(control.map { processAlive($0.pid) } ?? false) {
      control = nil
      if let info = readControl(), processAlive(info.pid), child == nil || info.pid == child!.processIdentifier {
        control = info
      }
    }
    guard control != nil else {
      status = nil
      return
    }
    do {
      let data = try await request("GET", "/status")
      let next = try JSONDecoder().decode(CompanionStatus.self, from: data)
      if let old = status, old.pairing.open, !next.pairing.open {
        if let fresh = next.paired.first(where: { !pairedBefore.contains("\($0.id):\($0.lastSeen)") }) {
          justPaired = fresh.name.isEmpty ? fresh.id : fresh.name
        }
      }
      if !next.pairing.open { pairedBefore = Set(next.paired.map { "\($0.id):\($0.lastSeen)" }) }
      status = next
      problem = nil
    } catch {
      status = nil
      problem = "The companion daemon does not answer: \(error.localizedDescription)"
    }
  }

  @discardableResult
  func request(_ method: String, _ path: String, json: [String: Any]? = nil) async throws -> Data {
    guard let control else { throw URLError(.cannotConnectToHost) }
    var request = URLRequest(url: URL(string: "http://127.0.0.1:\(control.port)\(path)")!)
    request.httpMethod = method
    request.setValue("Bearer \(control.token)", forHTTPHeaderField: "Authorization")
    if let json {
      request.setValue("application/json", forHTTPHeaderField: "Content-Type")
      request.httpBody = try JSONSerialization.data(withJSONObject: json)
    }
    let (data, response) = try await session.data(for: request)
    if let http = response as? HTTPURLResponse, http.statusCode >= 400 {
      let message = (try? JSONSerialization.jsonObject(with: data) as? [String: Any])?["error"] as? String
      throw NSError(domain: "PocketCompanion", code: http.statusCode, userInfo: [NSLocalizedDescriptionKey: message ?? "HTTP \(http.statusCode)"])
    }
    return data
  }

  func openPairing() async {
    justPaired = nil
    if let status { pairedBefore = Set(status.paired.map { "\($0.id):\($0.lastSeen)" }) }
    do { try await request("POST", "/pair") } catch { problem = error.localizedDescription }
    await refresh()
  }

  func closePairing() async {
    _ = try? await request("DELETE", "/pair")
    await refresh()
  }

  func forget(_ id: String) async {
    do { try await request("DELETE", "/consoles/\(id)") } catch { problem = error.localizedDescription }
    await refresh()
  }

  func setAppsDir(_ url: URL) async {
    do { try await request("POST", "/apps-dir", json: ["path": url.path]) } catch { problem = error.localizedDescription }
    await refresh()
  }
}

// MARK: - QR

enum QRImage {
  /// CIQRCodeGenerator at correction level M, scaled by an integer factor with
  /// nearest-neighbour sampling so every module stays a crisp square.
  static func make(_ text: String, side: CGFloat) -> NSImage? {
    let filter = CIFilter.qrCodeGenerator()
    filter.message = Data(text.utf8)
    filter.correctionLevel = "M"
    guard let output = filter.outputImage else { return nil }
    let scale = max(1, floor(side * 2 / output.extent.width))
    let scaled = output.samplingNearest().transformed(by: CGAffineTransform(scaleX: scale, y: scale))
    guard let cg = CIContext().createCGImage(scaled, from: scaled.extent) else { return nil }
    return NSImage(cgImage: cg, size: NSSize(width: scaled.extent.width / 2, height: scaled.extent.height / 2))
  }
}

// MARK: - Views

struct MenuContent: View {
  @ObservedObject var daemon = Daemon.shared
  @Environment(\.openWindow) private var openWindow

  var body: some View {
    if let status = daemon.status {
      Text("Listening on \(status.companion.addresses.first ?? "this Mac"):\(String(status.companion.port))")
      if status.consoles.isEmpty {
        Text(status.paired.isEmpty ? "No consoles paired" : "No console linked")
      } else {
        ForEach(status.consoles) { console in
          Text("Linked: \(console.name.isEmpty ? console.model : console.name) — \(console.address)")
        }
      }
      if status.pairing.open { Text("Pairing window open") }
    } else {
      Text(daemon.problem ?? "Starting…")
    }
    Divider()
    Button("Pair a Console…") {
      Task { await daemon.openPairing() }
      show()
    }
    .disabled(daemon.status == nil)
    Button("Show Pocket Companion") { show() }
    Button("Choose Apps Folder…") { AppsFolder.choose() }
      .disabled(daemon.status == nil)
    if daemon.status == nil && !daemon.ownsDaemon {
      Button("Restart Daemon") { daemon.restart() }
    }
    Divider()
    Button("Quit Pocket Companion") { NSApp.terminate(nil) }
      .keyboardShortcut("q")
  }

  private func show() {
    openWindow(id: "main")
    NSApp.activate(ignoringOtherApps: true)
  }
}

enum AppsFolder {
  @MainActor
  static func choose() {
    let panel = NSOpenPanel()
    panel.canChooseDirectories = true
    panel.canChooseFiles = false
    panel.allowsMultipleSelection = false
    panel.prompt = "Serve This Folder"
    panel.message = "Choose the folder whose .pocket files the companion offers to consoles."
    if let current = Daemon.shared.status?.appsDir { panel.directoryURL = URL(fileURLWithPath: current) }
    NSApp.activate(ignoringOtherApps: true)
    if panel.runModal() == .OK, let url = panel.url {
      Task { await Daemon.shared.setAppsDir(url) }
    }
  }
}

struct MainWindow: View {
  var body: some View {
    ScrollView { WindowContent() }
      .frame(minWidth: 460, idealWidth: 480, minHeight: 600, idealHeight: 760)
  }
}

struct WindowContent: View {
  @ObservedObject var daemon = Daemon.shared

  var body: some View {
    VStack(alignment: .leading, spacing: 20) {
      header
      if let status = daemon.status {
        PairingSection(status: status)
        Divider()
        ConsolesSection(status: status)
        Divider()
        AppsSection(status: status)
      } else {
        Text(daemon.problem ?? "Starting the companion daemon…")
          .foregroundStyle(.secondary)
      }
    }
    .padding(24)
    .frame(maxWidth: .infinity, alignment: .leading)
  }

  private var header: some View {
    VStack(alignment: .leading, spacing: 4) {
      Text(daemon.status?.companion.name ?? "Pocket Companion").font(.title2.bold())
      if let s = daemon.status {
        Text("Listening on \(s.companion.addresses.isEmpty ? "no LAN address" : s.companion.addresses.joined(separator: ", ")) port \(String(s.companion.port))")
          .font(.callout).foregroundStyle(.secondary)
        Text("Companion \(s.companion.id)").font(.caption.monospaced()).foregroundStyle(.tertiary)
      }
    }
  }
}

struct PairingSection: View {
  let status: CompanionStatus
  @ObservedObject var daemon = Daemon.shared

  var body: some View {
    VStack(alignment: .leading, spacing: 12) {
      Text("Pair a Console").font(.headline)
      if status.pairing.open, let uri = status.pairing.uri, let expires = status.pairing.expiresAt {
        HStack {
          Spacer()
          if let image = QRImage.make(uri, side: 280) {
            Image(nsImage: image)
              .interpolation(.none)
              .resizable()
              .frame(width: 280, height: 280)
              .padding(20)
              .background(Color.white)
              .clipShape(RoundedRectangle(cornerRadius: 8))
          }
          Spacer()
        }
        Text("On the 3DS open Pocket › Settings › Mac › Pair a Mac and point the outer camera at this code")
          .fixedSize(horizontal: false, vertical: true)
        HStack {
          TimelineView(.periodic(from: .now, by: 1)) { context in
            let left = max(0, Int(expires / 1000 - context.date.timeIntervalSince1970))
            Text("Expires in \(left / 60):\(String(format: "%02d", left % 60))")
              .monospacedDigit().foregroundStyle(.secondary)
          }
          Spacer()
          Button("Cancel") { Task { await daemon.closePairing() } }
        }
      } else {
        if let name = daemon.justPaired {
          Label("Paired \(name)", systemImage: "checkmark.circle.fill").foregroundStyle(.green)
        }
        Text("Pairing shows a QR code the console scans once. The code holds a single-use secret that expires after 10 minutes.")
          .foregroundStyle(.secondary)
          .fixedSize(horizontal: false, vertical: true)
        Button("Pair a Console…") { Task { await daemon.openPairing() } }
          .buttonStyle(.borderedProminent)
      }
    }
  }
}

struct ConsolesSection: View {
  let status: CompanionStatus
  @ObservedObject var daemon = Daemon.shared
  @State private var confirming: CompanionStatus.Paired?

  var body: some View {
    VStack(alignment: .leading, spacing: 10) {
      Text("Paired Consoles").font(.headline)
      if status.paired.isEmpty {
        Text("None yet.").foregroundStyle(.secondary)
      }
      ForEach(status.paired) { console in
        let link = status.consoles.first { $0.id == console.id }
        HStack(alignment: .firstTextBaseline) {
          Circle().fill(link == nil ? Color.secondary.opacity(0.4) : Color.green).frame(width: 8, height: 8)
          VStack(alignment: .leading, spacing: 2) {
            Text(console.name.isEmpty ? console.id : console.name)
            Text(detail(console, link)).font(.caption).foregroundStyle(.secondary)
          }
          Spacer()
          Button("Forget") { confirming = console }
        }
      }
    }
    .confirmationDialog(
      "Forget \(confirming?.name ?? "this console")?",
      isPresented: Binding(get: { confirming != nil }, set: { if !$0 { confirming = nil } }),
      presenting: confirming
    ) { console in
      Button("Forget", role: .destructive) { Task { await daemon.forget(console.id) } }
    } message: { _ in
      Text("The companion deletes this console's key and closes its link. The console has to pair again.")
    }
  }

  private func detail(_ console: CompanionStatus.Paired, _ link: CompanionStatus.Linked?) -> String {
    if let link {
      return "\(console.model) · linked from \(link.address) since \(Date(timeIntervalSince1970: link.since / 1000).formatted(date: .omitted, time: .shortened))"
    }
    let seen = console.lastSeen > 0 ? Date(timeIntervalSince1970: console.lastSeen / 1000).formatted(date: .abbreviated, time: .shortened) : "never"
    return "\(console.model) · last seen \(seen)\(console.lastAddress.isEmpty ? "" : " at \(console.lastAddress)")"
  }
}

struct AppsSection: View {
  let status: CompanionStatus

  var body: some View {
    VStack(alignment: .leading, spacing: 10) {
      HStack {
        Text("Apps Offered").font(.headline)
        Spacer()
        Button("Choose Folder…") { AppsFolder.choose() }
      }
      Text(status.appsDirs.map { ($0 as NSString).abbreviatingWithTildeInPath }.joined(separator: "\n"))
        .font(.caption.monospaced()).foregroundStyle(.secondary).textSelection(.enabled)
      if status.apps.isEmpty {
        Text("No .pocket files for 3ds-dev in these folders.").foregroundStyle(.secondary)
      }
      ForEach(status.apps) { app in
        HStack {
          Text(app.title)
          Text(app.version).foregroundStyle(.secondary)
          Spacer()
          Text(ByteCountFormatter.string(fromByteCount: Int64(app.bytes), countStyle: .file)).foregroundStyle(.secondary)
        }
      }
    }
  }
}

// MARK: - Snapshot

/// `--snapshot <png>` renders the window's content to a PNG four seconds after
/// launch: a check that needs no screen-recording permission.
enum Snapshot {
  @MainActor
  static func write(to url: URL) {
    let renderer = ImageRenderer(content: WindowContent().frame(width: 480).background(Color(nsColor: .windowBackgroundColor)))
    renderer.scale = 2
    guard let cg = renderer.cgImage else { return }
    try? NSBitmapImageRep(cgImage: cg).representation(using: .png, properties: [:])?.write(to: url)
  }
}

// MARK: - App

final class AppDelegate: NSObject, NSApplicationDelegate {
  func applicationDidFinishLaunching(_ notification: Notification) {
    MainActor.assumeIsolated { Daemon.shared.start() }
  }

  func applicationWillTerminate(_ notification: Notification) {
    MainActor.assumeIsolated { Daemon.shared.stop() }
  }
}

@main
struct PocketCompanionApp: App {
  @NSApplicationDelegateAdaptor(AppDelegate.self) var delegate

  var body: some Scene {
    MenuBarExtra("Pocket Companion", systemImage: "link.circle") {
      MenuContent()
    }
    Window("Pocket Companion", id: "main") {
      MainWindow()
        .onAppear { NSApp.activate(ignoringOtherApps: true) }
    }
    .defaultSize(width: 480, height: 760)
    .windowResizability(.contentMinSize)
    .defaultLaunchBehavior(CommandLine.arguments.contains("--show-window") ? .presented : .suppressed)
  }
}
