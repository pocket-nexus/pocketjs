// Text that fits the panel. The glyph atlases hold the bundle's literals and
// printable ASCII, so strings that arrive at run time (console names, server
// names, error messages) are folded to ASCII before they reach a <Text>.
// The text engine breaks lines only at "\n", so paragraphs are wrapped here
// against a measured width.

import { getOps } from "@pocketjs/framework/host";

/** Baked font slots (framework/compiler/tailwind.ts fontSlotFor). */
export const SLOT = { xs: 0, sm: 1, xsBold: 7, smBold: 8, tiny: 19, tinyBold: 20 } as const;
export type Slot = (typeof SLOT)[keyof typeof SLOT];

const PUNCTUATION: Record<number, string> = {
  0x2018: "'", 0x2019: "'", 0x201c: '"', 0x201d: '"', 0x2013: "-", 0x2014: "-",
  0x2026: "...", 0x2022: "*", 0x00b7: "-", 0x00a0: " ", 0x2192: "->", 0x00d7: "x",
};

/** Printable ASCII: accents dropped, common punctuation spelled out, any
 *  other character as "?". */
export function toAscii(text: string): string {
  let decomposed = text;
  try {
    decomposed = text.normalize("NFD");
  } catch {
    // A runtime without normalization folds through the table only.
  }
  let out = "";
  for (const ch of decomposed) {
    const code = ch.codePointAt(0)!;
    if (code >= 0x20 && code < 0x7f) out += ch;
    else if (code === 0x0a) out += "\n";
    else if (code >= 0x300 && code < 0x370) continue;
    else out += PUNCTUATION[code] ?? "?";
  }
  return out;
}

export const measure = (text: string, slot: Slot): number => getOps().measureText(text, slot);

/** Greedy word wrap of `text` (with its own "\n" breaks) to `width` px. */
export function wrap(text: string, slot: Slot, width: number): string[] {
  const lines: string[] = [];
  for (const paragraph of text.split("\n")) {
    const breaks = getOps().wrapText?.(paragraph, slot, width);
    if (breaks) {
      let from = 0;
      for (const at of breaks) {
        lines.push(paragraph.slice(from, at).trimEnd());
        from = at;
        while (paragraph[from] === " ") from++;
      }
      lines.push(paragraph.slice(from));
      continue;
    }
    let line = "";
    for (const word of paragraph.split(" ")) {
      const next = line ? `${line} ${word}` : word;
      if (!line || measure(next, slot) <= width) line = next;
      else {
        lines.push(line);
        line = word;
      }
    }
    lines.push(line);
  }
  return lines;
}

/** `text` cut to `width` px with "..." when it is wider. */
export function ellipsize(text: string, slot: Slot, width: number): string {
  if (measure(text, slot) <= width) return text;
  let end = text.length;
  while (end > 0 && measure(`${text.slice(0, end)}...`, slot) > width) end--;
  return `${text.slice(0, end).trimEnd()}...`;
}

/** A byte count as the Mac's file sizes read: 590 KB, 1.2 MB. */
export function bytes(n: number): string {
  if (n < 1000) return `${n} bytes`;
  if (n < 1_000_000) return `${Math.round(n / 1000)} KB`;
  return `${(n / 1_000_000).toFixed(1)} MB`;
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** 21:49 today, else 24 Oct 21:49. */
export function when(ms: number, now = Date.now()): string {
  const date = new Date(ms);
  const time = `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
  const today = new Date(now);
  if (date.toDateString() === today.toDateString()) return time;
  return `${date.getDate()} ${MONTHS[date.getMonth()]} ${time}`;
}
