// PocketUI core/text.ts — line breaking for text the core does not wrap.
//
// PocketJS's core draws a text run as given and breaks it only at "\n"
// (engine/core/src/text.rs), and reports no laid-out size to JavaScript. So
// a layout that has to know a paragraph's height before it paints breaks the
// lines itself: this module, over a `measure` function the host supplies
// (HostOps.measureText), with no other dependency.
//
// Tokens are a run of spaces, one wide character (CJK, kana, hangul, emoji:
// it may break on either side), or a run of anything else (a word). A line
// takes tokens while they fit; spaces at a line's end are not drawn and do
// not count; a word wider than the line is cut where it stops fitting.
// Closing punctuation never starts a line: it stays on the line it closes
// even when that overshoots by its own width.

export type Measure = (text: string) => number;

export interface Line {
  text: string;
  width: number;
  /** UTF-16 offsets into the source this line was cut from */
  start: number;
  end: number;
}

export interface WrapOptions {
  maxLines?: number;
  /** appended when the text is cut at maxLines */
  ellipsis?: string;
}

const CLOSING = new Set([
  0x2c, 0x2e, 0x21, 0x3f, 0x3a, 0x3b, 0x29, 0x5d, 0x7d, 0x3001, 0x3002, 0xff0c, 0xff0e, 0xff01, 0xff1f, 0xff1a, 0xff1b, 0xff09, 0x300b, 0x300d,
  0x300f, 0x3011, 0x3015, 0x201d, 0x2019, 0x2026, 0xff5d, 0x3009,
]);

/** A character that may break on either side. */
export function isWide(cp: number): boolean {
  return cp >= 0x2e80;
}

function isSpace(c: number): boolean {
  return c === 0x20 || c === 0x09 || c === 0xa0 || c === 0x3000;
}

interface Token {
  start: number;
  end: number;
  kind: 0 | 1 | 2; // word, space, wide
}

/** The tokens of one paragraph (no "\n" inside), read by index: iterators
 *  and /u regexes cost QuickJS on a 2006 handheld tens of milliseconds a post. */
function tokenize(text: string, from: number, to: number, out: Token[]): void {
  let at = from;
  while (at < to) {
    const c = text.charCodeAt(at);
    if (isSpace(c)) {
      let end = at + 1;
      while (end < to && isSpace(text.charCodeAt(end))) end++;
      out.push({ start: at, end, kind: 1 });
      at = end;
      continue;
    }
    const high = c >= 0xd800 && c <= 0xdbff && at + 1 < to;
    const cp = high ? (c - 0xd800) * 0x400 + (text.charCodeAt(at + 1) - 0xdc00) + 0x10000 : c;
    if (isWide(cp)) {
      out.push({ start: at, end: at + (high ? 2 : 1), kind: 2 });
      at += high ? 2 : 1;
      continue;
    }
    let end = at + 1;
    while (end < to) {
      const n = text.charCodeAt(end);
      if (isSpace(n) || n >= 0x2e80 || (n >= 0xd800 && n <= 0xdbff)) break;
      end++;
    }
    out.push({ start: at, end, kind: 0 });
    at = end;
  }
}

/** The longest prefix of text[from, to) that fits `width`, at least one character. */
function fitPrefix(text: string, from: number, to: number, width: number, measure: Measure): number {
  let lo = from + 1;
  let hi = to;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (measure(text.slice(from, mid)) <= width) lo = mid;
    else hi = mid - 1;
  }
  // never split a surrogate pair
  const c = text.charCodeAt(lo - 1);
  if (c >= 0xd800 && c <= 0xdbff && lo < to) lo++;
  return lo;
}

/** `text` as lines no wider than `maxWidth`. An infinite width breaks at "\n" only. */
export function wrapText(text: string, maxWidth: number, measure: Measure, options: WrapOptions = {}): Line[] {
  const maxLines = options.maxLines ?? Infinity;
  const lines: Line[] = [];
  const tokens: Token[] = [];
  let cut = false;
  let para = 0;
  while (para <= text.length && !cut) {
    let stop = text.indexOf("\n", para);
    if (stop < 0) stop = text.length;
    if (maxWidth === Infinity) {
      lines.push({ text: text.slice(para, stop), width: measure(text.slice(para, stop)), start: para, end: stop });
    } else {
      tokens.length = 0;
      tokenize(text, para, stop, tokens);
      let lineStart = para;
      let lineEnd = para; // end of the last drawn (non-space) token
      let width = 0; // width up to lineEnd
      let pending = 0; // width of spaces after lineEnd
      const flush = (nextStart: number) => {
        lines.push({ text: text.slice(lineStart, lineEnd), width, start: lineStart, end: lineEnd });
        lineStart = nextStart;
        lineEnd = nextStart;
        width = 0;
        pending = 0;
      };
      for (let i = 0; i < tokens.length; i++) {
        const token = tokens[i]!;
        if (token.kind === 1) {
          if (lineEnd === lineStart && lines.length > 0 && lineStart !== para) {
            // spaces that would open a wrapped line are swallowed
            lineStart = token.end;
            lineEnd = token.end;
          } else pending += measure(text.slice(token.start, token.end));
          continue;
        }
        let piece = text.slice(token.start, token.end);
        let w = measure(piece);
        const first = lineEnd === lineStart;
        const hangs = token.kind !== 0 ? CLOSING.has(piece.codePointAt(0)!) : false;
        if (!first && width + pending + w > maxWidth && !hangs) {
          flush(token.start);
          if (lines.length >= maxLines) {
            cut = true;
            break;
          }
        }
        // a word wider than a whole line is cut where it stops fitting
        let from = token.start;
        while (w > maxWidth && token.end - from > 1) {
          const at = fitPrefix(text, from, token.end, maxWidth, measure);
          if (at >= token.end) break;
          lineStart = from;
          lineEnd = at;
          width = measure(text.slice(from, at));
          flush(at);
          if (lines.length >= maxLines) {
            cut = true;
            break;
          }
          from = at;
          piece = text.slice(from, token.end);
          w = measure(piece);
        }
        if (cut) break;
        if (lineEnd === lineStart) {
          lineStart = from;
          width = w;
        } else width += pending + w;
        pending = 0;
        lineEnd = token.end;
      }
      if (!cut) {
        if (lineEnd > lineStart || tokens.length === 0 || lines.length === 0 || lineStart === para) flush(stop);
        if (lines.length > maxLines) {
          lines.length = maxLines;
          cut = true;
        } else if (lines.length === maxLines && stop < text.length) cut = true;
      }
    }
    if (lines.length >= maxLines && stop < text.length) cut = true;
    para = stop + 1;
  }
  if (lines.length > maxLines) {
    lines.length = maxLines;
    cut = true;
  }
  if (cut && options.ellipsis && lines.length > 0) {
    const last = lines[lines.length - 1]!;
    // the rest of the last line's paragraph: the cut line shows as much of it as fits
    let rest = text.indexOf("\n", last.start);
    if (rest < 0) rest = text.length;
    const fitted = ellipsize(text.slice(last.start, rest), maxWidth, measure, options.ellipsis, true);
    lines[lines.length - 1] = { text: fitted, width: measure(fitted), start: last.start, end: last.end };
  }
  return lines;
}

/** One line of `text`, cut with `ellipsis` where it would pass `maxWidth`.
 *  `force` appends the ellipsis even when the text fits (it was cut upstream). */
export function ellipsize(text: string, maxWidth: number, measure: Measure, ellipsis = "...", force = false): string {
  const flat = text.indexOf("\n") < 0 ? text : text.replace(/\n/g, " ");
  if (!force && measure(flat) <= maxWidth) return flat;
  const room = maxWidth - measure(ellipsis);
  if (room <= 0) return ellipsis;
  let end = flat.length;
  if (measure(flat) > room) end = fitPrefix(flat, 0, flat.length, room, measure);
  if (end === 1 && measure(flat.slice(0, 1)) > room) end = 0;
  let cutAt = end;
  while (cutAt > 0 && isSpace(flat.charCodeAt(cutAt - 1))) cutAt--;
  return flat.slice(0, cutAt) + ellipsis;
}

/** A measure function that remembers what it measured: wrapping asks for the
 *  same words again on every relayout. */
export function cachedMeasure(measure: Measure, limit = 4096): Measure {
  let cache = new Map<string, number>();
  return (text) => {
    if (text.length === 0) return 0;
    let width = cache.get(text);
    if (width === undefined) {
      width = measure(text);
      if (cache.size >= limit) cache = new Map();
      cache.set(text, width);
    }
    return width;
  };
}
