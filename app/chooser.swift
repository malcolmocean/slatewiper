// app/chooser.swift — the window SlateWiper.app shows when launched with no arguments.
// Pick a mode (soft / hard / snapshot) and when (now, a preset, or N minutes), or cancel an armed timer.
// Lives outside the bundle like app-main.sh (so editing it never touches the signature); app-main.sh
// compiles it to app/chooser on first use / when this file changes, and falls back to osascript lists
// if that fails.
//
//   chooser '<timer.mjs status --json>'
//
// Prints exactly one line and exits: `go soft` · `go hard` · `snapshot` · `in <min> soft|hard|snapshot` ·
// `cancel-timer` — or nothing if dismissed.
import AppKit
import SwiftUI

struct TimerState: Decodable { var armed = false; var fireAt: Double? = nil; var mode: String? = nil }
let armed: TimerState = {
  guard CommandLine.arguments.count > 1, let d = CommandLine.arguments[1].data(using: .utf8),
        let t = try? JSONDecoder().decode(TimerState.self, from: d) else { return TimerState() }
  return t
}()
let repo = URL(fileURLWithPath: CommandLine.arguments[0]).resolvingSymlinksInPath()
  .deletingLastPathComponent().deletingLastPathComponent()

func finish(_ out: String?) -> Never {
  if let out { print(out) }
  fflush(stdout); exit(0)
}

enum Mode: String, CaseIterable, Identifiable {
  case soft, hard, snapshot
  var id: String { rawValue }
  var title: String { ["soft": "Soft wipe", "hard": "Hard wipe", "snapshot": "Snapshot"][rawValue]! }
  var blurb: String {
    switch self {
    case .soft: return "Close everything that needs no confirmation."
    case .hard: return "Also kill working sessions and disarm unsaved-state checks."
    case .snapshot: return "Archive everything, close nothing."
    }
  }
  var symbol: String { ["soft": "sparkles", "hard": "flame.fill", "snapshot": "camera.fill"][rawValue]! }
  var tint: Color { ["soft": Color.teal, "hard": Color.red, "snapshot": Color.indigo][rawValue]! }
}

enum When: Hashable { case now, minutes(Int), custom }
let presets: [(When, String)] = [(.now, "Now"), (.minutes(5), "5 min"), (.minutes(20), "20 min"),
                                 (.minutes(60), "1 h"), (.minutes(300), "5 h"), (.custom, "Custom")]

func clock(_ ms: Double) -> String {
  let f = DateFormatter(); f.timeStyle = .short; f.dateStyle = .none
  return f.string(from: Date(timeIntervalSince1970: ms / 1000))
}
func human(_ min: Double) -> String {
  if min < 60 { return "\(Int(min.rounded(.up))) min" }
  let h = Int(min) / 60, m = Int(min) % 60
  return m == 0 ? "\(h) h" : "\(h) h \(m) min"
}

struct ModeCard: View {
  let mode: Mode, selected: Bool, action: () -> Void
  @State private var hover = false
  var body: some View {
    Button(action: action) {
      VStack(alignment: .leading, spacing: 8) {
        ZStack {
          Circle().fill(mode.tint.opacity(selected ? 0.22 : 0.12)).frame(width: 36, height: 36)
          Image(systemName: mode.symbol).font(.system(size: 16, weight: .semibold)).foregroundStyle(mode.tint)
        }
        Text(mode.title).font(.system(size: 14, weight: .semibold))
        Text(mode.blurb).font(.system(size: 11.5)).foregroundStyle(.secondary)
          .fixedSize(horizontal: false, vertical: true)
        Spacer(minLength: 0)
      }
      .padding(14)
      .frame(width: 168, height: 142, alignment: .topLeading)
      .background(RoundedRectangle(cornerRadius: 14, style: .continuous)
        .fill(selected ? mode.tint.opacity(0.10) : Color.primary.opacity(hover ? 0.07 : 0.04)))
      .overlay(RoundedRectangle(cornerRadius: 14, style: .continuous)
        .strokeBorder(selected ? mode.tint : Color.primary.opacity(0.10), lineWidth: selected ? 2 : 1))
      .contentShape(RoundedRectangle(cornerRadius: 14, style: .continuous))
    }
    .buttonStyle(.plain)
    .onHover { hover = $0 }
    .animation(.easeOut(duration: 0.12), value: selected)
  }
}

struct Chip: View {
  let label: String, selected: Bool, tint: Color, action: () -> Void
  var body: some View {
    Button(action: action) {
      Text(label).font(.system(size: 12.5, weight: selected ? .semibold : .regular))
        .padding(.horizontal, 12).padding(.vertical, 6)
        .foregroundStyle(selected ? Color.white : Color.primary)
        .background(Capsule().fill(selected ? tint : Color.primary.opacity(0.06)))
        .contentShape(Capsule())
    }
    .buttonStyle(.plain)
  }
}

struct Chooser: View {
  @State var mode: Mode = .soft
  @State var when: When = .now
  @State var custom = ""
  @FocusState var customFocused: Bool

  var customMinutes: Double? {
    guard let v = Double(custom.trimmingCharacters(in: .whitespaces)), v > 0, v <= 10080 else { return nil }
    return v
  }
  var timed: Bool { when != .now }
  var minutes: Double? {
    switch when { case .now: return nil; case .minutes(let m): return Double(m); case .custom: return customMinutes }
  }
  var canGo: Bool { !timed || minutes != nil }
  var goLabel: String {
    guard timed else { return mode == .snapshot ? "Take snapshot" : "\(mode.title) now" }
    guard let m = minutes else { return "\(mode.title) in…" }
    return "\(mode.title) in \(human(m))"
  }
  var goSymbol: String { timed ? "timer" : mode.symbol }

  func go() {
    guard canGo else { return }
    if let m = minutes, timed { finish("in \(m == m.rounded() ? String(Int(m)) : String(m)) \(mode.rawValue)") }
    finish(mode == .snapshot ? "snapshot" : "go \(mode.rawValue)")
  }

  var body: some View {
    VStack(alignment: .leading, spacing: 18) {
      HStack(spacing: 14) {
        if let icon = NSImage(contentsOf: repo.appendingPathComponent("app/icon/SlateWiper-1024.png")) {
          Image(nsImage: icon).resizable().frame(width: 52, height: 52)
        }
        VStack(alignment: .leading, spacing: 2) {
          Text("Clear the slate?").font(.system(size: 20, weight: .bold))
          Text("Everything gets archived to ~/slate first.").font(.system(size: 12)).foregroundStyle(.secondary)
        }
      }

      if armed.armed, let fireAt = armed.fireAt {
        TimelineView(.periodic(from: .now, by: 1)) { ctx in
          let left = max(0, fireAt / 1000 - ctx.date.timeIntervalSince1970) / 60
          HStack(spacing: 10) {
            Image(systemName: "timer").foregroundStyle(.orange).font(.system(size: 15, weight: .semibold))
            VStack(alignment: .leading, spacing: 1) {
              Text("\(Mode(rawValue: armed.mode ?? "soft")?.title ?? "Wipe") armed for \(clock(fireAt))")
                .font(.system(size: 12.5, weight: .semibold))
              Text("\(human(left)) left · arming another replaces it").font(.system(size: 11)).foregroundStyle(.secondary)
            }
            Spacer()
            Button("Cancel timer") { finish("cancel-timer") }.controlSize(.small)
          }
          .padding(10)
          .background(RoundedRectangle(cornerRadius: 10, style: .continuous).fill(Color.orange.opacity(0.12)))
        }
      }

      HStack(spacing: 12) {
        ForEach(Mode.allCases) { m in ModeCard(mode: m, selected: mode == m) { mode = m } }
      }

      VStack(alignment: .leading, spacing: 8) {
        Text("WHEN").font(.system(size: 10.5, weight: .semibold)).foregroundStyle(.secondary).tracking(0.6)
        HStack(spacing: 6) {
          ForEach(presets, id: \.1) { w, label in
            Chip(label: label, selected: when == w, tint: mode.tint) {
              when = w; if w == .custom { customFocused = true }
            }
          }
          if when == .custom {
            TextField("45", text: $custom).textFieldStyle(.roundedBorder).frame(width: 64)
              .focused($customFocused).onSubmit(go)
            Text("min").font(.system(size: 12)).foregroundStyle(.secondary)
          }
        }
        .frame(height: 28)
      }

      HStack {
        VStack(alignment: .leading, spacing: 3) {
          Label("Closes all tabs, even ones that try to stop it", systemImage: "exclamationmark.triangle.fill")
          Label("Kills all running terminal processes", systemImage: "exclamationmark.triangle.fill")
        }
        .font(.system(size: 11)).foregroundStyle(.red.opacity(0.85))
        .opacity(mode == .hard ? 1 : 0)   // keep the space so the window doesn't jump
        Spacer()
        Button("Cancel") { finish(nil) }.keyboardShortcut(.cancelAction).controlSize(.large)
        Button(action: go) { Label(goLabel, systemImage: goSymbol).frame(minWidth: 150) }
          .keyboardShortcut(.defaultAction).controlSize(.large).tint(mode.tint)
          .buttonStyle(.borderedProminent).disabled(!canGo)
      }
    }
    .padding(.horizontal, 22).padding(.top, 6).padding(.bottom, 20)
    .frame(width: 22 * 2 + 168 * 3 + 12 * 2)
  }
}

final class Delegate: NSObject, NSApplicationDelegate, NSWindowDelegate {
  var window: NSWindow!
  func applicationDidFinishLaunching(_ n: Notification) {
    let host = NSHostingView(rootView: Chooser())
    window = NSWindow(contentRect: .zero, styleMask: [.titled, .closable, .fullSizeContentView],
                      backing: .buffered, defer: false)
    window.titlebarAppearsTransparent = true
    window.titleVisibility = .hidden
    window.isMovableByWindowBackground = true
    let fx = NSVisualEffectView(); fx.material = .popover; fx.blendingMode = .behindWindow; fx.state = .active
    fx.addSubview(host); host.translatesAutoresizingMaskIntoConstraints = false
    NSLayoutConstraint.activate([host.leadingAnchor.constraint(equalTo: fx.leadingAnchor),
                                 host.trailingAnchor.constraint(equalTo: fx.trailingAnchor),
                                 host.topAnchor.constraint(equalTo: fx.topAnchor),
                                 host.bottomAnchor.constraint(equalTo: fx.bottomAnchor)])
    window.contentView = fx
    window.setContentSize(host.fittingSize)
    window.standardWindowButton(.miniaturizeButton)?.isHidden = true
    window.standardWindowButton(.zoomButton)?.isHidden = true
    window.delegate = self
    window.level = .floating
    window.center()
    window.makeKeyAndOrderFront(nil)
    NSApp.activate(ignoringOtherApps: true)
    if let out = ProcessInfo.processInfo.environment["SLATE_CHOOSER_SNAPSHOT"] {   // dev: render to PNG and quit
      DispatchQueue.main.asyncAfter(deadline: .now() + 0.6) {
        let v = self.window.contentView!.superview ?? self.window.contentView!
        let rep = v.bitmapImageRepForCachingDisplay(in: v.bounds)!
        v.cacheDisplay(in: v.bounds, to: rep)
        try? rep.representation(using: .png, properties: [:])?.write(to: URL(fileURLWithPath: out))
        exit(0)
      }
    }
  }
  func windowWillClose(_ n: Notification) { finish(nil) }
}

let app = NSApplication.shared
app.setActivationPolicy(.accessory)
let delegate = Delegate()
app.delegate = delegate
app.run()
