// tools/font-subset.ts — cut a face down to the glyphs an app actually
// spells, so an icon font can travel with the app instead of the 2.5 MB it
// ships as.
//
//   bun tools/font-subset.ts <source.ttf> <out.otf> --name="Symbols Nerd Font Subset" \
//     --scan=apps/foo/menu.ts --scan=apps/foo/glyphs.ts [--range=E000-F8FF,F0000-FFFFD] [--chars=...]
//
// Codepoints come from the scanned files (every character inside the ranges,
// which default to the two private-use areas icon fonts live in) plus any
// --chars. The result is written through opentype.js, so it is a CFF-flavoured
// OpenType face; framework/compiler/bake-font.ts reads it like any other and
// tools/build.ts picks it up from an app's fonts.json.

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { Font, Glyph, parse as parseFont, Path } from "opentype.js";

const args = process.argv.slice(2);
const positional = args.filter((a) => !a.startsWith("--"));
const flag = (name: string): string[] =>
  args.filter((a) => a.startsWith(`--${name}=`)).map((a) => a.slice(name.length + 3));

const [source, output] = positional;
if (!source || !output) {
  console.error("usage: bun tools/font-subset.ts <source.ttf> <out.otf> --name=<family> --scan=<file> [--scan=...] [--range=A-B,...] [--chars=...]");
  process.exit(2);
}
if (!existsSync(source)) {
  console.error(`font-subset: ${source} not found`);
  process.exit(2);
}

const family = flag("name")[0] ?? "Subset";
const ranges: [number, number][] = (flag("range")[0] ?? "E000-F8FF,F0000-FFFFD").split(",").map((r) => {
  const [lo, hi] = r.split("-");
  return [parseInt(lo!, 16), parseInt(hi ?? lo!, 16)];
});
const inRange = (cp: number): boolean => ranges.some(([lo, hi]) => cp >= lo && cp <= hi);

const wanted = new Set<number>();
for (const file of flag("scan")) {
  for (const ch of readFileSync(file, "utf8")) {
    const cp = ch.codePointAt(0)!;
    if (inRange(cp)) wanted.add(cp);
  }
}
for (const list of flag("chars")) for (const ch of list) wanted.add(ch.codePointAt(0)!);

/** A copy of `path` moved along x (font units); every command's x fields. */
function shiftPath(path: Path, dx: number): Path {
  const moved = new Path();
  moved.unitsPerEm = path.unitsPerEm;
  moved.commands = path.commands.map((command) => {
    const next = { ...command } as Record<string, unknown>;
    for (const key of ["x", "x1", "x2"]) {
      if (typeof next[key] === "number") next[key] = (next[key] as number) + dx;
    }
    return next as typeof command;
  });
  return moved;
}

const font = parseFont(readFileSync(source).buffer as ArrayBuffer);
const glyphs: Glyph[] = [new Glyph({ name: ".notdef", unicode: undefined as unknown as number, advanceWidth: font.unitsPerEm / 2, path: new Path() })];
const missing: number[] = [];
for (const cp of [...wanted].sort((a, b) => a - b)) {
  const index = font.charToGlyphIndex(String.fromCodePoint(cp));
  if (index <= 0) {
    missing.push(cp);
    continue;
  }
  const glyph = font.glyphs.get(index);
  // Advances are normalised to the ink: a MONOSPACED Nerd Font patch gives
  // every glyph one cell of advance, but draws the double-width icons across
  // two, so the ink overflows to the right of the box a text layout measures
  // — an icon centred in its button looked pushed right. Shifting each path
  // to x = 0 and setting the advance to the ink's own width makes a
  // single-glyph run measure exactly its ink, so centring is exact.
  const bounds = glyph.path.getBoundingBox();
  const shift = -bounds.x1;
  const width = Math.max(1, Math.round(bounds.x2 - bounds.x1));
  glyphs.push(
    new Glyph({
      name: `uni${cp.toString(16).toUpperCase().padStart(4, "0")}`,
      unicode: cp,
      advanceWidth: width,
      path: shiftPath(glyph.path, shift),
    }),
  );
}

const subset = new Font({
  familyName: family,
  styleName: "Regular",
  unitsPerEm: font.unitsPerEm,
  ascender: font.ascender,
  descender: font.descender,
  glyphs,
});
const bytes = new Uint8Array(subset.toArrayBuffer());
writeFileSync(output, bytes);
console.log(`${output}: ${glyphs.length - 1} glyph(s) from ${wanted.size} codepoint(s), ${(bytes.byteLength / 1024).toFixed(1)} KiB`);
if (missing.length) {
  console.log(`  not in ${source}: ${missing.map((cp) => `U+${cp.toString(16).toUpperCase()}`).join(" ")}`);
}
