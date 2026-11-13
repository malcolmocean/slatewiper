// app/wipe-anim.swift — the full-screen "wipe" that plays while slatewipe --go closes things.
// A chalkboard (green for soft, oxblood for hard) is wiped across every screen in back-and-forth
// eraser strokes until it covers everything, then "Begin again." appears in chalk. It stays up
// until stdin closes (slatewipe ends it when the wipe is done, or by exiting), then fades out.
// One wipe in ten, the hand from the logo does the wiping.
//
//   wipe-anim soft|hard [--hand | --no-hand] [--snapshot out.png]
//
// Compiled by slatewipe.mjs to app/wipe-anim on first use and whenever this file changes.
// Click or press any key to dismiss it early. It never blocks the wipe: it only draws.
import AppKit
import QuartzCore

let argv = Array(CommandLine.arguments.dropFirst())
let hard = argv.first == "hard"
let hand = argv.contains("--hand") ? true : argv.contains("--no-hand") ? false : Int.random(in: 0..<10) == 0
let snapshotOut: String? = argv.firstIndex(of: "--snapshot").flatMap { $0 + 1 < argv.count ? argv[$0 + 1] : nil }
let repo = URL(fileURLWithPath: CommandLine.arguments[0]).resolvingSymlinksInPath()
  .deletingLastPathComponent().deletingLastPathComponent()

let rows = 4                    // eraser strokes from top to bottom
let strokeTime = 0.62           // seconds per stroke
let textDelay = 0.15, textFade = 0.7
let minHold = 1.6               // keep "Begin again." up at least this long
let maxHold = 120.0             // give up waiting for slatewipe after this
let fadeOut = 0.9
let coverTime = Double(rows) * strokeTime

let base: (CGFloat, CGFloat, CGFloat) = hard ? (0.27, 0.075, 0.08) : (0.11, 0.27, 0.22)

// Deterministic noise so the ragged edges don't shimmer from frame to frame.
struct Rand { var s: UInt64; mutating func next() -> CGFloat { s = s &* 6364136223846793005 &+ 1442695040888963407; return CGFloat((s >> 33) % 1_000_000) / 1_000_000 } }

func boardImage(_ size: CGSize) -> CGImage {
  let w = Int(size.width), h = Int(size.height)
  let ctx = CGContext(data: nil, width: w, height: h, bitsPerComponent: 8, bytesPerRow: 0,
                      space: CGColorSpaceCreateDeviceRGB(), bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)!
  ctx.setFillColor(red: base.0, green: base.1, blue: base.2, alpha: 1); ctx.fill(CGRect(x: 0, y: 0, width: w, height: h))
  var r = Rand(s: 42)
  // old chalk, rubbed out: broad faint arcs
  ctx.setLineCap(.round)
  for _ in 0..<70 {
    let y = r.next() * size.height, x = r.next() * size.width, len = 200 + r.next() * size.width * 0.6
    ctx.setStrokeColor(red: 1, green: 1, blue: 1, alpha: 0.008 + r.next() * 0.02)
    ctx.setLineWidth(18 + r.next() * 110)
    ctx.move(to: CGPoint(x: x, y: y))
    ctx.addQuadCurve(to: CGPoint(x: x + len, y: y + (r.next() - 0.5) * 120),
                     control: CGPoint(x: x + len / 2, y: y + (r.next() - 0.5) * 260))
    ctx.strokePath()
  }
  // fine streaks
  for _ in 0..<500 {
    let y = r.next() * size.height, x = r.next() * size.width, len = 20 + r.next() * 180
    ctx.setStrokeColor(red: 1, green: 1, blue: 1, alpha: 0.02 + r.next() * 0.05)
    ctx.setLineWidth(0.5 + r.next() * 1.2)
    ctx.move(to: CGPoint(x: x, y: y)); ctx.addLine(to: CGPoint(x: x + len, y: y + (r.next() - 0.5) * 14)); ctx.strokePath()
  }
  // dust
  for _ in 0..<Int(size.width * size.height / 260) {
    ctx.setFillColor(red: 1, green: 1, blue: 1, alpha: 0.02 + r.next() * 0.07)
    ctx.fill(CGRect(x: r.next() * size.width, y: r.next() * size.height, width: 1 + r.next() * 1.5, height: 1 + r.next() * 1.5))
  }
  // vignette
  let g = CGGradient(colorSpace: CGColorSpaceCreateDeviceRGB(), colorComponents: [0, 0, 0, 0, 0, 0, 0, 0.35], locations: [0.45, 1], count: 2)!
  let c = CGPoint(x: size.width / 2, y: size.height / 2)
  ctx.drawRadialGradient(g, startCenter: c, startRadius: 0, endCenter: c, endRadius: hypot(size.width, size.height) / 2, options: [])
  return ctx.makeImage()!
}

// "Begin again." in chalk: white Chalkboard SE with random flecks knocked out of it.
func chalkText(_ text: String, width: CGFloat, scale: CGFloat) -> (CGImage, CGSize) {
  let fontName = "ChalkboardSE-Bold"
  var size: CGFloat = 200
  func attrs(_ s: CGFloat) -> [NSAttributedString.Key: Any] {
    [.font: NSFont(name: fontName, size: s) ?? NSFont.systemFont(ofSize: s, weight: .heavy), .foregroundColor: NSColor.white]
  }
  size *= (width * 0.82) / NSAttributedString(string: text, attributes: attrs(size)).size().width
  let str = NSAttributedString(string: text, attributes: attrs(size))
  let ts = str.size(), pad: CGFloat = 20
  let box = CGSize(width: ts.width + pad * 2, height: ts.height + pad * 2)
  let w = Int(box.width * scale), h = Int(box.height * scale)
  let ctx = CGContext(data: nil, width: w, height: h, bitsPerComponent: 8, bytesPerRow: 0,
                      space: CGColorSpaceCreateDeviceRGB(), bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)!
  ctx.scaleBy(x: scale, y: scale)
  NSGraphicsContext.saveGraphicsState()
  NSGraphicsContext.current = NSGraphicsContext(cgContext: ctx, flipped: false)
  str.draw(at: CGPoint(x: pad, y: pad))
  NSGraphicsContext.restoreGraphicsState()
  ctx.setBlendMode(.destinationOut)
  var r = Rand(s: 7)
  for _ in 0..<Int(box.width * box.height / 30) {
    ctx.setFillColor(red: 0, green: 0, blue: 0, alpha: 0.25 + r.next() * 0.75)
    let d = 0.8 + r.next() * 2.2
    ctx.fillEllipse(in: CGRect(x: r.next() * box.width, y: r.next() * box.height, width: d, height: d * (0.5 + r.next())))
  }
  // horizontal drag marks, like chalk on its side
  for _ in 0..<Int(box.height / 3) {
    ctx.setStrokeColor(red: 0, green: 0, blue: 0, alpha: 0.15 + r.next() * 0.3)
    ctx.setLineWidth(0.6 + r.next())
    let y = r.next() * box.height, x = r.next() * box.width
    ctx.move(to: CGPoint(x: x, y: y)); ctx.addLine(to: CGPoint(x: x + 30 + r.next() * 160, y: y + (r.next() - 0.5) * 6)); ctx.strokePath()
  }
  return (ctx.makeImage()!, box)
}

final class Board {
  let window: NSWindow, frame: CGRect
  let board = CALayer(), mask = CAShapeLayer(), text = CALayer(), handLayer = CALayer()
  var edges: [[CGFloat]] = []   // per-stroke ragged-edge offsets
  init(screen: NSScreen) {
    frame = screen.frame
    window = NSWindow(contentRect: frame, styleMask: .borderless, backing: .buffered, defer: false, screen: screen)
    window.level = .screenSaver
    window.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary, .stationary, .ignoresCycle]
    window.isOpaque = false; window.backgroundColor = .clear; window.hasShadow = false
    window.setFrame(frame, display: false)
    let v = NSView(frame: CGRect(origin: .zero, size: frame.size)); v.wantsLayer = true
    window.contentView = v
    let root = v.layer!, scale = screen.backingScaleFactor
    board.frame = root.bounds; board.contents = boardImage(frame.size); board.contentsGravity = .resize
    board.mask = mask; mask.frame = root.bounds; mask.fillColor = NSColor.black.cgColor
    root.addSublayer(board)
    let (img, box) = chalkText("Begin again.", width: frame.width, scale: scale)
    text.contents = img; text.contentsScale = scale
    text.frame = CGRect(x: (frame.width - box.width) / 2, y: (frame.height - box.height) / 2, width: box.width, height: box.height)
    text.opacity = 0
    text.shadowColor = NSColor.white.cgColor; text.shadowOpacity = 0.25; text.shadowRadius = 14; text.shadowOffset = .zero
    root.addSublayer(text)
    if hand, let h = NSImage(contentsOf: repo.appendingPathComponent("app/wipe-hand.png")) {
      let hh = frame.height / CGFloat(rows) * 1.9
      handLayer.contents = h.cgImage(forProposedRect: nil, context: nil, hints: nil)
      handLayer.bounds = CGRect(x: 0, y: 0, width: hh * h.size.width / h.size.height, height: hh)
      handLayer.anchorPoint = CGPoint(x: 0.62, y: 0.80)   // middle of the eraser
      handLayer.position = CGPoint(x: -400, y: -400)
      root.addSublayer(handLayer)
    }
    var r = Rand(s: UInt64(frame.width * 31 + frame.height))
    edges = (0..<rows).map { _ in (0..<40).map { _ in r.next() } }
  }

  // t: seconds since start. Builds the covered area as a union of strokes, each with wavy
  // top and bottom edges and a ragged leading edge where the eraser is.
  func draw(_ t: Double) {
    let W = frame.width, H = frame.height, rowH = H / CGFloat(rows), overlap = rowH * 0.28
    let path = CGMutablePath()
    var lead: CGPoint? = nil
    for i in 0..<rows {
      let raw = (t - Double(i) * strokeTime) / strokeTime
      if raw <= 0 { break }
      let p = CGFloat(min(1, raw)), e = p < 0.5 ? 2 * p * p : 1 - pow(-2 * p + 2, 2) / 2
      let ltr = i % 2 == 0, edge = edges[i]
      let top = H - CGFloat(i) * rowH + (i == 0 ? 40 : overlap), bot = H - CGFloat(i + 1) * rowH - (i == rows - 1 ? 40 : overlap)
      let reach = -60 + e * (W + 120)          // how far along the stroke has gone
      let x0: CGFloat = ltr ? -60 : W + 60, x1 = ltr ? reach : W - reach
      // Edges depend on absolute x, so they stay put while the stroke grows. Every stroke is built
      // with the same winding (left to right along the top), so overlaps add up instead of cancelling.
      let ph = edge[0] * 6.28, ph2 = edge[1] * 6.28, step: CGFloat = 14
      func jit(_ x: CGFloat, _ salt: Int) -> CGFloat { edge[(Int((x + 200) / step) &* 7 &+ salt) % edge.count] - 0.5 }
      func wavy(_ x: CGFloat, _ y: CGFloat, _ salt: Int) -> CGFloat {
        let u = Double(x / W) * 2 * .pi
        return y + overlap * 0.32 * CGFloat(sin(u * 2.3 + ph + Double(salt)) * 0.7 + sin(u * 5.1 + ph2) * 0.3) + jit(x, salt) * 9
      }
      let lo = min(x0, x1), hi = max(x0, x1), leadX = x1, sgn: CGFloat = ltr ? 1 : -1
      var xs: [CGFloat] = []; var x = lo; while x < hi { xs.append(x); x += step }; xs.append(hi)
      var pts: [CGPoint] = xs.map { CGPoint(x: $0, y: wavy($0, top, 0)) }
      let leadPts = (0...16).map { k -> CGPoint in   // ragged eraser edge, top to bottom
        let y = top - (top - bot) * CGFloat(k) / 16
        return CGPoint(x: leadX + sgn * (jit(CGFloat(k) * step, 3) * 30 + sin(Double(k) * 0.9 + ph) * 8), y: y)
      }
      // top edge lo→hi, right side down, bottom edge hi→lo, left side up. The eraser is on the
      // right side going left to right, on the left side coming back.
      if ltr { pts += leadPts }
      pts += xs.reversed().map { CGPoint(x: $0, y: wavy($0, bot, 5)) }
      if !ltr { pts += leadPts.reversed() }
      path.addLines(between: pts); path.closeSubpath()
      if p < 1 || i == rows - 1 { lead = CGPoint(x: x1, y: (top + bot) / 2) }
    }
    CATransaction.begin(); CATransaction.setDisableActions(true)
    mask.path = path
    if hand {
      if let l = lead, t < coverTime {
        handLayer.position = CGPoint(x: l.x, y: l.y + CGFloat(sin(t * 18)) * 10)
        handLayer.setAffineTransform(CGAffineTransform(rotationAngle: CGFloat(sin(t * 9)) * 0.06))
      } else if t >= coverTime {   // carry on off the bottom corner where the last stroke ended
        let k = CGFloat(min(1, (t - coverTime) / 0.6)), right = (rows - 1) % 2 == 0
        handLayer.position = CGPoint(x: right ? W + 60 + k * 300 : -60 - k * 300, y: rowH * 0.5 - k * (rowH * 2))
      }
    }
    CATransaction.commit()
  }
}

final class Delegate: NSObject, NSApplicationDelegate {
  var boards: [Board] = []
  var start = Date(), done = false, dismissed = false, textShownAt: Date? = nil, fadingSince: Date? = nil
  var tick: Timer?
  func applicationDidFinishLaunching(_ n: Notification) {
    boards = NSScreen.screens.map(Board.init)
    if snapshotOut != nil { return renderFrames() }
    for b in boards { b.window.orderFrontRegardless() }
    NSApp.activate(ignoringOtherApps: true)
    boards.first?.window.makeKey()
    NSEvent.addLocalMonitorForEvents(matching: [.keyDown, .leftMouseDown, .rightMouseDown]) { [weak self] _ in self?.dismissed = true; return nil }
    // slatewipe holds our stdin open for as long as the wipe runs; EOF (or "done") means it finished.
    DispatchQueue.global().async { [weak self] in
      while let line = readLine() { if line.trimmingCharacters(in: .whitespaces) == "done" { break } }
      DispatchQueue.main.async { self?.done = true }
    }
    start = Date()
    tick = Timer.scheduledTimer(withTimeInterval: 1.0 / 60, repeats: true) { [weak self] _ in self?.frame() }
    RunLoop.main.add(tick!, forMode: .common)
  }

  // dev: `--snapshot out.png` renders one frame (time from $SLATE_ANIM_T, default: covered, text up),
  // `--snapshot dir/` renders the whole thing at 30 fps as dir/0000.png… Nothing appears on screen.
  func renderFrames() {
    let out = snapshotOut!, b = boards.first!, root = b.window.contentView!.layer!
    let sc: CGFloat = out.hasSuffix("/") ? 0.5 : b.window.backingScaleFactor
    func shot(_ t: Double, _ file: String) {
      b.draw(t)
      let tt = t - coverTime - textDelay
      b.text.opacity = Float(max(0, min(1, tt / textFade)))
      let ctx = CGContext(data: nil, width: Int(b.frame.width * sc), height: Int(b.frame.height * sc), bitsPerComponent: 8, bytesPerRow: 0,
                          space: CGColorSpaceCreateDeviceRGB(), bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)!
      ctx.scaleBy(x: sc, y: sc)
      ctx.setFillColor(gray: 0.86, alpha: 1); ctx.fill(CGRect(origin: .zero, size: b.frame.size))   // stand-in desktop
      root.render(in: ctx)
      try? NSBitmapImageRep(cgImage: ctx.makeImage()!).representation(using: .png, properties: [:])?.write(to: URL(fileURLWithPath: file))
    }
    if out.hasSuffix("/") {
      let end = coverTime + textDelay + textFade + minHold
      for (i, t) in stride(from: 0.0, through: end, by: 1.0 / 30).enumerated() { shot(t, out + String(format: "%04d.png", i)) }
    } else {
      shot(Double(ProcessInfo.processInfo.environment["SLATE_ANIM_T"] ?? "") ?? coverTime + 2, out)
    }
    exit(0)
  }

  func frame() {
    let t = Date().timeIntervalSince(start)
    for b in boards { b.draw(t) }
    if textShownAt == nil, t >= coverTime + textDelay {
      textShownAt = Date()
      for b in boards {
        let a = CABasicAnimation(keyPath: "opacity"); a.fromValue = 0; a.toValue = 1; a.duration = textFade
        let s = CABasicAnimation(keyPath: "transform.scale"); s.fromValue = 0.94; s.toValue = 1; s.duration = textFade * 1.4
        s.timingFunction = CAMediaTimingFunction(name: .easeOut)
        b.text.opacity = 1; b.text.add(a, forKey: "in"); b.text.add(s, forKey: "grow")
      }
    }
    let held = textShownAt.map { Date().timeIntervalSince($0) } ?? 0
    if fadingSince == nil, dismissed || (done && held >= minHold) || held >= maxHold { fadingSince = Date() }
    if let f = fadingSince {   // fade by hand each frame (animator() completions don't fire reliably here)
      let k = Date().timeIntervalSince(f) / fadeOut
      if k >= 1 { exit(0) }
      for b in boards { b.window.alphaValue = CGFloat(1 - k * k) }
    }
  }
}

let app = NSApplication.shared
app.setActivationPolicy(.accessory)
let delegate = Delegate()
app.delegate = delegate
app.run()
