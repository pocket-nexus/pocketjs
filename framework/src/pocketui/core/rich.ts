// PocketUI core/rich.ts — one paragraph in several styles: bold beside
// regular, `code` in a sentence, a mention chip in a message.
//
// The core draws a text node in one font slot and one colour, so a styled
// paragraph is several nodes, and every one needs its x and its line. This
// module breaks the paragraph into lines over all its spans at once and
// returns, per line, the segments to draw: maximal runs of one style with
// their offset from the line's start.
//
// Breaking follows core/text.ts: at spaces, on either side of a wide
// character, never before closing punctuation. A change of style inside a
// word ("un**break**able", "**bold**,") is not a break opportunity: the
// pieces between two opportunities form one unit that moves to the next line
// together. A unit wider than a whole line is cut inside its pieces.
import { isWide } from "./text.ts";

export interface Span {
  text: string;
  /** an index the caller gives meaning to: a face and a colour */
  style: number;
  /** drawn and moved as one piece, never broken inside: a mention */
  atomic?: boolean;
}

export interface Segment {
  text: string;
  style: number;
  x: number;
  width: number;
  /** the span it came from, and the offsets into that span's text */
  span: number;
  start: number;
  end: number;
}

export interface RichLine {
  segments: Segment[];
  width: number;
}

export type StyleMeasure = (text: string, style: number) => number;

const CLOSING = new Set([0x2c, 0x2e, 0x21, 0x3f, 0x3a, 0x3b, 0x29, 0x5d, 0x7d, 0x3001, 0x3002, 0xff0c, 0xff0e, 0xff01, 0xff1f, 0xff1a, 0xff1b, 0xff09, 0x300b, 0x300d, 0x300f, 0x3011, 0x201d, 0x2019, 0x2026]);
const isSpace = (c: number) => c === 0x20 || c === 0x09 || c === 0xa0 || c === 0x3000;

interface Piece {
  span: number;
  start: number;
  end: number;
  style: number;
  /** 0 word, 1 space, 2 wide, 3 newline, 4 atomic */
  kind: number;
  width: number;
}

function pieces(spans: readonly Span[], measure: StyleMeasure): Piece[] {
  const out: Piece[] = [];
  for (let s = 0; s < spans.length; s++) {
    const { text, style } = spans[s]!;
    if (spans[s]!.atomic) {
      if (text.length > 0) out.push({ span: s, start: 0, end: text.length, style, kind: 4, width: measure(text, style) });
      continue;
    }
    let at = 0;
    const to = text.length;
    while (at < to) {
      const c = text.charCodeAt(at);
      let end = at + 1;
      let kind = 0;
      if (c === 0x0a) kind = 3;
      else if (isSpace(c)) {
        kind = 1;
        while (end < to && isSpace(text.charCodeAt(end))) end++;
      } else {
        const high = c >= 0xd800 && c <= 0xdbff && at + 1 < to;
        const cp = high ? (c - 0xd800) * 0x400 + (text.charCodeAt(at + 1) - 0xdc00) + 0x10000 : c;
        if (isWide(cp)) {
          kind = 2;
          if (high) end = at + 2;
        } else {
          while (end < to) {
            const n = text.charCodeAt(end);
            if (n === 0x0a || isSpace(n) || n >= 0x2e80 || (n >= 0xd800 && n <= 0xdbff)) break;
            end++;
          }
        }
      }
      out.push({ span: s, start: at, end, style, kind, width: kind === 3 ? 0 : measure(text.slice(at, end), style) });
      at = end;
    }
  }
  return out;
}

/** Whether a line may end between two adjacent pieces. */
function breakable(spans: readonly Span[], before: Piece, after: Piece): boolean {
  if (before.kind === 1 || before.kind === 3) return true;
  if (after.kind === 1 || after.kind === 3) return true;
  const first = spans[after.span]!.text.codePointAt(after.start)!;
  if (CLOSING.has(first)) return false;
  return before.kind === 2 || after.kind === 2 || before.kind === 4 || after.kind === 4;
}

/** The spans as lines no wider than `maxWidth`. */
export function layoutRich(spans: readonly Span[], maxWidth: number, measure: StyleMeasure, maxLines = Infinity): RichLine[] {
  const all = pieces(spans, measure);
  const lines: RichLine[] = [];
  let line: Segment[] = [];
  let x = 0;
  /** width up to the last drawn piece: spaces at a line's end do not count */
  let inked = 0;
  const push = (piece: Piece, start = piece.start, end = piece.end, width = piece.width) => {
    const last = line[line.length - 1];
    if (last && last.span === piece.span && last.style === piece.style && last.end === start && piece.kind !== 4 && !spans[piece.span]!.atomic) {
      last.text += spans[piece.span]!.text.slice(start, end);
      last.end = end;
      last.width += width;
    } else line.push({ text: spans[piece.span]!.text.slice(start, end), style: piece.style, x, width, span: piece.span, start, end });
    x += width;
    if (piece.kind !== 1) inked = x;
  };
  const flush = () => {
    // spaces at the end are not drawn
    while (line.length > 0) {
      const last = line[line.length - 1]!;
      const text = last.text.replace(/[ \t 　]+$/, "");
      if (text.length === last.text.length) break;
      if (text.length === 0) line.pop();
      else {
        last.width = measure(text, last.style);
        last.end -= last.text.length - text.length;
        last.text = text;
        break;
      }
    }
    lines.push({ segments: line, width: line.length > 0 ? line[line.length - 1]!.x + line[line.length - 1]!.width : 0 });
    line = [];
    x = 0;
    inked = 0;
  };
  let i = 0;
  while (i < all.length && lines.length < maxLines) {
    const piece = all[i]!;
    if (piece.kind === 3) {
      flush();
      i++;
      continue;
    }
    if (piece.kind === 1) {
      // a space that would open a wrapped line is swallowed
      if (!(line.length === 0 && lines.length > 0 && i > 0 && all[i - 1]!.kind !== 3)) push(piece);
      i++;
      continue;
    }
    // the unit: this piece and the ones attached to it
    let end = i + 1;
    let width = piece.width;
    while (end < all.length && !breakable(spans, all[end - 1]!, all[end]!)) {
      width += all[end]!.width;
      end++;
    }
    if (line.length > 0 && inked > 0 && x + width > maxWidth) {
      flush();
      if (lines.length >= maxLines) break;
    }
    if (width <= maxWidth || maxWidth === Infinity) {
      for (let k = i; k < end; k++) push(all[k]!);
    } else {
      // wider than a line: cut inside its pieces
      for (let k = i; k < end; k++) {
        const part = all[k]!;
        const text = spans[part.span]!.text;
        let from = part.start;
        while (from < part.end) {
          let to = part.end;
          let w = measure(text.slice(from, to), part.style);
          if (x + w > maxWidth && part.kind !== 4) {
            // the longest prefix that fits what is left of the line
            let lo = from;
            let hi = part.end;
            while (lo < hi) {
              const mid = (lo + hi + 1) >> 1;
              if (x + measure(text.slice(from, mid), part.style) <= maxWidth) lo = mid;
              else hi = mid - 1;
            }
            const c = text.charCodeAt(lo - 1);
            if (lo > from && c >= 0xd800 && c <= 0xdbff) lo--;
            if (lo === from) {
              if (line.length > 0) {
                flush();
                if (lines.length >= maxLines) break;
                continue;
              }
              lo = from + 1; // one character at least
            }
            to = lo;
            w = measure(text.slice(from, to), part.style);
          } else if (x + w > maxWidth && line.length > 0) {
            flush();
            if (lines.length >= maxLines) break;
            continue;
          }
          push(part, from, to, w);
          from = to;
          if (from < part.end) {
            flush();
            if (lines.length >= maxLines) break;
          }
        }
        if (lines.length >= maxLines) break;
      }
    }
    i = end;
  }
  if (lines.length < maxLines && (line.length > 0 || lines.length === 0 || (all.length > 0 && all[all.length - 1]!.kind === 3))) flush();
  return lines;
}

/** `lines` cut to `maxLines`, the last kept line ending in `ellipsis` set in
 *  `style` when anything was dropped. The line gives up characters from its
 *  end until the ellipsis fits `maxWidth`. */
export function clampRich(lines: RichLine[], maxLines: number, maxWidth: number, measure: StyleMeasure, style: number, ellipsis = "..."): RichLine[] {
  if (lines.length <= maxLines) return lines;
  const kept = lines.slice(0, maxLines);
  const last = kept[maxLines - 1];
  if (!last) return kept;
  const segments = last.segments.map((segment) => ({ ...segment }));
  const mark = measure(ellipsis, style);
  const room = maxWidth === Infinity ? Infinity : maxWidth - mark;
  let width = segments.length > 0 ? segments[segments.length - 1]!.x + segments[segments.length - 1]!.width : 0;
  while (segments.length > 0 && width > room) {
    const tail = segments[segments.length - 1]!;
    // a character less: a surrogate pair goes as one
    let cut = tail.text.length - 1;
    const c = tail.text.charCodeAt(cut);
    if (cut > 0 && c >= 0xdc00 && c <= 0xdfff) cut--;
    if (cut <= 0) segments.pop();
    else {
      tail.text = tail.text.slice(0, cut).replace(/[ \t]+$/, "");
      tail.end = tail.start + tail.text.length;
      tail.width = measure(tail.text, tail.style);
      if (tail.text.length === 0) segments.pop();
    }
    const end = segments[segments.length - 1];
    width = end ? end.x + end.width : 0;
  }
  const end = segments[segments.length - 1];
  if (end && end.style === style) {
    end.text += ellipsis;
    end.width += mark;
  } else segments.push({ text: ellipsis, style, x: width, width: mark, span: end ? end.span : 0, start: end ? end.end : 0, end: end ? end.end : 0 });
  kept[maxLines - 1] = { segments, width: width + mark };
  return kept;
}
