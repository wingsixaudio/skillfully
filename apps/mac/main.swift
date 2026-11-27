// Skillfully for the Mac: the icon a team clicks.
//
// It is the small fixed part that is not itself updated. It carries the runtime and one version of the
// hub, and it does the three things docs/updates.md asks of whatever starts a hub: run the current
// version, move on to a newer one when the hub asks, and go back when a new one will not start. Around
// that it does what a person needs and a terminal used to do, in one small window and a mark in the menu
// bar: says whether the hub is running, opens it in a browser, shows the first owner their code, says
// what address phones use, and stops, starts and restarts it. Closing the window leaves the hub running
// in the background. Quitting stops it, and so does the app dying any other way.
//
// Everything the hub knows lives in ~/Library/Application Support/Skillfully, which outlasts the app.

import AppKit
import Foundation
import ServiceManagement

let RESTART: Int32 = 75
let fm = FileManager.default
let args = CommandLine.arguments
func arg(_ name: String) -> String? {
  args.first { $0.hasPrefix("--\(name)=") }.map { String($0.dropFirst(name.count + 3)) }
}

let home: URL = arg("home").map { URL(fileURLWithPath: $0) }
  ?? fm.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0].appendingPathComponent("Skillfully")
let resources = Bundle.main.resourceURL ?? URL(fileURLWithPath: ".")

func read(_ name: String) -> String {
  ((try? String(contentsOf: home.appendingPathComponent(name), encoding: .utf8)) ?? "")
    .trimmingCharacters(in: .whitespacesAndNewlines)
}
func write(_ name: String, _ text: String) {
  try? (text + "\n").write(to: home.appendingPathComponent(name), atomically: true, encoding: .utf8)
}
func numberOf(_ version: String) -> Int { Int(version.split(separator: "-").first ?? "") ?? 0 }
func there(_ version: String) -> Bool {
  version.range(of: "^[0-9]+-[0-9a-f]{7}$", options: .regularExpression) != nil
    && fm.fileExists(atPath: home.appendingPathComponent("versions/\(version)/core/main.ts").path)
}
func json(_ url: URL) -> [String: Any]? {
  guard let data = try? Data(contentsOf: url) else { return nil }
  return (try? JSONSerialization.jsonObject(with: data)) as? [String: Any]
}

/// The version that came inside this app is put where versions live, when it is newer than the one there.
func installBundled() {
  try? fm.createDirectory(at: home.appendingPathComponent("versions"), withIntermediateDirectories: true)
  try? fm.createDirectory(at: home.appendingPathComponent("logs"), withIntermediateDirectories: true)
  let bundled = resources.appendingPathComponent("version")
  guard let about = json(bundled.appendingPathComponent("bundle.json")),
    let number = about["number"] as? Int, let commit = about["commit"] as? String
  else { return }
  let name = "\(number)-\(commit.prefix(7))"
  let current = read("current")
  if there(current) && numberOf(current) >= number { return }
  let into = home.appendingPathComponent("versions/\(name)")
  if !there(name) {
    try? fm.removeItem(at: into)
    try? fm.copyItem(at: bundled, to: into)
  }
  if there(name) { write("current", name) }
}

/// Whether nothing is listening on a port of this computer.
func free(_ port: Int) -> Bool {
  let s = socket(AF_INET, SOCK_STREAM, 0)
  if s < 0 { return false }
  defer { close(s) }
  var yes: Int32 = 1
  setsockopt(s, SOL_SOCKET, SO_REUSEADDR, &yes, socklen_t(MemoryLayout<Int32>.size))
  var addr = sockaddr_in()
  addr.sin_len = UInt8(MemoryLayout<sockaddr_in>.size)
  addr.sin_family = sa_family_t(AF_INET)
  addr.sin_port = in_port_t(port).bigEndian
  addr.sin_addr.s_addr = INADDR_ANY
  return withUnsafePointer(to: &addr) {
    $0.withMemoryRebound(to: sockaddr.self, capacity: 1) { bind(s, $0, socklen_t(MemoryLayout<sockaddr_in>.size)) == 0 }
  }
}

/// The port the hub listens on: the one it had last time when that is free, since phones remember the
/// address, and otherwise the first free one from 8080 up.
func choosePort() -> Int {
  let last = Int(read("port")) ?? 0
  let tries = (last > 1023 ? [last] : []) + Array(8080...8099)
  let port = tries.first(where: free) ?? 8080
  write("port", String(port))
  return port
}

/// Do something on the main thread the next time it comes round, whatever it is in the middle of. While
/// the app is quitting it waits inside the thing that asked it to quit, and work queued the usual way
/// would wait behind that for ever.
func onMain(_ work: @escaping () -> Void) {
  RunLoop.main.perform(inModes: [.common, .modalPanel], block: work)
  CFRunLoopWakeUp(CFRunLoopGetMain())
}

/// The hub as a process: started, kept running across updates and crashes, and stopped when asked.
final class Hub {
  private var process: Process?
  private var before = ""
  private var then: (() -> Void)?
  private var crashes: [Date] = []
  /// Held open for as long as this app lives. The hub stops when it closes, so it never outlives the app.
  private var leash: Pipe?
  private(set) var failed: String?
  /// True from the moment a person stops the hub until they start it again.
  private(set) var stoppedByPerson = false
  /// Nil when run to test itself, which names its own port.
  var extra: [String]? = nil
  var changed: () -> Void = {}

  var running: Bool { process?.isRunning ?? false }

  func start() {
    if running { return }
    let version = read("current")
    guard there(version) else {
      failed = "There is no version of the hub to run."
      changed()
      return
    }
    failed = nil
    stoppedByPerson = false
    try? fm.removeItem(at: home.appendingPathComponent("status.json"))
    let dir = home.appendingPathComponent("versions/\(version)")
    let p = Process()
    p.executableURL = resources.appendingPathComponent("deno")
    p.arguments =
      [
        "run", "--cached-only", "--no-prompt", "--allow-net", "--allow-read",
        "--allow-env=HOME,DENO_DIR,SYSTEMROOT,LOCALAPPDATA,USERPROFILE",
        "--allow-write=\(home.path)", "--allow-run",
        dir.appendingPathComponent("core/main.ts").path, "--home=\(home.path)", "--stay-with-app",
      ] + (extra ?? ["--lan", "--port=\(choosePort())"])
    p.currentDirectoryURL = dir
    var env = ProcessInfo.processInfo.environment
    env["DENO_DIR"] = home.appendingPathComponent("cache").path
    env["DENO_NO_UPDATE_CHECK"] = "1"
    p.environment = env
    let held = Pipe()
    p.standardInput = held
    leash = held
    // What the hub says goes to a file a person can be asked to send, not to a window nobody watches.
    let log = home.appendingPathComponent("logs/hub.log")
    if let size = (try? fm.attributesOfItem(atPath: log.path))?[.size] as? Int, size > 5_000_000 {
      try? fm.removeItem(at: log)
    }
    if !fm.fileExists(atPath: log.path) { fm.createFile(atPath: log.path, contents: nil) }
    if let out = try? FileHandle(forWritingTo: log) {
      out.seekToEndOfFile()
      p.standardOutput = out
      p.standardError = out
    }
    let started = Date()
    p.terminationHandler = { done in
      onMain { self.stopped(code: done.terminationStatus, version: version, started: started) }
    }
    do {
      try p.run()
      process = p
    } catch {
      failed = "The hub could not be started: \(error.localizedDescription)"
    }
    changed()
  }

  private func stopped(code: Int32, version: String, started: Date) {
    process = nil
    leash = nil
    if let after = then {
      // Stopped because someone asked.
      then = nil
      changed()
      after()
      return
    }
    if code == RESTART {
      // The hub fetched a newer version and asks for it to be started.
      let next = read("next")
      try? fm.removeItem(at: home.appendingPathComponent("next"))
      if !next.isEmpty && next != version && there(next) {
        before = version
        write("current", next)
      }
      start()
      return
    }
    if code != 0 && !before.isEmpty && Date().timeIntervalSince(started) < 20 {
      // A version just moved to that cannot start: the one before is put back, with the data as it was.
      let number = numberOf(version)
      let kept = home.appendingPathComponent("backups/before-\(number).db")
      let db = home.appendingPathComponent("data/skillfully.db")
      if fm.fileExists(atPath: kept.path) {
        try? fm.removeItem(at: home.appendingPathComponent("backups/failed-\(number).db"))
        try? fm.copyItem(at: db, to: home.appendingPathComponent("backups/failed-\(number).db"))
        for tail in ["", "-wal", "-shm"] { try? fm.removeItem(atPath: db.path + tail) }
        try? fm.copyItem(at: kept, to: db)
      }
      write("current", before)
      write("went-back", "\(version) stopped at once on \(ISO8601DateFormatter().string(from: Date()))")
      before = ""
      start()
      return
    }
    // It stopped and nobody asked it to. It is started again, unless it keeps happening: a hub that
    // cannot stay up for a few minutes is not helped by being started a sixth time.
    crashes = crashes.filter { Date().timeIntervalSince($0) < 600 } + [Date()]
    if crashes.count <= 5 && extra == nil {
      failed = "The hub stopped by itself. Starting it again."
      changed()
      DispatchQueue.main.asyncAfter(deadline: .now() + 2) {
        if !self.running && !self.stoppedByPerson { self.start() }
      }
      return
    }
    failed = "The hub keeps stopping by itself. The log says why."
    changed()
  }

  /// Stop the hub, and say when it has stopped. It is asked first, and made to if it does not listen.
  func stop(_ after: @escaping () -> Void = {}) {
    stoppedByPerson = true
    failed = nil
    guard let p = process, p.isRunning else {
      changed()
      after()
      return
    }
    then = after
    p.terminate()
    DispatchQueue.main.asyncAfter(deadline: .now() + 6) { if p.isRunning { kill(p.processIdentifier, SIGKILL) } }
    changed()
  }

  func restart() { stop { self.start() } }

  /// What the running hub says about itself, once it is up.
  var status: [String: Any]? { running ? json(home.appendingPathComponent("status.json")) : nil }
}

/// A hub this app started earlier and never stopped, because the app was forced to quit: stopped now, so
/// there is one hub and it is the one this window is about.
func stopLeftover() {
  guard let old = json(home.appendingPathComponent("status.json")), let pid = old["pid"] as? Int, pid > 1
  else { return }
  let ps = Process()
  ps.executableURL = URL(fileURLWithPath: "/bin/ps")
  ps.arguments = ["-p", String(pid), "-o", "command="]
  let out = Pipe()
  ps.standardOutput = out
  guard (try? ps.run()) != nil else { return }
  ps.waitUntilExit()
  let command = String(data: out.fileHandleForReading.readDataToEndOfFile(), encoding: .utf8) ?? ""
  // Only ever a hub of this folder: a number in a file is not reason enough to stop a stranger.
  guard command.contains("core/main.ts") && command.contains("--home=\(home.path)") else { return }
  kill(pid_t(pid), SIGTERM)
  for _ in 0..<50 where kill(pid_t(pid), 0) == 0 { usleep(100_000) }
  if kill(pid_t(pid), 0) == 0 { kill(pid_t(pid), SIGKILL) }
}

/// The address a phone on the same network opens: this computer's own address on a home or office
/// network, read from its network cards. Nothing is looked up, so it never waits on the network.
func lanAddress(port: Int) -> String? {
  var list: UnsafeMutablePointer<ifaddrs>?
  guard getifaddrs(&list) == 0, let first = list else { return nil }
  defer { freeifaddrs(list) }
  var found: [String] = []
  var at: UnsafeMutablePointer<ifaddrs>? = first
  while let card = at {
    defer { at = card.pointee.ifa_next }
    guard let addr = card.pointee.ifa_addr, addr.pointee.sa_family == sa_family_t(AF_INET),
      card.pointee.ifa_flags & UInt32(IFF_UP) != 0, card.pointee.ifa_flags & UInt32(IFF_LOOPBACK) == 0
    else { continue }
    var name = [CChar](repeating: 0, count: Int(NI_MAXHOST))
    guard getnameinfo(addr, socklen_t(addr.pointee.sa_len), &name, socklen_t(name.count), nil, 0, NI_NUMERICHOST) == 0
    else { continue }
    let text = String(cString: name)
    if text.range(of: "^(10\\.|192\\.168\\.|172\\.(1[6-9]|2[0-9]|3[01])\\.)", options: .regularExpression) != nil {
      found.append(text)
    }
  }
  return found.first.map { "http://\($0):\(port)" }
}

// Run with --selftest, it starts the hub it carries, checks the hub answers, and stops: no windows.
// This is how the build proves an app it has just made actually runs.
if args.contains("--selftest") {
  installBundled()
  let hub = Hub()
  hub.extra = ["--port=7397", "--no-store", "--no-updates"]
  hub.start()
  var ok = false
  let deadline = Date().addingTimeInterval(60)
  while Date() < deadline && !ok {
    RunLoop.main.run(until: Date().addingTimeInterval(0.5))
    guard let status = hub.status, let url = status["url"] as? String else { continue }
    if let data = try? Data(contentsOf: URL(string: url + "/auth/me")!),
      String(data: data, encoding: .utf8)?.contains("\"claimed\"") == true
    {
      print("selftest: the hub answered at \(url), version \(read("current"))")
      ok = true
    }
  }
  if !ok {
    print("selftest: the hub did not come up. \(hub.failed ?? "")")
    print((try? String(contentsOf: home.appendingPathComponent("logs/hub.log"), encoding: .utf8)) ?? "(no log)")
  }
  var over = false
  hub.stop { over = true }
  let patience = Date().addingTimeInterval(10)
  while !over && Date() < patience { RunLoop.main.run(until: Date().addingTimeInterval(0.2)) }
  exit(ok ? 0 : 1)
}


/// The Skillfully mark for the menu bar, drawn in one colour so the Mac shows it dark on a light bar and
/// light on a dark one. The app's own icon is a dark square, which a dark bar swallows.
func barMark() -> NSImage {
  let image = NSImage(size: NSSize(width: 18, height: 18), flipped: false) { rect in
    let k = rect.width / 48
    NSColor.black.set()
    let core = NSBezierPath(
      roundedRect: NSRect(x: 16 * k, y: 16 * k, width: 16 * k, height: 16 * k), xRadius: 4.5 * k, yRadius: 4.5 * k)
    core.lineWidth = 3.6 * k
    core.stroke()
    let parts: [(CGFloat, CGFloat, CGFloat, CGFloat)] = [
      (19, 3.5, 10, 7), (19, 37.5, 10, 7), (3.5, 19, 7, 10), (37.5, 19, 7, 10),
    ]
    for (x, y, w, h) in parts {
      NSBezierPath(roundedRect: NSRect(x: x * k, y: y * k, width: w * k, height: h * k), xRadius: 2.5 * k, yRadius: 2.5 * k)
        .fill()
    }
    return true
  }
  image.isTemplate = true
  return image
}

final class AppDelegate: NSObject, NSApplicationDelegate, NSWindowDelegate {
  let hub = Hub()
  /// Run by a check, it opens no browser.
  let quiet = args.contains("--no-browser")
  var item: NSStatusItem!
  var window: NSWindow!
  var timer: Timer?
  var term: DispatchSourceSignal?
  /// Whether this start of the hub has been opened in a browser yet.
  var opened = false
  /// Whether the hub has an owner. Until it does, the window shows the code that makes someone its owner.
  var owned = false
  var ticks = 0

  let dot = NSTextField(labelWithString: "●")
  let state = NSTextField(labelWithString: "Starting")
  let detail = NSTextField(wrappingLabelWithString: "")
  let codeBox = NSStackView()
  let code = NSTextField(labelWithString: "")
  let phonesRow = NSStackView()
  let phones = NSTextField(labelWithString: "")
  var all: NSStackView!
  var claimButton: NSButton!
  var openButton: NSButton!
  var toggleButton: NSButton!
  var restartButton: NSButton!
  var login: NSButton!

  func applicationDidFinishLaunching(_ note: Notification) {
    installBundled()
    stopLeftover()

    let bar = NSMenu()
    let first = NSMenuItem()
    bar.addItem(first)
    let mine = NSMenu()
    mine.addItem(withTitle: "Show Skillfully", action: #selector(show), keyEquivalent: "0").target = self
    mine.addItem(withTitle: "Open in the browser", action: #selector(open), keyEquivalent: "o").target = self
    mine.addItem(.separator())
    mine.addItem(withTitle: "Quit and stop the hub", action: #selector(quit), keyEquivalent: "q").target = self
    first.submenu = mine
    NSApp.mainMenu = bar

    item = NSStatusBar.system.statusItem(withLength: NSStatusItem.squareLength)
    item.button?.image = barMark()
    item.button?.toolTip = "Skillfully"

    buildWindow()
    hub.changed = { [weak self] in self?.draw() }
    hub.start()
    timer = Timer.scheduledTimer(withTimeInterval: 1, repeats: true) { [weak self] _ in self?.tick() }
    draw()
    show()

    // Asked to stop by the Mac itself (shutting down, or a script): the hub is stopped first, as on Quit.
    signal(SIGTERM, SIG_IGN)
    let asked = DispatchSource.makeSignalSource(signal: SIGTERM, queue: .main)
    asked.setEventHandler { onMain { NSApp.terminate(nil) } }
    asked.resume()
    term = asked
  }

  /// The one window: how the hub is, and the few things a person does to it.
  func buildWindow() {
    window = NSWindow(
      contentRect: NSRect(x: 0, y: 0, width: 440, height: 300), styleMask: [.titled, .closable, .miniaturizable],
      backing: .buffered, defer: false)
    window.title = "Skillfully"
    window.isReleasedWhenClosed = false
    window.delegate = self

    let icon = NSImageView(image: NSApp.applicationIconImage)
    icon.translatesAutoresizingMaskIntoConstraints = false
    icon.widthAnchor.constraint(equalToConstant: 56).isActive = true
    icon.heightAnchor.constraint(equalToConstant: 56).isActive = true
    let name = NSTextField(labelWithString: "Skillfully")
    name.font = .systemFont(ofSize: 20, weight: .semibold)
    dot.font = .systemFont(ofSize: 11)
    state.font = .systemFont(ofSize: 13, weight: .medium)
    let stateRow = NSStackView(views: [dot, state])
    stateRow.spacing = 5
    let titles = NSStackView(views: [name, stateRow])
    titles.orientation = .vertical
    titles.alignment = .leading
    titles.spacing = 3
    let head = NSStackView(views: [icon, titles])
    head.spacing = 14
    head.alignment = .centerY

    detail.textColor = .secondaryLabelColor
    detail.font = .systemFont(ofSize: 12)
    detail.preferredMaxLayoutWidth = 392
    detail.isSelectable = true

    let codeLead = NSTextField(
      wrappingLabelWithString:
        "This hub has no owner yet. Enter this code on the page that opens, and it is yours to set up.")
    codeLead.preferredMaxLayoutWidth = 392
    code.font = .monospacedSystemFont(ofSize: 26, weight: .medium)
    code.isSelectable = true
    claimButton = NSButton(title: "Copy the code and open Skillfully", target: self, action: #selector(claim))
    codeBox.orientation = .vertical
    codeBox.alignment = .leading
    codeBox.spacing = 8
    for part in [codeLead, code, claimButton!] as [NSView] { codeBox.addArrangedSubview(part) }

    let phonesLead = NSTextField(labelWithString: "Phones on this network open")
    phonesLead.textColor = .secondaryLabelColor
    phones.isSelectable = true
    let copy = NSButton(title: "Copy", target: self, action: #selector(copyAddress))
    copy.controlSize = .small
    phonesRow.spacing = 6
    for part in [phonesLead, phones, copy] as [NSView] { phonesRow.addArrangedSubview(part) }

    openButton = NSButton(title: "Open Skillfully", target: self, action: #selector(open))
    toggleButton = NSButton(title: "Stop", target: self, action: #selector(toggle))
    restartButton = NSButton(title: "Restart", target: self, action: #selector(restart))
    let buttons = NSStackView(views: [openButton, toggleButton, restartButton])
    buttons.spacing = 8

    let rule = NSBox()
    rule.boxType = .separator
    login = NSButton(checkboxWithTitle: "Start when I log in", target: self, action: #selector(toggleLogin))
    let log = NSButton(title: "Show the log", target: self, action: #selector(showLog))
    let leave = NSButton(title: "Quit and stop the hub", target: self, action: #selector(quit))
    let foot = NSStackView(views: [log, leave])
    foot.spacing = 8

    all = NSStackView(views: [head, detail, codeBox, phonesRow, buttons, rule, login, foot])
    all.orientation = .vertical
    all.alignment = .leading
    all.spacing = 14
    all.edgeInsets = NSEdgeInsets(top: 22, left: 24, bottom: 22, right: 24)
    all.translatesAutoresizingMaskIntoConstraints = false
    let content = NSView()
    content.addSubview(all)
    NSLayoutConstraint.activate([
      all.leadingAnchor.constraint(equalTo: content.leadingAnchor),
      all.trailingAnchor.constraint(equalTo: content.trailingAnchor),
      all.topAnchor.constraint(equalTo: content.topAnchor),
      all.bottomAnchor.constraint(equalTo: content.bottomAnchor),
      all.widthAnchor.constraint(equalToConstant: 440),
      rule.widthAnchor.constraint(equalToConstant: 392),
    ])
    window.contentView = content
    window.center()
  }

  /// Once a second: draw how things are, and when the hub has just come up, open it.
  func tick() {
    ticks += 1
    draw()
    guard let status = hub.status, let url = status["url"] as? String else {
      opened = false
      return
    }
    // A hub with no owner shows its code until someone has used it. Asked every few seconds, not every one.
    if status["claimCode"] is String, !owned, ticks % 3 == 0, let me = URL(string: url + "/auth/me") {
      URLSession.shared.dataTask(with: me) { data, _, _ in
        let text = data.flatMap { String(data: $0, encoding: .utf8) } ?? ""
        if text.contains("\"claimed\":true") { onMain { self.owned = true } }
      }.resume()
    }
    if opened { return }
    opened = true
    if status["claimCode"] is String {
      // The first owner needs the code in front of them before the page that asks for it.
      owned = false
      show()
    } else {
      owned = true
      if !quiet, let link = URL(string: url) { NSWorkspace.shared.open(link) }
    }
    draw()
  }

  func draw() {
    let status = hub.status
    let url = status?["url"] as? String
    let port = status?["port"] as? Int ?? 8080
    let version = numberOf(read("current"))
    var word = "Starting"
    var color = NSColor.systemOrange
    var more = "It opens in your browser in a moment."
    if hub.stoppedByPerson && !hub.running {
      word = "Stopped"
      color = .systemGray
      more = "Nobody can reach Skillfully until it is started again."
    } else if let failed = hub.failed, status == nil {
      word = "Not running"
      color = .systemRed
      more = failed
    } else if let url = url {
      word = "Running, version \(version)"
      color = .systemGreen
      more = "On this computer it is at \(url). Closing this window leaves it running: the mark in the menu bar brings it back."
    }
    if !read("went-back").isEmpty && status != nil {
      more += " A newer version would not start, so this is the one before."
    }
    state.stringValue = word
    dot.textColor = color
    detail.stringValue = more

    let showCode = !owned && status?["claimCode"] is String
    codeBox.isHidden = !showCode
    code.stringValue = status?["claimCode"] as? String ?? ""
    let lan = status == nil ? nil : lanAddress(port: port)
    phonesRow.isHidden = lan == nil || showCode
    phones.stringValue = lan ?? ""

    openButton.isEnabled = status != nil
    openButton.isHidden = showCode
    claimButton.keyEquivalent = showCode ? "\r" : ""
    openButton.keyEquivalent = showCode || status == nil ? "" : "\r"
    toggleButton.title = hub.running ? "Stop" : "Start"
    restartButton.isEnabled = hub.running
    if #available(macOS 13.0, *) {
      login.state = SMAppService.mainApp.status == .enabled ? .on : .off
    }

    // The window is as tall as what it is showing, and no taller.
    all.layoutSubtreeIfNeeded()
    let fits = NSSize(width: 440, height: all.fittingSize.height)
    if let content = window.contentView, abs(content.frame.height - fits.height) > 1 {
      let top = window.frame.maxY
      window.setContentSize(fits)
      window.setFrameTopLeftPoint(NSPoint(x: window.frame.minX, y: top))
    }

    let menu = NSMenu()
    menu.addItem(withTitle: word, action: nil, keyEquivalent: "").isEnabled = false
    menu.addItem(.separator())
    menu.addItem(withTitle: "Show Skillfully", action: #selector(show), keyEquivalent: "").target = self
    if status != nil {
      menu.addItem(withTitle: "Open in the browser", action: #selector(open), keyEquivalent: "").target = self
    }
    menu.addItem(withTitle: hub.running ? "Stop" : "Start", action: #selector(toggle), keyEquivalent: "").target = self
    if hub.running {
      menu.addItem(withTitle: "Restart", action: #selector(restart), keyEquivalent: "").target = self
    }
    menu.addItem(.separator())
    menu.addItem(withTitle: "Quit and stop the hub", action: #selector(quit), keyEquivalent: "").target = self
    item.menu = menu
  }

  // With its window open it is an app like any other, in the Dock. With the window closed it is only
  // the mark in the menu bar: running in the background, and one click from being back.
  @objc func show() {
    NSApp.setActivationPolicy(.regular)
    NSApp.activate(ignoringOtherApps: true)
    window.makeKeyAndOrderFront(nil)
  }
  func windowWillClose(_ note: Notification) {
    NSApp.setActivationPolicy(.accessory)
  }
  @objc func open() {
    if let url = hub.status?["url"] as? String, let link = URL(string: url) { NSWorkspace.shared.open(link) }
  }
  @objc func claim() {
    if let code = hub.status?["claimCode"] as? String {
      NSPasteboard.general.clearContents()
      NSPasteboard.general.setString(code, forType: .string)
    }
    open()
  }
  @objc func copyAddress() {
    NSPasteboard.general.clearContents()
    NSPasteboard.general.setString(phones.stringValue, forType: .string)
  }
  @objc func toggle() {
    if hub.running { hub.stop() } else { hub.start() }
  }
  @objc func restart() { hub.restart() }
  @objc func showLog() { NSWorkspace.shared.open(home.appendingPathComponent("logs/hub.log")) }
  @objc func toggleLogin() {
    if #available(macOS 13.0, *) {
      if SMAppService.mainApp.status == .enabled {
        try? SMAppService.mainApp.unregister()
      } else {
        try? SMAppService.mainApp.register()
      }
      draw()
    }
  }
  @objc func quit() { NSApp.terminate(nil) }

  // Clicking the icon in the Dock brings the window back: the icon is where a person looks for it.
  func applicationShouldHandleReopen(_ sender: NSApplication, hasVisibleWindows flag: Bool) -> Bool {
    show()
    return false
  }

  // Closing the window is not stopping the hub. The window says so, and the icons bring it back.
  func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool { false }

  // Quitting stops the hub first, and waits for it.
  func applicationShouldTerminate(_ sender: NSApplication) -> NSApplication.TerminateReply {
    if !hub.running { return .terminateNow }
    hub.stop { NSApp.reply(toApplicationShouldTerminate: true) }
    return .terminateLater
  }
}

let app = NSApplication.shared
let delegate = AppDelegate()
app.delegate = delegate
app.setActivationPolicy(.regular)
app.run()
