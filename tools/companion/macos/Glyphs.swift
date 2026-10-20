// pocket-glyphs — the console agent's glyphs, rasterized with CoreText.
//
//   pocket-glyphs <pixel size> <cell width> <cell height> <baseline>
//
// stdin   one request per line: codepoints as decimal numbers, comma-separated
// stdout  one JSON line per request:
//         {"glyphs":[{"cp":N,"advance":A,"xoff":X,"coverage":"<base64>"}, …]}
//         coverage is cellW x cellH alpha bytes, top row first, the baseline
//         `baseline` px below the cell's top. A codepoint no font can draw is
//         left out (the atlas maps it to its tofu box).
//
// The face is PingFang SC; a codepoint it lacks takes the font CoreText's
// cascade picks for it. Antialiased, no font smoothing: plain coverage.

import CoreGraphics
import CoreText
import Foundation

let arguments = CommandLine.arguments
guard arguments.count == 5,
      let size = Double(arguments[1]),
      let cellW = Int(arguments[2]),
      let cellH = Int(arguments[3]),
      let baseline = Int(arguments[4]),
      cellW > 0, cellH > 0, cellW <= 255, cellH <= 255 else {
  FileHandle.standardError.write("usage: pocket-glyphs <pixel size> <cell width> <cell height> <baseline>\n".data(using: .utf8)!)
  exit(2)
}

let base = CTFontCreateWithName("PingFangSC-Regular" as CFString, CGFloat(size), nil)
let gray = CGColorSpaceCreateDeviceGray()

func glyph(_ codepoint: UInt32) -> [String: Any]? {
  guard let scalar = Unicode.Scalar(codepoint) else { return nil }
  let string = String(Character(scalar))
  let utf16 = Array(string.utf16)
  // The cascade: the base face when it has the glyph, else CoreText's pick.
  var font = base
  var glyphs = [CGGlyph](repeating: 0, count: utf16.count)
  if !CTFontGetGlyphsForCharacters(font, utf16, &glyphs, utf16.count) || glyphs[0] == 0 {
    font = CTFontCreateForString(base, string as CFString, CFRange(location: 0, length: utf16.count))
    glyphs = [CGGlyph](repeating: 0, count: utf16.count)
    guard CTFontGetGlyphsForCharacters(font, utf16, &glyphs, utf16.count), glyphs[0] != 0 else { return nil }
  }
  var glyph = glyphs[0]
  var advance = CGSize.zero
  CTFontGetAdvancesForGlyphs(font, .horizontal, &glyph, &advance, 1)
  var bounds = CGRect.zero
  CTFontGetBoundingRectsForGlyphs(font, .horizontal, &glyph, &bounds, 1)
  // Ink left of the pen moves right into the cell; the renderer draws the
  // cell xoff px left of the pen.
  let xoff = bounds.minX < 0 ? Int(ceil(-bounds.minX)) : 0
  var pixels = [UInt8](repeating: 0, count: cellW * cellH)
  pixels.withUnsafeMutableBytes { raw in
    guard let context = CGContext(
      data: raw.baseAddress, width: cellW, height: cellH, bitsPerComponent: 8, bytesPerRow: cellW,
      space: gray, bitmapInfo: CGImageAlphaInfo.none.rawValue
    ) else { return }
    context.setAllowsAntialiasing(true)
    context.setShouldAntialias(true)
    context.setAllowsFontSmoothing(false)
    context.setShouldSmoothFonts(false)
    context.setFillColor(gray: 1, alpha: 1)
    // CoreGraphics' origin is the bottom-left; the baseline sits `baseline`
    // px below the top. The bitmap's first row in memory is the top row.
    var position = CGPoint(x: CGFloat(xoff), y: CGFloat(cellH - baseline))
    CTFontDrawGlyphs(font, &glyph, &position, 1, context)
  }
  let advancePx = min(cellW, max(0, Int(advance.width.rounded())))
  return ["cp": codepoint, "advance": advancePx, "xoff": min(xoff, 255), "coverage": Data(pixels).base64EncodedString()]
}

while let line = readLine() {
  var out: [[String: Any]] = []
  for field in line.split(separator: ",") {
    guard let codepoint = UInt32(field.trimmingCharacters(in: .whitespaces)) else { continue }
    if let entry = glyph(codepoint) { out.append(entry) }
  }
  let data = try! JSONSerialization.data(withJSONObject: ["glyphs": out])
  FileHandle.standardOutput.write(data)
  FileHandle.standardOutput.write("\n".data(using: .utf8)!)
}
