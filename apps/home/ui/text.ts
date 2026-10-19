// apps/home/ui/text.ts — text that fits: ASCII folding for runtime strings,
// measured ellipsis and greedy word wrap.
//
// The 3DS bakes its glyph atlases at build time from the characters in the
// bundle plus printable ASCII. Strings that arrive at run time (SSIDs, Mac
// names, Hacker News titles) can hold anything, so they are folded to ASCII
// before they reach a <Text>. The text engine breaks lines only on "\n" and
// paints past its box, so every runtime string is either ellipsized or
// wrapped against a measured width here.

import { getOps } from "@pocketjs/framework/host";

/** Baked font slots (framework/compiler/tailwind.ts fontSlotFor): FONT_PX
 *  index, bold +7. Literals: compiler source stays out of the app graph. */
export const FONT = {
  xs: 0,
  sm: 1,
  base: 2,
  lg: 3,
  xl: 4,
  xxl: 5,
  xsBold: 7,
  smBold: 8,
  baseBold: 9,
  lgBold: 10,
  xlBold: 11,
  xxlBold: 12,
} as const;

// Keys are code points, not string literals: every literal in the bundle is
// baked into every font atlas, and these characters are never drawn.
const FOLD = new Map<number, string>([
  [0x00a0, " "], [0x2002, " "], [0x2003, " "], [0x2009, " "], [0x200b, ""], [0x2018, "'"],
  [0x2019, "'"], [0x201a, "'"], [0x201b, "'"], [0x2032, "'"], [0x00b4, "'"], [0x201c, "\""],
  [0x201d, "\""], [0x201e, "\""], [0x201f, "\""], [0x2033, "\""], [0x00ab, "\""], [0x00bb, "\""],
  [0x2010, "-"], [0x2011, "-"], [0x2012, "-"], [0x2013, "-"], [0x2014, "-"], [0x2015, "-"],
  [0x2212, "-"], [0x2026, "..."], [0x2022, "*"], [0x00b7, "-"], [0x00d7, "x"], [0x2192, "->"],
  [0x2190, "<-"], [0x00a9, "(c)"], [0x00ae, "(R)"], [0x2122, "(TM)"], [0x00b0, " deg"], [0x20ac, "EUR"],
  [0x00a3, "GBP"], [0x00df, "ss"], [0x00e6, "ae"], [0x00c6, "AE"], [0x0153, "oe"], [0x0152, "OE"],
  [0x00f8, "o"], [0x00d8, "O"], [0x0142, "l"], [0x0141, "L"], [0x0111, "d"], [0x0110, "D"],
  [0x00fe, "th"], [0x00f0, "d"],
]);

/** Fold a runtime string to printable ASCII: punctuation to its ASCII
 *  spelling, accented Latin to its base letter, anything else to "?". */
export function toAscii(text: string): string {
  let out = "";
  let decomposed = text;
  try {
    decomposed = text.normalize("NFD");
  } catch {
    // A runtime without normalization still folds through the table.
  }
  for (const ch of decomposed) {
    const code = ch.codePointAt(0)!;
    if (code >= 0x20 && code < 0x7f) out += ch;
    else if (code === 0x0a) out += "\n";
    else if (code === 0x09) out += " ";
    else if (code >= 0x0300 && code <= 0x036f) continue; // combining accent
    else if (FOLD.has(code)) out += FOLD.get(code);
    else if (code >= 0xfe00 && code <= 0xfe0f) continue; // variation selector
    else out += "?";
  }
  return out;
}

const widths = new Map<string, number>();

/** Width of one line of text in a font slot, as layout measures it. */
export function measure(text: string, slot: number): number {
  if (text === "") return 0;
  const key = `${slot}|${text}`;
  let width = widths.get(key);
  if (width === undefined) {
    width = getOps().measureText(text, slot);
    if (widths.size > 4096) widths.clear();
    widths.set(key, width);
  }
  return width;
}

const ELLIPSIS = "...";

/** The longest prefix that fits maxW, with "..." when it was cut. */
export function ellipsize(text: string, slot: number, maxW: number): string {
  if (measure(text, slot) <= maxW) return text;
  const room = maxW - measure(ELLIPSIS, slot);
  let low = 0;
  let high = text.length;
  while (low < high) {
    const mid = (low + high + 1) >> 1;
    if (measure(text.slice(0, mid), slot) <= room) low = mid;
    else high = mid - 1;
  }
  return text.slice(0, low).trimEnd() + ELLIPSIS;
}

/** A line that was cut short: the longest prefix that still fits with "...". */
function cut(text: string, slot: number, maxW: number): string {
  const room = maxW - measure(ELLIPSIS, slot);
  let end = text.length;
  while (end > 0 && measure(text.slice(0, end), slot) > room) end--;
  return text.slice(0, end).trimEnd() + ELLIPSIS;
}

/** Greedy word wrap into lines no wider than maxW. Paragraph breaks ("\n")
 *  are kept; a word wider than the line is split. With maxLines, the last
 *  kept line ends in "..." when text was dropped. */
export function wrap(text: string, slot: number, maxW: number, maxLines = Infinity): string[] {
  const lines: string[] = [];
  const space = measure(" ", slot);
  for (const paragraph of text.split("\n")) {
    if (lines.length >= maxLines) break;
    if (paragraph.trim() === "") {
      lines.push("");
      continue;
    }
    let line = "";
    let lineW = 0;
    for (const word of paragraph.split(" ")) {
      if (word === "") continue;
      let wordW = measure(word, slot);
      let rest = word;
      if (wordW > maxW) {
        // A token wider than the line (a URL): break it by characters.
        if (line !== "") {
          lines.push(line);
          line = "";
          lineW = 0;
        }
        while (measure(rest, slot) > maxW) {
          let cut = 1;
          while (cut < rest.length && measure(rest.slice(0, cut + 1), slot) <= maxW) cut++;
          lines.push(rest.slice(0, cut));
          rest = rest.slice(cut);
        }
        wordW = measure(rest, slot);
      }
      if (line === "") {
        line = rest;
        lineW = wordW;
      } else if (lineW + space + wordW <= maxW) {
        line += " " + rest;
        lineW += space + wordW;
      } else {
        lines.push(line);
        line = rest;
        lineW = wordW;
      }
    }
    if (line !== "") lines.push(line);
  }
  while (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
  if (lines.length > maxLines) {
    const kept = lines.slice(0, maxLines);
    kept[maxLines - 1] = cut(kept[maxLines - 1]!, slot, maxW);
    return kept;
  }
  return lines;
}
