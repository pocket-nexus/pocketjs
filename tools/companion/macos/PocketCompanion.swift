// Pocket Companion — the Mac app for Pocket Link (docs/POCKET-LINK.md).
//
// The app owns no link logic. It starts the bundled daemon
// (Contents/MacOS/pocket-companion, compiled from tools/companion.ts) as a
// child process, or attaches to a daemon already running for the same store,
// and drives it through the local control API named by control.json.
//
// The window walks an owner through the setup (Pocket Shell on the 3DS, the
// pairing code, the applets) and holds a page for each service the applets
// use: X, Discord, YouTube and the L+R assistant. It lives in the menu bar;
// while the window is open the app also shows in the Dock.
//
// Built by tools/companion-app.ts:
//   swiftc -parse-as-library -swift-version 5 PocketCompanion.swift

import AppKit
import CoreImage
import CoreImage.CIFilterBuiltins
import ServiceManagement
import SwiftUI

/// Pages on Pocket Studio the window links to.
enum Studio {
  static let shell = URL(string: "https://studio.pocket.nexus/apps/shell")!
  static let companion = URL(string: "https://studio.pocket.nexus/apps/companion")!
  static let installGuide = URL(string: "https://studio.pocket.nexus/docs/install/#3ds")!
  static let discordPortal = URL(string: "https://discord.com/developers/applications")!
  static let codex = URL(string: "https://developers.openai.com/codex/cli")!
}

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
    let summary: String?
    let services: [String]?
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
  let appsDir: String?
  let pairing: Pairing
}

/// GET /services: each service's setup state and the assistant's.
struct ServiceStates: Decodable {
  struct X: Decodable {
    let signedIn: Bool
    let since: Double?
    let signingIn: Bool
    let lastError: String?
  }
  struct Discord: Decodable {
    let configured: Bool
    let bot: String?
    let servers: [String]?
    let invite: String?
    let gateway: Bool?
    let contentIntent: Bool?
    let error: String?
  }
  struct Install: Decodable {
    let state: String
    let message: String
    let received: Double
    let total: Double
  }
  struct Youtube: Decodable {
    let ready: Bool
    let ytDlp: String?
    let ffmpeg: String?
    let managed: Bool
    let install: Install
  }
  struct Services: Decodable {
    let x: X?
    let discord: Discord?
    let youtube: Youtube?
  }
  struct Agent: Decodable {
    let on: Bool
    let enabled: Bool
    let codex: String?
    let signedIn: Bool
  }
  let services: Services
  let agent: Agent
}

// MARK: - Daemon

@MainActor
final class Daemon: ObservableObject {
  static let shared = Daemon()

  @Published var status: CompanionStatus?
  @Published var services: ServiceStates?
  @Published var problem: String?
  /// The console that paired while the pairing code was showing.
  @Published var justPaired: String?
  /// The answer of the last owner command (a token refused, a window opened).
  @Published var notice: String?

  private var child: Process?
  private var control: ControlInfo?
  private var poll: Timer?
  private var pairedBefore: Set<String> = []
  private var lastServices = Date.distantPast
  /// Whether a window is open, so the service states are worth asking for.
  var watching = false

  let storeDir = Daemon.defaultStore
  let logURL: URL = FileManager.default.urls(for: .libraryDirectory, in: .userDomainMask)[0]
    .appendingPathComponent("Logs/Pocket Companion/companion.log")
  private lazy var session: URLSession = {
    let config = URLSessionConfiguration.ephemeral
    config.connectionProxyDictionary = [:]
    config.timeoutIntervalForRequest = 20
    return URLSession(configuration: config)
  }()

  var running: Bool { status != nil }
  var ownsDaemon: Bool { child?.isRunning == true }

  /// `$POCKET_COMPANION_HOME` (the daemon reads it too), else ~/Library/Application Support/Pocket Companion.
  nonisolated static let defaultStore: URL = ProcessInfo.processInfo.environment["POCKET_COMPANION_HOME"].map { URL(fileURLWithPath: $0, isDirectory: true) }
    ?? FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0].appendingPathComponent("Pocket Companion", isDirectory: true)

  /// Consoles paired before this launch, read from the store without the
  /// daemon: the window opens at launch for an owner who has none.
  nonisolated static func pairedOnDisk() -> Int {
    let file = defaultStore.appendingPathComponent("companion.json")
    guard let data = try? Data(contentsOf: file),
          let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
          let consoles = json["consoles"] as? [Any] else { return 0 }
    return consoles.count
  }

  func start() {
    try? FileManager.default.createDirectory(at: storeDir, withIntermediateDirectories: true)
    if let info = readControl(), processAlive(info.pid) {
      control = info
    } else {
      launch()
    }
    schedule()
    Task {
      await refresh()
      // `open … --args --pair` shows the pairing code at launch.
      guard CommandLine.arguments.contains("--pair") else { return }
      for _ in 0..<20 where status == nil {
        try? await Task.sleep(nanoseconds: 250_000_000)
        await refresh()
      }
      if status != nil { await openPairing() }
    }
    if let flag = CommandLine.arguments.firstIndex(of: "--snapshot"), flag + 1 < CommandLine.arguments.count {
      let path = CommandLine.arguments[flag + 1]
      watching = true
      let page = CommandLine.arguments.firstIndex(of: "--page").flatMap { $0 + 1 < CommandLine.arguments.count ? Page(rawValue: CommandLine.arguments[$0 + 1]) : nil } ?? .start
      Timer.scheduledTimer(withTimeInterval: 5, repeats: false) { _ in
        Task { @MainActor in Snapshot.write(page: page, to: URL(fileURLWithPath: path)) }
      }
    }
  }

  private func schedule() {
    poll?.invalidate()
    poll = Timer.scheduledTimer(withTimeInterval: 1, repeats: true) { _ in
      Task { @MainActor in await Daemon.shared.refresh() }
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
      problem = "Pocket Companion is incomplete: its background program is missing. Download it again from Pocket Studio."
      return
    }
    var arguments = ["serve", "--parent-pid", String(getpid())]
    // The applets that come with the app, then a developer's checkout when the build names one.
    if let bundled = Bundle.main.resourceURL?.appendingPathComponent("apps"), FileManager.default.fileExists(atPath: bundled.path) {
      arguments += ["--apps", bundled.path]
    }
    if let repoApps = Bundle.main.object(forInfoDictionaryKey: "PocketRepoAppsDir") as? String,
       FileManager.default.fileExists(atPath: repoApps) {
      arguments += ["--apps", repoApps]
    }
    let process = Process()
    process.executableURL = binary
    process.arguments = arguments
    try? FileManager.default.createDirectory(at: logURL.deletingLastPathComponent(), withIntermediateDirectories: true)
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
        daemon.problem = "Pocket Companion stopped working (status \(proc.terminationStatus)). Restart it from Settings, or quit and open it again."
      }
    }
    do {
      try process.run()
      child = process
      problem = nil
    } catch {
      problem = "Pocket Companion could not start: \(error.localizedDescription)"
    }
  }

  func restart() {
    stop()
    child = nil
    control = nil
    status = nil
    services = nil
    problem = nil
    launch()
    schedule()
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
      problem = "Pocket Companion does not answer: \(error.localizedDescription)"
    }
    if watching, services == nil || Date().timeIntervalSince(lastServices) >= 2 {
      await refreshServices()
    }
  }

  func refreshServices() async {
    lastServices = Date()
    guard let data = try? await request("GET", "/services") else { return }
    if let next = try? JSONDecoder().decode(ServiceStates.self, from: data) { services = next }
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

  /// Run a service's owner command; its answer or its failure becomes the notice.
  @discardableResult
  func service(_ name: String, _ args: [String]) async -> Bool {
    notice = nil
    defer { Task { await refreshServices() } }
    do {
      let data = try await request("POST", "/service", json: ["name": name, "args": args])
      notice = (try? JSONSerialization.jsonObject(with: data) as? [String: Any])?["output"] as? String
      return true
    } catch {
      notice = error.localizedDescription
      return false
    }
  }
}

// MARK: - Login item

@MainActor
final class LoginItem: ObservableObject {
  static let shared = LoginItem()
  @Published private(set) var enabled = SMAppService.mainApp.status == .enabled
  @Published var problem: String?

  func set(_ on: Bool) {
    problem = nil
    do {
      if on { try SMAppService.mainApp.register() } else { try SMAppService.mainApp.unregister() }
    } catch {
      problem = error.localizedDescription
    }
    enabled = SMAppService.mainApp.status == .enabled
  }
}

// MARK: - Codex sign-in

/// `codex login` started from the app: it opens the browser and returns when
/// the sign-in is done or abandoned.
@MainActor
final class CodexLogin: ObservableObject {
  static let shared = CodexLogin()
  @Published private(set) var running = false

  func start(codex: String) {
    guard !running else { return }
    let process = Process()
    process.executableURL = URL(fileURLWithPath: codex)
    process.arguments = ["login"]
    process.standardOutput = FileHandle.nullDevice
    process.standardError = FileHandle.nullDevice
    process.terminationHandler = { _ in
      Task { @MainActor in
        CodexLogin.shared.running = false
        await Daemon.shared.refreshServices()
      }
    }
    do {
      try process.run()
      running = true
    } catch {
      Daemon.shared.notice = "Codex could not start: \(error.localizedDescription)"
    }
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

// MARK: - Menu

struct MenuContent: View {
  @ObservedObject var daemon = Daemon.shared
  @Environment(\.openWindow) private var openWindow

  var body: some View {
    if let status = daemon.status {
      if status.consoles.isEmpty {
        Text(status.paired.isEmpty ? "No console paired" : "No console connected")
      } else {
        ForEach(status.consoles) { console in
          Text("Connected: \(console.name.isEmpty ? console.model : console.name)")
        }
      }
      if status.pairing.open { Text("Showing the pairing code") }
    } else {
      Text(daemon.problem ?? "Starting…")
    }
    Divider()
    Button("Open Pocket Companion") { show(.start) }
    Button("Pair a Console…") {
      Task { await daemon.openPairing() }
      show(.consoles)
    }
    .disabled(daemon.status == nil)
    Divider()
    Button("Quit Pocket Companion") { NSApp.terminate(nil) }
      .keyboardShortcut("q")
  }

  private func show(_ page: Page) {
    Navigation.shared.page = page
    openWindow(id: "main")
    NSApp.activate(ignoringOtherApps: true)
  }
}

// MARK: - Window

enum Page: String, CaseIterable, Identifiable {
  case start, consoles, applets, x, discord, youtube, assistant, settings
  var id: String { rawValue }

  var title: String {
    switch self {
    case .start: "Get Started"
    case .consoles: "Consoles"
    case .applets: "Applets"
    case .x: "X"
    case .discord: "Discord"
    case .youtube: "YouTube"
    case .assistant: "Assistant"
    case .settings: "Settings"
    }
  }

  var symbol: String {
    switch self {
    case .start: "sparkles"
    case .consoles: "gamecontroller"
    case .applets: "square.grid.2x2"
    case .x: "text.bubble"
    case .discord: "bubble.left.and.bubble.right"
    case .youtube: "play.rectangle"
    case .assistant: "wand.and.stars"
    case .settings: "gearshape"
    }
  }
}

@MainActor
final class Navigation: ObservableObject {
  static let shared = Navigation()
  @Published var page: Page? = .start
}

struct MainWindow: View {
  @ObservedObject var daemon = Daemon.shared
  @ObservedObject var navigation = Navigation.shared

  var body: some View {
    NavigationSplitView {
      List(selection: $navigation.page) {
        Section {
          row(.start)
          row(.consoles)
          row(.applets)
        }
        Section("Services") {
          row(.x)
          row(.discord)
          row(.youtube)
          row(.assistant)
        }
        Section {
          row(.settings)
        }
      }
      .navigationSplitViewColumnWidth(min: 180, ideal: 190, max: 220)
    } detail: {
      ScrollView {
        PageView(page: navigation.page ?? .start)
          .padding(28)
          .frame(maxWidth: 620, alignment: .leading)
          .frame(maxWidth: .infinity, alignment: .leading)
      }
    }
    .frame(minWidth: 760, idealWidth: 820, minHeight: 540, idealHeight: 620)
    .onAppear {
      daemon.watching = true
      NSApp.setActivationPolicy(.regular)
      NSApp.activate(ignoringOtherApps: true)
      Task { await daemon.refreshServices() }
    }
    .onDisappear {
      daemon.watching = false
      NSApp.setActivationPolicy(.accessory)
    }
  }

  private func row(_ page: Page) -> some View {
    Label(page.title, systemImage: page.symbol).tag(page)
  }
}

struct PageView: View {
  let page: Page
  @ObservedObject var daemon = Daemon.shared

  var body: some View {
    VStack(alignment: .leading, spacing: 18) {
      if daemon.status == nil {
        Text(daemon.problem ?? "Starting Pocket Companion…").foregroundStyle(.secondary)
      } else {
        switch page {
        case .start: StartPage()
        case .consoles: ConsolesPage()
        case .applets: AppletsPage()
        case .x: XPage()
        case .discord: DiscordPage()
        case .youtube: YoutubePage()
        case .assistant: AssistantPage()
        case .settings: SettingsPage()
        }
      }
      if let notice = daemon.notice, page != .start, page != .consoles, page != .applets {
        Text(notice)
          .font(.callout)
          .foregroundStyle(.secondary)
          .textSelection(.enabled)
          .fixedSize(horizontal: false, vertical: true)
      }
    }
    .onChange(of: page) { daemon.notice = nil }
  }
}

// MARK: - Pieces

struct PageTitle: View {
  let title: String
  let line: String

  var body: some View {
    VStack(alignment: .leading, spacing: 6) {
      Text(title).font(.largeTitle.bold())
      Text(line).font(.title3).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
    }
  }
}

struct Para: View {
  let text: String
  init(_ text: String) { self.text = text }
  var body: some View {
    Text(text).fixedSize(horizontal: false, vertical: true)
  }
}

struct StateLine: View {
  let on: Bool
  let text: String

  var body: some View {
    Label {
      Text(text).fixedSize(horizontal: false, vertical: true)
    } icon: {
      Image(systemName: on ? "checkmark.circle.fill" : "circle.dashed")
        .foregroundStyle(on ? Color.green : Color.secondary)
    }
    .font(.headline)
  }
}

/// A numbered step: its number in a disc (a check once done), a title, and what to do.
struct Step<Content: View>: View {
  let number: Int
  let title: String
  let done: Bool
  @ViewBuilder let content: Content

  var body: some View {
    HStack(alignment: .top, spacing: 14) {
      ZStack {
        Circle().fill(done ? Color.green : Color.accentColor).frame(width: 28, height: 28)
        if done {
          Image(systemName: "checkmark").font(.system(size: 13, weight: .bold)).foregroundStyle(.white)
        } else {
          Text("\(number)").font(.system(size: 14, weight: .bold)).foregroundStyle(.white)
        }
      }
      VStack(alignment: .leading, spacing: 8) {
        Text(title).font(.title3.bold())
        content
      }
      Spacer(minLength: 0)
    }
    .padding(16)
    .background(RoundedRectangle(cornerRadius: 12).fill(Color(nsColor: .controlBackgroundColor)))
  }
}

struct PairingCode: View {
  let status: CompanionStatus
  @ObservedObject var daemon = Daemon.shared

  var body: some View {
    VStack(alignment: .leading, spacing: 10) {
      if status.pairing.open, let uri = status.pairing.uri, let expires = status.pairing.expiresAt {
        HStack {
          if let image = QRImage.make(uri, side: 220) {
            Image(nsImage: image)
              .interpolation(.none)
              .resizable()
              .frame(width: 220, height: 220)
              .padding(16)
              .background(Color.white)
              .clipShape(RoundedRectangle(cornerRadius: 10))
          }
          Spacer()
        }
        Para("On the 3DS, open Settings › Mac › Pair a Mac… and point the outer camera at this code.")
        HStack {
          TimelineView(.periodic(from: .now, by: 1)) { context in
            let left = max(0, Int(expires / 1000 - context.date.timeIntervalSince1970))
            Text("The code works once and expires in \(left / 60):\(String(format: "%02d", left % 60)).")
              .monospacedDigit().foregroundStyle(.secondary)
          }
          Spacer()
          Button("Cancel") { Task { await daemon.closePairing() } }
        }
      } else {
        if let name = daemon.justPaired {
          Label("Paired with \(name)", systemImage: "checkmark.circle.fill").foregroundStyle(.green)
        }
        Button(status.paired.isEmpty ? "Show Pairing Code" : "Pair Another Console…") { Task { await daemon.openPairing() } }
          .buttonStyle(.borderedProminent)
          .controlSize(.large)
      }
    }
  }
}

// MARK: - Get Started

struct StartPage: View {
  @ObservedObject var daemon = Daemon.shared
  @Environment(\.openURL) private var openURL

  var body: some View {
    if let status = daemon.status {
      VStack(alignment: .leading, spacing: 16) {
        PageTitle(title: "Get Started", line: "Pocket Companion brings applets to Pocket Shell on your Nintendo 3DS and does the work they need on this Mac.")
        Step(number: 1, title: "Put Pocket Shell on your 3DS", done: !status.paired.isEmpty) {
          Para("Download pocket-shell.3dsx from Pocket Studio, copy it to the 3ds folder of the 3DS's SD card, and open Pocket Shell from the Homebrew Launcher.")
          HStack {
            Button("Get Pocket Shell") { openURL(Studio.shell) }
            Button("Install Guide") { openURL(Studio.installGuide) }
          }
        }
        Step(number: 2, title: "Pair your 3DS with this Mac", done: !status.paired.isEmpty) {
          Para("Connect the 3DS to the same Wi-Fi network as this Mac. Pairing happens once; after it the 3DS finds this Mac by itself.")
          if status.paired.isEmpty || status.pairing.open {
            PairingCode(status: status)
          } else {
            Text("Paired: \(status.paired.map { $0.name.isEmpty ? $0.id : $0.name }.joined(separator: ", "))")
              .foregroundStyle(.secondary)
          }
        }
        Step(number: 3, title: "Install applets", done: false) {
          Para("On the 3DS, tap the Mac icon on the Home screen. It lists the \(status.apps.count) applets that come with Pocket Companion; tap GET next to the ones you want.")
          Button("See the Applets") { Navigation.shared.page = .applets }
        }
        Step(number: 4, title: "Set up the services you use", done: false) {
          Para("X, Discord and YouTube work through this Mac. Each has a page here with its setup; the 3DS never holds your passwords or tokens.")
          HStack {
            Button("X") { Navigation.shared.page = .x }
            Button("Discord") { Navigation.shared.page = .discord }
            Button("YouTube") { Navigation.shared.page = .youtube }
            Button("Assistant") { Navigation.shared.page = .assistant }
          }
        }
      }
    }
  }
}

// MARK: - Consoles

struct ConsolesPage: View {
  @ObservedObject var daemon = Daemon.shared
  @State private var confirming: CompanionStatus.Paired?

  var body: some View {
    if let status = daemon.status {
      VStack(alignment: .leading, spacing: 16) {
        PageTitle(title: "Consoles", line: "The consoles paired with this Mac. A paired console connects whenever it is on the same network.")
        if status.paired.isEmpty {
          Text("No console is paired yet.").foregroundStyle(.secondary)
        }
        ForEach(status.paired) { console in
          let link = status.consoles.first { $0.id == console.id }
          HStack(alignment: .center, spacing: 12) {
            Image(systemName: "gamecontroller.fill")
              .font(.title2)
              .foregroundStyle(link == nil ? Color.secondary : Color.green)
            VStack(alignment: .leading, spacing: 2) {
              Text(console.name.isEmpty ? console.id : console.name).font(.headline)
              Text(detail(console, link)).font(.callout).foregroundStyle(.secondary)
            }
            Spacer()
            Button("Forget…") { confirming = console }
          }
          .padding(12)
          .background(RoundedRectangle(cornerRadius: 10).fill(Color(nsColor: .controlBackgroundColor)))
        }
        PairingCode(status: status)
      }
      .confirmationDialog(
        "Forget \(confirming?.name ?? "this console")?",
        isPresented: Binding(get: { confirming != nil }, set: { if !$0 { confirming = nil } }),
        presenting: confirming
      ) { console in
        Button("Forget", role: .destructive) { Task { await daemon.forget(console.id) } }
      } message: { _ in
        Text("This Mac deletes the console's key and disconnects it. To use it again, pair it again.")
      }
    }
  }

  private func detail(_ console: CompanionStatus.Paired, _ link: CompanionStatus.Linked?) -> String {
    if let link {
      return "\(console.model) · connected since \(Date(timeIntervalSince1970: link.since / 1000).formatted(date: .omitted, time: .shortened))"
    }
    let seen = console.lastSeen > 0 ? Date(timeIntervalSince1970: console.lastSeen / 1000).formatted(date: .abbreviated, time: .shortened) : "never"
    return "\(console.model) · not connected · last seen \(seen)"
  }
}

// MARK: - Applets

struct AppletsPage: View {
  @ObservedObject var daemon = Daemon.shared

  /// A service an applet declares, as the owner knows it, and the page that sets it up.
  private static let serviceNames: [String: (String, Page)] = ["x": ("X", .x), "discord": ("Discord", .discord), "youtube": ("YouTube", .youtube)]

  var body: some View {
    if let status = daemon.status {
      VStack(alignment: .leading, spacing: 16) {
        PageTitle(title: "Applets", line: "Install these on the 3DS from the Mac icon on its Home screen.")
        if status.apps.isEmpty {
          Text("No applets are offered.").foregroundStyle(.secondary)
        }
        ForEach(status.apps) { app in
          let needs = (app.services ?? []).compactMap { Self.serviceNames[$0] }
          HStack(alignment: .top, spacing: 12) {
            VStack(alignment: .leading, spacing: 4) {
              HStack(alignment: .firstTextBaseline) {
                Text(app.title).font(.headline)
                Text(app.version).foregroundStyle(.secondary)
              }
              if let summary = app.summary, !summary.isEmpty {
                Text(summary).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
              }
              if !needs.isEmpty {
                HStack(spacing: 6) {
                  Text("Set up on this Mac:").font(.callout).foregroundStyle(.secondary)
                  ForEach(needs, id: \.0) { need in
                    Button(need.0) { Navigation.shared.page = need.1 }.buttonStyle(.bordered).controlSize(.small)
                  }
                }
              }
            }
            Spacer()
            Text(ByteCountFormatter.string(fromByteCount: Int64(app.bytes), countStyle: .file)).foregroundStyle(.secondary)
          }
          .padding(12)
          .background(RoundedRectangle(cornerRadius: 10).fill(Color(nsColor: .controlBackgroundColor)))
        }
        DisclosureGroup("For developers") {
          VStack(alignment: .leading, spacing: 8) {
            Para("Pocket Companion also offers the .pocket files in a folder of your choice.")
            Text(status.appsDirs.map { ($0 as NSString).abbreviatingWithTildeInPath }.joined(separator: "\n"))
              .font(.caption.monospaced()).foregroundStyle(.secondary).textSelection(.enabled)
            Button("Choose a Folder…") { AppsFolder.choose() }
          }
          .padding(.top, 6)
        }
      }
    }
  }
}

enum AppsFolder {
  @MainActor
  static func choose() {
    let panel = NSOpenPanel()
    panel.canChooseDirectories = true
    panel.canChooseFiles = false
    panel.allowsMultipleSelection = false
    panel.prompt = "Offer This Folder"
    panel.message = "Choose a folder of .pocket files to offer to your consoles."
    if let current = Daemon.shared.status?.appsDir { panel.directoryURL = URL(fileURLWithPath: current) }
    NSApp.activate(ignoringOtherApps: true)
    if panel.runModal() == .OK, let url = panel.url {
      Task { await Daemon.shared.setAppsDir(url) }
    }
  }
}

// MARK: - X

struct XPage: View {
  @ObservedObject var daemon = Daemon.shared

  var body: some View {
    let x = daemon.services?.services.x
    VStack(alignment: .leading, spacing: 16) {
      PageTitle(title: "X", line: "The X applet reads your timeline and posts through this Mac.")
      if let x {
        if x.signedIn {
          StateLine(on: true, text: "Signed in\(x.since.map { " since \(Date(timeIntervalSince1970: $0 / 1000).formatted(date: .abbreviated, time: .omitted))" } ?? "")")
          if let error = x.lastError {
            Text("The last request failed: \(error)").foregroundStyle(.orange).fixedSize(horizontal: false, vertical: true)
          }
          Button("Sign Out of X") { Task { await daemon.service("x", ["logout"]) } }
        } else {
          StateLine(on: false, text: x.signingIn ? "Waiting for you to sign in" : "Not signed in")
          Para("Sign in once in the window that opens. The window closes by itself when you are in. Your session stays in Pocket Companion's folder on this Mac; the 3DS never receives it.")
          Button("Sign In to X…") { Task { await daemon.service("x", ["login"]) } }
            .buttonStyle(.borderedProminent)
            .controlSize(.large)
            .disabled(x.signingIn)
        }
        Para("Pocket reads X through x.com's own web interface. When X changes it, the applet can stop loading until Pocket Companion is updated.")
          .foregroundStyle(.secondary)
      } else {
        ProgressView()
      }
    }
  }
}

// MARK: - Discord

struct DiscordPage: View {
  @ObservedObject var daemon = Daemon.shared
  @Environment(\.openURL) private var openURL
  @State private var token = ""
  @State private var saving = false

  var body: some View {
    let discord = daemon.services?.services.discord
    VStack(alignment: .leading, spacing: 16) {
      PageTitle(title: "Discord", line: "The Discord applet reads and sends messages as a bot you create. Discord lets apps in through bots, not through your own account.")
      if let discord, discord.configured {
        if let error = discord.error {
          StateLine(on: false, text: "Discord did not answer: \(error)")
        } else {
          StateLine(on: true, text: "Bot \(discord.bot ?? "") is set up")
          let servers = discord.servers ?? []
          Text(servers.isEmpty ? "The bot is in no server yet. Invite it to the servers you want to read on the 3DS." : "In \(servers.count == 1 ? "1 server" : "\(servers.count) servers"): \(servers.joined(separator: ", "))")
            .foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
          if discord.contentIntent == false {
            Text("Messages arrive empty: turn on Message Content Intent under Bot in the Discord Developer Portal.")
              .foregroundStyle(.orange).fixedSize(horizontal: false, vertical: true)
          }
        }
        HStack {
          if let invite = discord.invite, let url = URL(string: invite) {
            Button("Invite the Bot to a Server…") { openURL(url) }.buttonStyle(.borderedProminent)
          }
          Button("Remove the Bot Token") { Task { await daemon.service("discord", ["logout"]) } }
        }
      } else if discord != nil {
        Step(number: 1, title: "Create a bot", done: false) {
          Para("In the Discord Developer Portal choose New Application, give it a name, open Bot, and choose Reset Token. Copy the token it shows.")
          Button("Open the Developer Portal") { openURL(Studio.discordPortal) }
        }
        Step(number: 2, title: "Let it read messages", done: false) {
          Para("On the same Bot page, turn on Message Content Intent and save.")
        }
        Step(number: 3, title: "Paste the token here", done: false) {
          HStack {
            SecureField("Bot token", text: $token)
              .textFieldStyle(.roundedBorder)
              .frame(maxWidth: 360)
            Button(saving ? "Checking…" : "Save") {
              saving = true
              Task {
                if await daemon.service("discord", ["token", token]) { token = "" }
                saving = false
              }
            }
            .buttonStyle(.borderedProminent)
            .disabled(token.trimmingCharacters(in: .whitespaces).isEmpty || saving)
          }
          Para("The token stays on this Mac. Then invite the bot to your servers from this page.")
            .foregroundStyle(.secondary)
        }
      } else {
        ProgressView()
      }
    }
  }
}

// MARK: - YouTube

struct YoutubePage: View {
  @ObservedObject var daemon = Daemon.shared

  var body: some View {
    let youtube = daemon.services?.services.youtube
    VStack(alignment: .leading, spacing: 16) {
      PageTitle(title: "YouTube", line: "The YouTube applet plays videos this Mac converts for the 3DS while you watch.")
      if let youtube {
        let installing = youtube.install.state == "installing"
        if youtube.ready && !installing {
          StateLine(on: true, text: "Ready")
          Para("yt-dlp: \(youtube.ytDlp ?? "")\nffmpeg: \(youtube.ffmpeg ?? "")")
            .font(.callout.monospaced()).foregroundStyle(.secondary)
          if youtube.managed {
            Para("YouTube changes often, and yt-dlp follows. When videos stop loading, update it.")
            Button("Update yt-dlp") { Task { await daemon.service("youtube", ["install"]) } }
          }
        } else if installing {
          StateLine(on: false, text: youtube.install.message)
          if youtube.install.total > 0 {
            ProgressView(value: youtube.install.received, total: youtube.install.total)
              .frame(maxWidth: 360)
            Text("\(ByteCountFormatter.string(fromByteCount: Int64(youtube.install.received), countStyle: .file)) of \(ByteCountFormatter.string(fromByteCount: Int64(youtube.install.total), countStyle: .file))")
              .font(.callout).monospacedDigit().foregroundStyle(.secondary)
          } else {
            ProgressView().controlSize(.small)
          }
        } else {
          StateLine(on: false, text: "Needs two programs")
          Para("Pocket Companion converts videos with yt-dlp and ffmpeg. It can download both into its own folder: about 65 MB, checked against their published checksums.")
          if youtube.install.state == "failed" {
            Text("The download failed: \(youtube.install.message)").foregroundStyle(.orange).fixedSize(horizontal: false, vertical: true)
          }
          Button("Download yt-dlp and ffmpeg") { Task { await daemon.service("youtube", ["install"]) } }
            .buttonStyle(.borderedProminent)
            .controlSize(.large)
        }
      } else {
        ProgressView()
      }
    }
  }
}

// MARK: - Assistant

struct AssistantPage: View {
  @ObservedObject var daemon = Daemon.shared
  @ObservedObject var login = CodexLogin.shared
  @Environment(\.openURL) private var openURL

  var body: some View {
    let agent = daemon.services?.agent
    VStack(alignment: .leading, spacing: 16) {
      PageTitle(title: "Assistant", line: "Press L and R together on the 3DS to ask Claude about what is on the screen, by voice or by keyboard.")
      Para("The assistant's answers come from Codex on this Mac, signed in with your ChatGPT account. The 3DS sends your question and a picture of its screen to this Mac; Codex uses your plan's usage.")
      if let agent {
        if agent.on {
          StateLine(on: true, text: "On")
        } else if agent.codex == nil {
          StateLine(on: false, text: "Codex is not installed")
          Para("Install the Codex command line or the Codex app, then come back to this page.")
          Button("How to Install Codex") { openURL(Studio.codex) }
        } else if !agent.signedIn {
          StateLine(on: false, text: "Codex is not signed in")
          Button(login.running ? "Finish Signing In in Your Browser…" : "Sign In to Codex…") { login.start(codex: agent.codex!) }
            .buttonStyle(.borderedProminent)
            .disabled(login.running)
        } else if !agent.enabled {
          StateLine(on: false, text: "Off")
        } else {
          StateLine(on: false, text: "Codex is ready")
          Para("Restart Pocket Companion to turn the assistant on. Connected consoles reconnect by themselves.")
          Button("Restart Pocket Companion") { daemon.restart() }.buttonStyle(.borderedProminent)
        }
      } else {
        ProgressView()
      }
    }
  }
}

// MARK: - Settings

struct SettingsPage: View {
  @ObservedObject var daemon = Daemon.shared
  @ObservedObject var loginItem = LoginItem.shared
  @Environment(\.openURL) private var openURL

  var body: some View {
    VStack(alignment: .leading, spacing: 16) {
      PageTitle(title: "Settings", line: "Pocket Companion runs in the menu bar. Consoles reach this Mac while it runs.")
      Toggle("Open Pocket Companion when you log in", isOn: Binding(get: { loginItem.enabled }, set: { loginItem.set($0) }))
        .toggleStyle(.switch)
      if let problem = loginItem.problem {
        Text(problem).foregroundStyle(.orange)
      }
      if let status = daemon.status {
        Grid(alignment: .leading, horizontalSpacing: 16, verticalSpacing: 8) {
          GridRow {
            Text("Name on consoles").foregroundStyle(.secondary)
            Text(status.companion.name)
          }
          GridRow {
            Text("Address").foregroundStyle(.secondary)
            Text(status.companion.addresses.isEmpty ? "No network" : status.companion.addresses.map { "\($0):\(status.companion.port)" }.joined(separator: ", "))
              .textSelection(.enabled)
          }
          GridRow {
            Text("Version").foregroundStyle(.secondary)
            Text(Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? "")
          }
        }
        Para("The name is this Mac's name in System Settings › General › Sharing.").foregroundStyle(.secondary)
      }
      HStack {
        Button("Show the Log") { NSWorkspace.shared.open(daemon.logURL) }
        Button("Restart Pocket Companion") { daemon.restart() }
        Button("Pocket Companion on Pocket Studio") { openURL(Studio.companion) }
      }
    }
  }
}

// MARK: - Snapshot

/// `--snapshot <png> [--page <page>] [--window]` renders a page to a PNG five
/// seconds after launch: a check that needs no screen-recording permission.
/// `--window` draws it inside the window's frame: title bar and sidebar.
enum Snapshot {
  @MainActor
  static func write(page: Page, to url: URL) {
    let content = PageView(page: page).padding(28).frame(width: 620, alignment: .leading)
    let view: AnyView = CommandLine.arguments.contains("--window")
      ? AnyView(WindowPicture(page: page, content: content))
      : AnyView(content.background(Color(nsColor: .windowBackgroundColor)))
    let renderer = ImageRenderer(content: view)
    renderer.scale = 2
    guard let cg = renderer.cgImage else { return }
    try? NSBitmapImageRep(cgImage: cg).representation(using: .png, properties: [:])?.write(to: url)
  }
}

/// The window drawn for a snapshot: a title bar, the sidebar with `page`
/// selected, and the page. Offscreen rendering cannot draw a live window.
struct WindowPicture<Content: View>: View {
  let page: Page
  let content: Content

  private static var lights: [Color] {
    [Color(red: 1, green: 0.37, blue: 0.34), Color(red: 1, green: 0.74, blue: 0.18), Color(red: 0.16, green: 0.79, blue: 0.25)]
  }

  var body: some View {
    VStack(spacing: 0) {
      titleBar
      HStack(alignment: .top, spacing: 0) {
        sidebar
        content
          .frame(maxWidth: .infinity, alignment: .topLeading)
          .background(Color(nsColor: .windowBackgroundColor))
      }
    }
    .frame(width: 860)
    .background(Color(nsColor: .windowBackgroundColor))
    .clipShape(RoundedRectangle(cornerRadius: 12))
  }

  private var titleBar: some View {
    HStack(spacing: 8) {
      ForEach(0..<3, id: \.self) { index in
        Circle().fill(Self.lights[index]).frame(width: 12, height: 12)
      }
      Spacer()
      Text("Pocket Companion").font(.system(size: 13, weight: .semibold)).foregroundStyle(.secondary)
      Spacer()
      Color.clear.frame(width: 52, height: 12)
    }
    .padding(.horizontal, 14)
    .frame(height: 38)
  }

  private var sidebar: some View {
    VStack(alignment: .leading, spacing: 2) {
      item(.start)
      item(.consoles)
      item(.applets)
      Text("Services")
        .font(.system(size: 11, weight: .semibold))
        .foregroundStyle(.secondary)
        .padding(.leading, 10)
        .padding(.top, 14)
      item(.x)
      item(.discord)
      item(.youtube)
      item(.assistant)
      Spacer().frame(height: 14)
      item(.settings)
      Spacer()
    }
    .padding(10)
    .frame(width: 200)
    .frame(maxHeight: .infinity, alignment: .top)
    .background(Color(nsColor: .controlBackgroundColor).opacity(0.6))
    .background(Color.secondary.opacity(0.08))
  }

  private func item(_ entry: Page) -> some View {
    let selected: Bool = entry == page
    return Label(entry.title, systemImage: entry.symbol)
      .font(.system(size: 13))
      .padding(.horizontal, 10)
      .padding(.vertical, 5)
      .frame(maxWidth: .infinity, alignment: .leading)
      .background(RoundedRectangle(cornerRadius: 6).fill(selected ? Color.accentColor.opacity(0.22) : Color.clear))
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

  /// Opening the app again from Finder or Launchpad shows its window.
  func applicationShouldHandleReopen(_ sender: NSApplication, hasVisibleWindows flag: Bool) -> Bool {
    true
  }
}

@main
struct PocketCompanionApp: App {
  @NSApplicationDelegateAdaptor(AppDelegate.self) var delegate

  /// The window opens at launch for an owner with no paired console, or when asked.
  private static let showAtLaunch = !CommandLine.arguments.contains("--snapshot")
    && (CommandLine.arguments.contains("--show-window") || Daemon.pairedOnDisk() == 0)

  var body: some Scene {
    MenuBarExtra("Pocket Companion", systemImage: "link.circle") {
      MenuContent()
    }
    Window("Pocket Companion", id: "main") {
      MainWindow()
    }
    .defaultSize(width: 820, height: 620)
    .windowResizability(.contentMinSize)
    .defaultLaunchBehavior(Self.showAtLaunch ? .presented : .suppressed)
  }
}
