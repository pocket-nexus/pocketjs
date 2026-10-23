// pocket-glyphs — the console agent's glyphs, rasterized with CoreText.
//
//   pocket-glyphs <pixel size> <cell width> <cell height> <baseline> [bold]
//
// stdin   one request per line: codepoints as decimal numbers, comma-separated
// stdout  one JSON line per request:
//         {"glyphs":[{"cp":N,"advance":A,"xoff":X,"coverage":"<base64>"}, …]}
//         coverage is cellW x cellH alpha bytes, top row first, the baseline
//         `baseline` px below the cell's top. A codepoint no font can draw is
//         left out (the atlas maps it to its tofu box).
//
// The face is PingFang SC (Semibold with `bold`); a codepoint it lacks takes
// the font CoreText's cascade picks for it. Antialiased, no font smoothing:
// plain coverage. A color glyph (an emoji) draws in gray, its light parts
// dense and its dark parts thin, so it reads as a one-colour picture.

import CoreGraphics
import CoreText
import Foundation

let arguments = CommandLine.arguments
guard arguments.count == 5 || (arguments.count == 6 && arguments[5] == "bold"),
      let size = Double(arguments[1]),
      let cellW = Int(arguments[2]),
      let cellH = Int(arguments[3]),
      let baseline = Int(arguments[4]),
      cellW > 0, cellH > 0, cellW <= 255, cellH <= 255 else {
  FileHandle.standardError.write("usage: pocket-glyphs <pixel size> <cell width> <cell height> <baseline> [bold]\n".data(using: .utf8)!)
  exit(2)
}

let bold = arguments.count == 6
let base = CTFontCreateWithName((bold ? "PingFangSC-Semibold" : "PingFangSC-Regular") as CFString, CGFloat(size), nil)
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
  // An emoji draws a little smaller than the text, its foot on the baseline.
  let color = CTFontGetSymbolicTraits(font).contains(.traitColorGlyphs)
  if color { font = CTFontCreateCopyWithAttributes(font, CGFloat(size) * 0.82, nil, nil) }
  var glyph = glyphs[0]
  var advance = CGSize.zero
  CTFontGetAdvancesForGlyphs(font, .horizontal, &glyph, &advance, 1)
  var bounds = CGRect.zero
  CTFontGetBoundingRectsForGlyphs(font, .horizontal, &glyph, &bounds, 1)
  // Ink left of the pen moves right into the cell; the renderer draws the
  // cell xoff px left of the pen.
  let xoff = bounds.minX < 0 ? Int(ceil(-bounds.minX)) : 0
  var pixels = [UInt8](repeating: 0, count: cellW * cellH)
  if color {
    pixels = colorCoverage(font, glyph, CGPoint(x: CGFloat(xoff), y: CGFloat(cellH - baseline)))
  } else {
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
  }
  let advancePx = min(cellW, max(0, Int(advance.width.rounded())))
  return ["cp": codepoint, "advance": advancePx, "xoff": min(xoff, 255), "coverage": Data(pixels).base64EncodedString()]
}

/// A color glyph as coverage: drawn in RGBA, each pixel's coverage its alpha
/// scaled by how light it is, so a yellow face is solid and its dark eyes
/// and mouth are holes the text colour does not fill.
func colorCoverage(_ font: CTFont, _ glyph: CGGlyph, _ origin: CGPoint) -> [UInt8] {
  var rgba = [UInt8](repeating: 0, count: cellW * cellH * 4)
  rgba.withUnsafeMutableBytes { raw in
    guard let context = CGContext(
      data: raw.baseAddress, width: cellW, height: cellH, bitsPerComponent: 8, bytesPerRow: cellW * 4,
      space: CGColorSpaceCreateDeviceRGB(), bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue
    ) else { return }
    var glyph = glyph
    var position = origin
    CTFontDrawGlyphs(font, &glyph, &position, 1, context)
  }
  var out = [UInt8](repeating: 0, count: cellW * cellH)
  for i in 0..<(cellW * cellH) {
    let a = Double(rgba[i * 4 + 3]) / 255
    if a <= 0 { continue }
    // Un-premultiply, then Rec. 601 lightness.
    let r = Double(rgba[i * 4]) / 255 / a, g = Double(rgba[i * 4 + 1]) / 255 / a, b = Double(rgba[i * 4 + 2]) / 255 / a
    let light = 0.299 * r + 0.587 * g + 0.114 * b
    let keep = min(1, max(0, (light - 0.3) / 0.35))
    out[i] = UInt8(min(255, max(0, (a * keep * 255).rounded())))
  }
  return out
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
