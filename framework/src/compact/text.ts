// Text that fits a baked-glyph panel. The atlases hold the bundle's literals
// and printable ASCII, so a string that arrives at run time (a network name,
// an error) folds to ASCII before it reaches a <Text>. The text engine
// breaks lines at "\n" only, so paragraphs wrap here against a measured
// width.

import { getOps } from "../host.ts";
import type { Slot } from "./tokens.ts";

const PUNCTUATION: Record<number, string> = {
  0x2018: "'", 0x2019: "'", 0x201c: '"', 0x201d: '"', 0x2013: "-", 0x2014: "-",
  0x2026: "...", 0x2022: "*", 0x00b7: "-", 0x00a0: " ", 0x2192: "->", 0x00d7: "x",
  0x00b0: " deg", 0x00b5: "u",
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

/** The width of `text` in a font slot, in logical pixels. */
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

/** A byte count as a file size reads: 590 KB, 1.2 MB. */
export function bytes(n: number): string {
  if (n < 1000) return `${n} B`;
  if (n < 1_000_000) return `${Math.round(n / 1000)} KB`;
  if (n < 1_000_000_000) return `${(n / 1_000_000).toFixed(1)} MB`;
  return `${(n / 1_000_000_000).toFixed(1)} GB`;
}

/** Seconds as m:ss or h:mm:ss. */
export function clock(seconds: number): string {
  const whole = Math.max(0, Math.floor(seconds));
  const h = Math.floor(whole / 3600);
  const m = Math.floor((whole % 3600) / 60);
  const s = whole % 60;
  const mm = String(m).padStart(2, "0");
  const ss = String(s).padStart(2, "0");
  return h > 0 ? `${h}:${mm}:${ss}` : `${m}:${ss}`;
}

/** A number with a fixed number of decimals and an optional sign. */
export function fixed(value: number, decimals: number, signed = false): string {
  const text = Math.abs(value).toFixed(decimals);
  if (!signed) return value < 0 ? `-${text}` : text;
  return value < 0 ? `-${text}` : `+${text}`;
}

/** 21:49 today, else 24 Oct 21:49. */
export function when(ms: number, now = Date.now()): string {
  const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  const date = new Date(ms);
  const time = `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
  const today = new Date(now);
  if (date.toDateString() === today.toDateString()) return time;
  return `${date.getDate()} ${MONTHS[date.getMonth()]} ${time}`;
}
