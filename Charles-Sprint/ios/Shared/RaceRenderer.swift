import SwiftUI

/// Draws one frame of the river in the web game's black-and-white line style.
struct RaceRenderer {
    let engine: RaceEngine
    let size: CGSize

    private var w: CGFloat { size.width }
    private var h: CGFloat { size.height }
    private var boatY: CGFloat { h * 0.68 }

    func river(_ m: Double) -> (x: CGFloat, half: CGFloat) {
        (w / 2 + CGFloat(sin(m / 70)) * w * 0.07 + CGFloat(sin(m / 23)) * 6, min(w * 0.36, 190))
    }

    func screenY(_ m: Double) -> CGFloat {
        boatY - CGFloat(m - engine.dist) * Course.px
    }

    func draw(in context: inout GraphicsContext) {
        context.fill(Path(CGRect(origin: .zero, size: size)), with: .color(.white))
        drawRiver(&context)
        drawLines(&context)
        drawPuddles(&context)
        drawBoat(&context)
        for bridge in Course.bridges { drawBridge(bridge, &context) }
    }

    // MARK: River and banks

    private func drawRiver(_ ctx: inout GraphicsContext) {
        let top = engine.dist + Double(boatY / Course.px) + 10
        let bottom = engine.dist - Double((h - boatY) / Course.px) - 10
        var left: [CGPoint] = [], right: [CGPoint] = []
        var m = bottom
        while m <= top {
            let r = river(m), y = screenY(m)
            left.append(CGPoint(x: r.x - r.half, y: y))
            right.append(CGPoint(x: r.x + r.half, y: y))
            m += 3
        }

        // Hatched land on both sides, anchored to the ground so it scrolls with the river.
        var banks = Path()
        banks.move(to: CGPoint(x: 0, y: h))
        left.forEach { banks.addLine(to: $0) }
        banks.addLine(to: CGPoint(x: 0, y: -10))
        banks.closeSubpath()
        banks.move(to: CGPoint(x: w, y: h))
        right.forEach { banks.addLine(to: $0) }
        banks.addLine(to: CGPoint(x: w, y: -10))
        banks.closeSubpath()
        var hatch = Path()
        var c = (CGFloat(engine.dist) * Course.px).truncatingRemainder(dividingBy: 12) - 24
        while c < w + h + 40 {
            hatch.move(to: CGPoint(x: c + 20, y: -20))
            hatch.addLine(to: CGPoint(x: c - h - 20, y: h + 20))
            c += 12
        }
        var land = ctx
        land.clip(to: banks)
        land.stroke(hatch, with: .color(.black), lineWidth: 1.6)

        // White embankment strip, then a heavy bank line and a thin outer line.
        for (points, side) in [(left, CGFloat(-1)), (right, CGFloat(1))] {
            ctx.stroke(polyline(points, dx: side * 8), with: .color(.white), lineWidth: 16)
            ctx.stroke(polyline(points, dx: 0), with: .color(.black), lineWidth: 4)
            ctx.stroke(polyline(points, dx: side * 16), with: .color(.black), lineWidth: 2)
        }

        // Ripples fixed to the water.
        var ripples = Path()
        var rm = (bottom / 7).rounded(.down) * 7
        while rm < top {
            let r = river(rm)
            let seed = sin(rm * 12.9898) * 43758.5453
            let f = CGFloat(seed - seed.rounded(.down))
            let x = r.x - r.half + 24 + f * (r.half * 2 - 48), y = screenY(rm)
            ripples.move(to: CGPoint(x: x, y: y))
            ripples.addLine(to: CGPoint(x: x + 8 + f * 14, y: y))
            rm += 7
        }
        ctx.stroke(ripples, with: .color(.black), style: StrokeStyle(lineWidth: 2, lineCap: .round))

        // Meter marks on the bank.
        for mark in stride(from: 100, to: Int(Course.length), by: 100) {
            let y = screenY(Double(mark))
            guard y > -20, y < h + 20 else { continue }
            let r = river(Double(mark))
            ctx.fill(Path(CGRect(x: r.x + r.half - 14, y: y - 1.5, width: 14, height: 3)), with: .color(.black))
            labelBox("\(mark) M", x: r.x + r.half + 22, y: y, size: 11, &ctx)
        }
    }

    // MARK: Start and finish

    private func drawLines(_ ctx: inout GraphicsContext) {
        let s = screenY(0), rs = river(0)
        if s > -10, s < h + 10 {
            for d: CGFloat in [0, 7] {
                var line = Path()
                line.move(to: CGPoint(x: rs.x - rs.half, y: s + d))
                line.addLine(to: CGPoint(x: rs.x + rs.half, y: s + d))
                ctx.stroke(line, with: .color(.black), lineWidth: 3)
            }
        }
        let f = screenY(Course.length), rf = river(Course.length)
        if f > -30, f < h + 30 {
            let cell: CGFloat = 12
            let n = Int((rf.half * 2 / cell).rounded(.up))
            for i in 0..<n {
                for j in 0..<2 {
                    let rect = CGRect(x: rf.x - rf.half + CGFloat(i) * cell, y: f - cell * CGFloat(j + 1), width: cell, height: cell)
                    ctx.fill(Path(rect), with: .color((i + j) % 2 == 1 ? .white : .black))
                }
            }
            ctx.stroke(Path(CGRect(x: rf.x - rf.half, y: f - cell * 2, width: rf.half * 2, height: cell * 2)), with: .color(.black), lineWidth: 3)
            labelBox("FINISH", x: rf.x - rf.half - 64, y: f - cell, size: 13, &ctx)
        }
    }

    // MARK: Bridges

    private func drawBridge(_ bridge: Course.Bridge, _ ctx: inout GraphicsContext) {
        let y = screenY(bridge.at)
        guard y > -80, y < h + 80 else { return }
        let r = river(bridge.at), deck: CGFloat = 34
        let x0 = r.x - r.half - 30, x1 = r.x + r.half + 30
        let deckRect = CGRect(x: x0, y: y - deck, width: x1 - x0, height: deck)
        ctx.fill(Path(deckRect), with: .color(.black))
        // Three white arches cut out of the downstream face.
        var arches = ctx
        arches.clip(to: Path(deckRect))
        let span = r.half * 2 / 3
        for i in 0..<3 {
            let cx = r.x - r.half + span * (CGFloat(i) + 0.5)
            let rx = span * 0.38, ry = deck * 0.62
            arches.fill(Path(ellipseIn: CGRect(x: cx - rx, y: y - ry, width: rx * 2, height: ry * 2)), with: .color(.white))
        }
        var rail = Path()
        rail.move(to: CGPoint(x: x0, y: y - deck + 5))
        rail.addLine(to: CGPoint(x: x1, y: y - deck + 5))
        ctx.stroke(rail, with: .color(.white), lineWidth: 2)
        labelBox(bridge.name, centeredAt: r.x, y: y - deck - 16, size: 11, &ctx)
    }

    // MARK: Boat

    private func drawPuddles(_ ctx: inout GraphicsContext) {
        var rings = Path()
        for p in engine.puddles {
            let age = CGFloat(engine.clock - p.born)
            let x = river(p.strokeAt).x + p.side * 30, y = screenY(p.strokeAt - 6), radius = 2 + age * 6
            rings.addEllipse(in: CGRect(x: x - radius, y: y - radius, width: radius * 2, height: radius * 2))
        }
        ctx.stroke(rings, with: .color(.black), lineWidth: 2)
    }

    private func drawBoat(_ ctx: inout GraphicsContext) {
        let x = river(engine.dist).x, y = boatY, len: CGFloat = 18 * Course.px
        // Wake: two lines trailing back from the stern.
        let wake = min(1, CGFloat(engine.speed) / 9) * 90
        if wake > 4 {
            var p = Path()
            p.move(to: CGPoint(x: x - 3, y: y + len / 2))
            p.addLine(to: CGPoint(x: x - 3 - wake * 0.35, y: y + len / 2 + wake))
            p.move(to: CGPoint(x: x + 3, y: y + len / 2))
            p.addLine(to: CGPoint(x: x + 3 + wake * 0.35, y: y + len / 2 + wake))
            ctx.stroke(p, with: .color(.black), lineWidth: 2)
        }

        // Oars: the drive sweeps the blades toward the stern, the recovery brings them back.
        let t = engine.strokeAge, drive = 0.22, recover = 0.55
        let a: Double
        if t < drive { a = -0.75 + (t / drive) * 1.35 }
        else if t < drive + recover { a = 0.6 - ((t - drive) / recover) * 1.35 }
        else { a = -0.75 }
        let seat = (len - 26) / 7
        for i in 0..<8 {
            let side: CGFloat = i % 2 == 1 ? 1 : -1
            let oy = y - len / 2 + 14 + CGFloat(i) * seat
            let tip = CGPoint(x: x + side * 34 * CGFloat(cos(a * 0.6)), y: oy + 34 * CGFloat(sin(a)) * 0.55)
            var shaft = Path()
            shaft.move(to: CGPoint(x: x + side * 4, y: oy))
            shaft.addLine(to: tip)
            ctx.stroke(shaft, with: .color(.black), style: StrokeStyle(lineWidth: 2, lineCap: .round))
            var blade = ctx
            blade.translateBy(x: tip.x, y: tip.y)
            blade.rotate(by: .radians(atan2(Double(tip.y - oy), Double(tip.x - x))))
            blade.fill(Path(CGRect(x: -6, y: -2.5, width: 9, height: 5)), with: .color(.black))
        }

        // Hull: a white lens with a heavy outline; rowers and cox as black marks.
        var hull = Path()
        hull.move(to: CGPoint(x: x, y: y - len / 2))
        hull.addQuadCurve(to: CGPoint(x: x, y: y + len / 2), control: CGPoint(x: x + 9, y: y))
        hull.addQuadCurve(to: CGPoint(x: x, y: y - len / 2), control: CGPoint(x: x - 9, y: y))
        ctx.fill(hull, with: .color(.white))
        ctx.stroke(hull, with: .color(.black), lineWidth: 3)
        var crew = Path()
        for i in 0..<8 {
            let cy = y - len / 2 + 14 + CGFloat(i) * seat
            crew.addEllipse(in: CGRect(x: x - 2.6, y: cy - 2.6, width: 5.2, height: 5.2))
        }
        crew.addRect(CGRect(x: x - 3, y: y + len / 2 - 9, width: 6, height: 6))
        ctx.fill(crew, with: .color(.black))
    }

    // MARK: Helpers

    private func polyline(_ points: [CGPoint], dx: CGFloat) -> Path {
        var p = Path()
        for (i, pt) in points.enumerated() {
            let q = CGPoint(x: pt.x + dx, y: pt.y)
            if i == 0 { p.move(to: q) } else { p.addLine(to: q) }
        }
        return p
    }

    private func labelBox(_ text: String, x: CGFloat? = nil, centeredAt center: CGFloat? = nil, y: CGFloat, size: CGFloat, _ ctx: inout GraphicsContext) {
        let label = ctx.resolve(Text(text).font(Theme.bold(size)).foregroundColor(.black))
        let width = label.measure(in: CGSize(width: 1000, height: 100)).width + 10
        var left = x ?? ((center ?? 0) - width / 2)
        if left + width > w - 4 { left = w - 4 - width }
        let rect = CGRect(x: left, y: y - 9, width: width, height: 18)
        ctx.fill(Path(rect), with: .color(.white))
        ctx.stroke(Path(rect), with: .color(.black), lineWidth: 2)
        ctx.draw(label, at: CGPoint(x: left + 5, y: y), anchor: .leading)
    }
}
