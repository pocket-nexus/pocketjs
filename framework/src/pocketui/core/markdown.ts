// PocketUI core/markdown.ts — the Markdown an agent writes, as blocks of styled runs.
//
// A coding agent answers in GitHub-flavoured Markdown, and the answer is
// shown while it is still arriving. Nothing downstream draws HTML: every
// block becomes text the app measures and breaks itself (core/text.ts). So
// this module parses to a small block model (paragraph, heading, code,
// quote, list, table, rule) whose text is a list of runs with one style
// each, and it is run again on every streaming update of a message.
//
// Blocks are read line by line. A container (quote, list item) strips its
// prefix from its lines and parses the rest the same way, down to MAX_DEPTH;
// deeper markers stay text. Inline text takes three passes over one
// paragraph: a scan that cuts it into pieces (text, code, link marks,
// delimiter runs), a pairing of the delimiter runs with one stack per
// delimiter character, and a sweep that turns the pieces into runs. A style
// is a count the sweep raises and lowers as it crosses a paired delimiter,
// so no tree is built and an emphasis that overlaps a link costs nothing.
//
// Where it leaves CommonMark, and why:
// - A delimiter opens when a non-space follows it and closes when a
//   non-space precedes it ("_" also needs a word boundary outside).
//   CommonMark's flanking rules refuse to close after CJK punctuation, which
//   leaves "**注意：**后面" unstyled.
// - A line break between two CJK characters joins them with nothing;
//   Chinese has no space to put there.
// - No indented code, setext headings, lazy continuation, reference links
//   or HTML. Agents fence their code, and an indented line is far more often
//   a list item's continuation. A block may start at any indentation.
// - A table takes a row from any line until a blank one or another block.
// - Half-written input stays literal: an unmatched "**", "`" or "[text](ur"
//   is text. The last line, while it has no newline, may still grow, so it
//   does not yet end the paragraph before it as a rule, does not yet make
//   the line before it a table header, and a bare number after an ordered
//   list stays in that list. Without this a block that was already followed
//   by another would change when one more character arrived; with it, the
//   blocks before the last one do not change as the text grows.
//
// Everything is scanned by index with charCodeAt. Each search that could run
// to the end of the text for every opener is bounded: code spans by an index
// of the backtick runs, emphasis by a floor under each stack, link
// destinations by a parenthesis depth, entities by their length.

/** A run of inline text with one style. Adjacent runs with the same style are merged. */
export interface Run {
  text: string;
  bold?: true;
  italic?: true;
  /** inline code: drawn monospace, never re-parsed */
  code?: true;
  strike?: true;
  /** a link's destination; the run's text is what is shown */
  href?: string;
}

export type Block =
  | { t: "p"; runs: Run[] }
  | { t: "h"; level: 1 | 2 | 3 | 4 | 5 | 6; runs: Run[] }
  /** `open`: the fence was not closed yet (still streaming) */
  | { t: "code"; lang: string; text: string; open?: true }
  | { t: "quote"; blocks: Block[] }
  | { t: "list"; ordered: boolean; start: number; items: ListItem[] }
  | { t: "table"; head: Run[][]; rows: Run[][][]; align: ("left" | "center" | "right")[] }
  | { t: "hr" };

export interface ListItem {
  blocks: Block[];
  /** set on task items, "- [ ]" and "- [x]" */
  checked?: boolean;
}

type Align = "left" | "center" | "right";
type CodeBlock = Extract<Block, { t: "code" }>;

/** Quotes and lists nest this deep; a marker below it is paragraph text.
 *  It bounds the recursion on a line of ten thousand ">". */
const MAX_DEPTH = 16;

const TAB = 0x09;
const NEWLINE = 0x0a;
const BANG = 0x21;
const HASH = 0x23;
const AMP = 0x26;
const LPAREN = 0x28;
const RPAREN = 0x29;
const STAR = 0x2a;
const DASH = 0x2d;
const COLON = 0x3a;
const LT = 0x3c;
const GT = 0x3e;
const LBRACKET = 0x5b;
const BACKSLASH = 0x5c;
const RBRACKET = 0x5d;
const UNDERSCORE = 0x5f;
const BACKTICK = 0x60;
const PIPE = 0x7c;
const TILDE = 0x7e;

// ---------------------------------------------------------------- characters

function isBlank(c: number): boolean {
  return c === 0x20 || c === TAB;
}

function isSpace(c: number): boolean {
  return c === 0x20 || c === NEWLINE || c === TAB || c === 0x0d || c === 0x0c || c === 0xa0 || c === 0x3000 || (c >= 0x2000 && c <= 0x200a);
}

function isDigit(c: number): boolean {
  return c >= 0x30 && c <= 0x39;
}

function isAlnum(c: number): boolean {
  return isDigit(c) || (c >= 0x41 && c <= 0x5a) || (c >= 0x61 && c <= 0x7a);
}

/** ASCII punctuation: what a backslash escapes. */
function isPunct(c: number): boolean {
  return (c >= 0x21 && c <= 0x2f) || (c >= 0x3a && c <= 0x40) || (c >= 0x5b && c <= 0x60) || (c >= 0x7b && c <= 0x7e);
}

/** A character "_" does not open or close beside: a letter or digit of any
 *  script. Spaces and punctuation, CJK punctuation included, are boundaries. */
function isWord(c: number): boolean {
  if (c < 0x80) return isAlnum(c);
  if (isSpace(c)) return false;
  return !(
    (c >= 0xa1 && c <= 0xbf) ||
    (c >= 0x2000 && c <= 0x206f) ||
    (c >= 0x3000 && c <= 0x303f) ||
    (c >= 0xfe30 && c <= 0xfe6f) ||
    (c >= 0xff00 && c <= 0xff0f) ||
    (c >= 0xff1a && c <= 0xff20) ||
    (c >= 0xff3b && c <= 0xff40) ||
    (c >= 0xff5b && c <= 0xff65)
  );
}

/** A UTF-16 unit of a script written without spaces: ideographs, kana, CJK
 *  and fullwidth punctuation. Hangul is left out, Korean spaces its words. */
function isCjk(c: number): boolean {
  if (c < 0x2e80) return false;
  if (c <= 0xa4cf) return c < 0x3130 || c > 0x318f;
  return (c >= 0xf900 && c <= 0xfaff) || (c >= 0xfe30 && c <= 0xfe4f) || (c >= 0xff00 && c <= 0xff9f) || (c >= 0xffe0 && c <= 0xffe6);
}

/** The high surrogate of an ideograph outside the basic plane. */
function isCjkHigh(c: number): boolean {
  return c >= 0xd840 && c <= 0xd88f;
}

function startsCjk(text: string): boolean {
  const c = text.charCodeAt(0);
  return isCjk(c) || isCjkHigh(c);
}

function endsCjk(text: string): boolean {
  const c = text.charCodeAt(text.length - 1);
  if (c >= 0xdc00 && c <= 0xdfff) return text.length > 1 && isCjkHigh(text.charCodeAt(text.length - 2));
  return isCjk(c);
}

// --------------------------------------------------------------------- lines

/** The index of the first character of `line` that is not a space or tab. */
function lead(line: string, from = 0): number {
  let i = from;
  while (i < line.length && isBlank(line.charCodeAt(i))) i++;
  return i;
}

/** The width of line[from, to) in columns: a tab counts as four spaces. */
function columns(line: string, from: number, to: number): number {
  let cols = to - from;
  for (let i = from; i < to; i++) if (line.charCodeAt(i) === TAB) cols += 3;
  return cols;
}

/** `line` without its first `cols` columns of indentation, or as many as it has. */
function dedent(line: string, cols: number): string {
  let i = 0;
  let left = cols;
  while (left > 0 && i < line.length) {
    const c = line.charCodeAt(i);
    if (c === 0x20) left--;
    else if (c === TAB) {
      // a tab that straddles the cut keeps the columns past it
      if (left < 4) return " ".repeat(4 - left) + line.slice(i + 1);
      left -= 4;
    } else break;
    i++;
  }
  return i === 0 ? line : line.slice(i);
}

/** One container's lines. `tail`: the last of them is the input's last line
 *  and has no newline yet, so it may still grow. */
interface Frame {
  lines: string[];
  depth: number;
  tail: boolean;
}

// -------------------------------------------------------------------- blocks

export function parseMarkdown(source: string): Block[] {
  if (source.length === 0) return [];
  const text = source.indexOf("\r") < 0 ? source : source.replace(/\r\n?/g, "\n");
  const lines = text.split("\n");
  const tail = lines[lines.length - 1] !== "";
  if (!tail) lines.pop();
  return parseBlocks({ lines, depth: 0, tail });
}

/** Each reader below returns the index of the line after its block, or -1
 *  when its block does not start at line `i`. A paragraph always does. */
function parseBlocks(f: Frame): Block[] {
  const out: Block[] = [];
  const lines = f.lines;
  const nested = f.depth < MAX_DEPTH;
  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!;
    const at = lead(line);
    if (at === line.length) {
      i++;
      continue;
    }
    const c = line.charCodeAt(at);
    let next = -1;
    if (c === BACKTICK || c === TILDE) next = fence(f, i, at, out);
    else if (c === HASH) next = heading(f, i, at, out);
    else if (c === GT) next = nested ? quote(f, i, out) : -1;
    else if (isRule(line, at)) next = rule(i, out);
    else if (nested) next = list(f, i, at, out);
    if (next < 0) next = table(f, i, out);
    if (next < 0) next = paragraph(f, i, out);
    i = next;
  }
  return out;
}

/** Whether the line ends a paragraph or a table above it. An empty list item
 *  or heading does not, nor an ordered item that is not numbered 1: "#",
 *  "-" and "2024." at the start of a line are text more often than not.
 *  The answer never goes back to "no" as the line grows, so the block above
 *  is settled once it is "yes": three fence characters end it whatever
 *  follows them, and a rule waits for its newline (`growing`: the line has
 *  none yet), since "---" may still become "---|---" or "---x". */
function interrupts(line: string, at: number, growing: boolean): boolean {
  const c = line.charCodeAt(at);
  if (c === GT) return true;
  if (c === BACKTICK || c === TILDE) return line.charCodeAt(at + 1) === c && line.charCodeAt(at + 2) === c;
  if (c === HASH) {
    const level = headingLevel(line, at);
    return level > 0 && lead(line, at + level) < line.length;
  }
  if (!growing && isRule(line, at)) return true;
  const m = markerAt(line, at);
  return m !== null && !m.empty && (!m.ordered || m.start === 1);
}

function paragraph(f: Frame, i: number, out: Block[]): number {
  const lines = f.lines;
  const first = lines[i]!;
  const parts = [first.slice(lead(first))];
  let j = i + 1;
  for (; j < lines.length; j++) {
    const line = lines[j]!;
    const at = lead(line);
    if (at === line.length || interrupts(line, at, f.tail && j === lines.length - 1) || tableHead(f, j) !== null) break;
    parts.push(line.slice(at));
  }
  const runs = parseInline(parts.length === 1 ? parts[0]! : parts.join("\n"));
  if (runs.length > 0) out.push({ t: "p", runs });
  return j;
}

/** The level of the ATX heading at `at`, or 0: one to six "#" and then a space or the line's end. */
function headingLevel(line: string, at: number): number {
  let end = at;
  while (line.charCodeAt(end) === HASH) end++;
  if (end - at > 6) return 0;
  return end === line.length || isBlank(line.charCodeAt(end)) ? end - at : 0;
}

/** A heading's text: trimmed, and without a closing run of "#" that a space sets off. */
function headingText(line: string, from: number): string {
  const start = lead(line, from);
  let end = line.length;
  while (end > start && isBlank(line.charCodeAt(end - 1))) end--;
  let close = end;
  while (close > start && line.charCodeAt(close - 1) === HASH) close--;
  if (close < end && (close === start || isBlank(line.charCodeAt(close - 1)))) {
    end = close;
    while (end > start && isBlank(line.charCodeAt(end - 1))) end--;
  }
  return line.slice(start, end);
}

function heading(f: Frame, i: number, at: number, out: Block[]): number {
  const line = f.lines[i]!;
  const level = headingLevel(line, at);
  if (level === 0) return -1;
  out.push({ t: "h", level: level as 1 | 2 | 3 | 4 | 5 | 6, runs: parseInline(headingText(line, at + level)) });
  return i + 1;
}

/** Three or more of "-", "*" or "_", with nothing but spaces between. */
function isRule(line: string, at: number): boolean {
  const c = line.charCodeAt(at);
  if (c !== DASH && c !== STAR && c !== UNDERSCORE) return false;
  let count = 0;
  for (let i = at; i < line.length; i++) {
    const d = line.charCodeAt(i);
    if (d === c) count++;
    else if (!isBlank(d)) return false;
  }
  return count >= 3;
}

function rule(i: number, out: Block[]): number {
  out.push({ t: "hr" });
  return i + 1;
}

/** The length of the fence that opens at `at`, or 0. A backtick fence has no
 *  backtick in its info string: that line is inline code. */
function fenceLength(line: string, at: number): number {
  const c = line.charCodeAt(at);
  let end = at + 1;
  while (line.charCodeAt(end) === c) end++;
  if (end - at < 3) return 0;
  if (c === BACKTICK && line.indexOf("`", end) >= 0) return 0;
  return end - at;
}

/** A line of at least `length` of the fence character and nothing else. */
function closesFence(line: string, c: number, length: number): boolean {
  const at = lead(line);
  if (line.charCodeAt(at) !== c) return false;
  let end = at + 1;
  while (line.charCodeAt(end) === c) end++;
  return end - at >= length && lead(line, end) === line.length;
}

function firstWord(line: string, from: number): string {
  const start = lead(line, from);
  let end = start;
  while (end < line.length && !isBlank(line.charCodeAt(end))) end++;
  return line.slice(start, end);
}

function fence(f: Frame, i: number, at: number, out: Block[]): number {
  const lines = f.lines;
  const line = lines[i]!;
  const length = fenceLength(line, at);
  if (length === 0) return -1;
  const c = line.charCodeAt(at);
  const indent = columns(line, 0, at);
  const body: string[] = [];
  let closed = false;
  let j = i + 1;
  for (; j < lines.length && !closed; j++) {
    const inner = lines[j]!;
    if (closesFence(inner, c, length)) closed = true;
    else body.push(indent > 0 ? dedent(inner, indent) : inner);
  }
  const block: CodeBlock = { t: "code", lang: firstWord(line, at + length), text: body.join("\n") };
  if (!closed) block.open = true;
  out.push(block);
  return j;
}

/** The run of lines that start with ">", parsed without the ">" and one space after it. */
function quote(f: Frame, i: number, out: Block[]): number {
  const lines = f.lines;
  const inner: string[] = [];
  let j = i;
  for (; j < lines.length; j++) {
    const line = lines[j]!;
    const at = lead(line);
    if (line.charCodeAt(at) !== GT) break;
    inner.push(line.slice(isBlank(line.charCodeAt(at + 1)) ? at + 2 : at + 1));
  }
  out.push({ t: "quote", blocks: parseBlocks({ lines: inner, depth: f.depth + 1, tail: f.tail && j === lines.length }) });
  return j;
}

// --------------------------------------------------------------------- lists

interface Marker {
  ordered: boolean;
  /** the bullet, or the "." or ")" after the number */
  ch: number;
  start: number;
  /** the marker's column */
  col: number;
  /** the index in the line, and the column, where the item's text starts */
  content: number;
  contentCol: number;
  empty: boolean;
}

/** The list marker at `at`: "-", "*", "+", or up to nine digits and "." or
 *  ")", followed by a space or the end of the line. */
function markerAt(line: string, at: number): Marker | null {
  const c = line.charCodeAt(at);
  let end = at + 1;
  let ch = c;
  let start = 1;
  const ordered = isDigit(c);
  if (ordered) {
    start = c - 0x30;
    while (end - at < 9 && isDigit(line.charCodeAt(end))) start = start * 10 + line.charCodeAt(end++) - 0x30;
    ch = line.charCodeAt(end++);
    if (ch !== 0x2e && ch !== RPAREN) return null;
  } else if (c !== DASH && c !== STAR && c !== 0x2b) return null;
  if (end < line.length && !isBlank(line.charCodeAt(end))) return null;
  const content = lead(line, end);
  const empty = content === line.length;
  const col = columns(line, 0, at);
  const contentCol = col + (end - at) + (empty ? 1 : columns(line, end, content));
  return { ordered, ch, start, col, content, contentCol, empty };
}

/** A line of digits only: the start of the next item's number, or text. */
function onlyDigits(line: string, at: number): boolean {
  if (line.length - at > 9) return false;
  for (let i = at; i < line.length; i++) if (!isDigit(line.charCodeAt(i))) return false;
  return true;
}

/** 0 for no task box, 1 for "[ ]", 2 for "[x]", at the start of an item's first line. */
function taskBox(head: string): number {
  if (head.charCodeAt(0) !== LBRACKET || head.charCodeAt(2) !== RBRACKET) return 0;
  if (head.length > 3 && !isBlank(head.charCodeAt(3))) return 0;
  const c = head.charCodeAt(1);
  return c === 0x20 ? 1 : c === 0x78 || c === 0x58 ? 2 : 0;
}

function listItem(body: string[], depth: number, tail: boolean): ListItem {
  const head = body[0]!;
  const box = taskBox(head);
  if (box > 0) body[0] = head.slice(lead(head, 3));
  const item: ListItem = { blocks: parseBlocks({ lines: body, depth, tail }) };
  if (box > 0) item.checked = box === 2;
  return item;
}

/** A list: its first item's line, then for each item the lines indented
 *  under it. The strict rule is indentation to the item's text; two columns
 *  past its marker is accepted, since agents indent children of "1." by two.
 *  A marker of the same kind that is not indented that far is the next item. */
function list(f: Frame, i: number, at: number, out: Block[]): number {
  const lines = f.lines;
  const first = markerAt(lines[i]!, at);
  if (first === null) return -1;
  const items: ListItem[] = [];
  const end = lines.length;
  let m = first;
  let j = i;
  for (;;) {
    const body = [lines[j]!.slice(m.content)];
    let kept = 1; // the item's lines without the blank ones after its last
    let last = j;
    for (j++; j < end; j++) {
      const line = lines[j]!;
      const a = lead(line);
      if (a === line.length) {
        body.push("");
        continue;
      }
      if (columns(line, 0, a) >= m.col + 2) body.push(dedent(line, m.contentCol));
      else if (first.ordered && f.tail && j === end - 1 && onlyDigits(line, a)) body.push(line.slice(a));
      else break;
      kept = body.length;
      last = j;
    }
    body.length = kept;
    items.push(listItem(body, f.depth + 1, f.tail && last === end - 1));
    if (j >= end) break;
    const line = lines[j]!;
    const a = lead(line);
    // "* * *" is a rule, but while it may grow into "* * * x" it is an item
    const next = isRule(line, a) && !(f.tail && j === end - 1) ? null : markerAt(line, a);
    if (next === null || next.ordered !== first.ordered || next.ch !== first.ch) break;
    m = next;
  }
  out.push({ t: "list", ordered: first.ordered, start: first.start, items });
  return j;
}

// -------------------------------------------------------------------- tables

/** A row's cells as source text: split at "|" (not at "\|", which becomes
 *  "|"), trimmed, without the empty ones outside a leading or closing "|". */
function splitRow(line: string): string[] {
  const cells: string[] = [];
  let i = lead(line);
  let end = line.length;
  while (end > i && isBlank(line.charCodeAt(end - 1))) end--;
  if (line.charCodeAt(i) === PIPE) i++;
  let from = i;
  let escaped = false;
  for (; i < end; i++) {
    const c = line.charCodeAt(i);
    if (c === BACKSLASH && i + 1 < end) {
      if (line.charCodeAt(i + 1) === PIPE) escaped = true;
      i++;
    } else if (c === PIPE) {
      cells.push(cellText(line, from, i, escaped));
      from = i + 1;
      escaped = false;
    }
  }
  if (from < end) cells.push(cellText(line, from, end, escaped));
  return cells;
}

function cellText(line: string, from: number, to: number, escaped: boolean): string {
  const start = lead(line, from);
  let end = to;
  while (end > start && isBlank(line.charCodeAt(end - 1))) end--;
  const text = line.slice(start, end);
  return escaped ? text.split("\\|").join("|") : text;
}

/** The alignment a delimiter cell gives ("---", ":--", ":-:", "--:"), or null when it is not one. */
function cellAlign(cell: string): Align | null {
  let start = 0;
  let end = cell.length;
  const left = cell.charCodeAt(0) === COLON;
  const right = end > 0 && cell.charCodeAt(end - 1) === COLON;
  if (left) start++;
  if (right) end--;
  if (end <= start) return null;
  for (let i = start; i < end; i++) if (cell.charCodeAt(i) !== DASH) return null;
  return left && right ? "center" : right ? "right" : "left";
}

/** The alignments of a delimiter row, or null. It has to hold a "|": "---" alone is a rule. */
function delimiterRow(line: string): Align[] | null {
  const c = line.charCodeAt(lead(line));
  if ((c !== PIPE && c !== DASH && c !== COLON) || line.indexOf("|") < 0) return null;
  const cells = splitRow(line);
  if (cells.length === 0) return null;
  const align: Align[] = [];
  for (let i = 0; i < cells.length; i++) {
    const one = cellAlign(cells[i]!);
    if (one === null) return null;
    align.push(one);
  }
  return align;
}

interface TableHead {
  cells: string[];
  align: Align[];
}

/** Line `i` as a table's header: it holds a "|" and the next line is a
 *  finished delimiter row with as many cells. */
function tableHead(f: Frame, i: number): TableHead | null {
  const lines = f.lines;
  if (i + 1 >= lines.length || (f.tail && i + 2 === lines.length)) return null;
  const line = lines[i]!;
  if (line.indexOf("|") < 0) return null;
  const align = delimiterRow(lines[i + 1]!);
  if (align === null) return null;
  const cells = splitRow(line);
  return cells.length === align.length ? { cells, align } : null;
}

/** A row of exactly `width` cells: short rows are padded, long ones cut. */
function tableRow(cells: string[], width: number): Run[][] {
  const row: Run[][] = [];
  for (let k = 0; k < width; k++) row.push(k < cells.length ? parseInline(cells[k]!) : []);
  return row;
}

function table(f: Frame, i: number, out: Block[]): number {
  const head = tableHead(f, i);
  if (head === null) return -1;
  const lines = f.lines;
  const width = head.cells.length;
  const rows: Run[][][] = [];
  let j = i + 2;
  for (; j < lines.length; j++) {
    const line = lines[j]!;
    const at = lead(line);
    if (at === line.length || interrupts(line, at, f.tail && j === lines.length - 1)) break;
    rows.push(tableRow(splitRow(line), width));
  }
  out.push({ t: "table", head: tableRow(head.cells, width), rows, align: head.align });
  return j;
}

// -------------------------------------------------------------------- inline

const TEXT = 0;
const CODE = 1;
const DELIM = 2;
const SOFT = 3; // a line break inside a paragraph: a space, or nothing between CJK
const OPEN = 4; // a link starts: `href` is its destination
const CLOSE = 5;

const BOLD = 1;
const ITALIC = 2;
const MONO = 4;
const STRIKE = 8;

/** A run of "*", "_" or "~". `count` is what is left of it as literal text;
 *  open2/close2 count the two-character pairs it made (bold, strike) and
 *  open1/close1 the one-character pairs (italic). */
interface Delim {
  ch: number;
  count: number;
  orig: number;
  canOpen: boolean;
  canClose: boolean;
  open1: number;
  open2: number;
  close1: number;
  close2: number;
}

interface Piece {
  kind: number;
  text: string;
  href: string | undefined;
  delim: Delim | undefined;
}

interface Scan {
  src: string;
  end: number;
  /** the next character to read */
  at: number;
  /** where the literal text not yet made a piece starts */
  from: number;
  pieces: Piece[];
  /** the "[" and "![" that may still open a link, three numbers each:
   *  piece index, source index after it, 1 for an image */
  brackets: number[];
  /** the last backtick run of each length, by its start */
  ticks: Map<number, number> | null;
  delims: boolean;
}

/** The ASCII characters the scan stops at. "h" is there for a bare http URL. */
const STOPS: number[] = [];
for (let i = 0; i < 128; i++) STOPS.push(0);
STOPS[NEWLINE] = STOPS[BANG] = STOPS[AMP] = STOPS[STAR] = STOPS[LT] = STOPS[LBRACKET] = STOPS[BACKSLASH] = STOPS[RBRACKET] = 1;
STOPS[UNDERSCORE] = STOPS[BACKTICK] = STOPS[TILDE] = STOPS[0x68] = 1;

/** Parse inline Markdown only (one paragraph's text). */
export function parseInline(source: string): Run[] {
  let start = 0;
  let end = source.length;
  while (start < end && isBlankOrNewline(source.charCodeAt(start))) start++;
  while (end > start && isBlankOrNewline(source.charCodeAt(end - 1))) end--;
  if (start === end) return [];
  const src = start === 0 && end === source.length ? source : source.slice(start, end);
  const s: Scan = { src, end: src.length, at: 0, from: 0, pieces: [], brackets: [], ticks: null, delims: false };
  while (s.at < s.end) {
    const c = src.charCodeAt(s.at);
    if (c > 127 || STOPS[c] === 0) s.at++;
    else step(s, c);
  }
  flush(s, s.end);
  if (s.delims) pairDelimiters(s.pieces);
  return buildRuns(s.pieces);
}

function isBlankOrNewline(c: number): boolean {
  return c === 0x20 || c === TAB || c === NEWLINE;
}

/** One stop character. A reader that finds nothing to make of it moves `at`
 *  past it and leaves it in the literal text. */
function step(s: Scan, c: number): void {
  switch (c) {
    case NEWLINE:
      return lineBreak(s);
    case BACKSLASH:
      return escape(s);
    case BACKTICK:
      return codeSpan(s);
    case STAR:
    case UNDERSCORE:
    case TILDE:
      return delimiterRun(s, c);
    case LBRACKET:
      return openBracket(s, 0);
    case BANG:
      if (s.src.charCodeAt(s.at + 1) === LBRACKET) return openBracket(s, 1);
      s.at++;
      return;
    case RBRACKET:
      return closeBracket(s);
    case LT:
      return angle(s);
    case AMP:
      return entity(s);
    default:
      return bareUrl(s);
  }
}

function push(s: Scan, kind: number, text: string, href?: string, delim?: Delim): void {
  s.pieces.push({ kind, text, href, delim });
}

/** The literal text up to `to` becomes a piece. */
function flush(s: Scan, to: number): void {
  if (to > s.from) push(s, TEXT, s.src.slice(s.from, to));
}

/** Continue reading at `at`, with nothing literal pending. */
function resume(s: Scan, at: number): void {
  s.at = at;
  s.from = at;
}

function skipSpace(src: string, from: number, end: number): number {
  let i = from;
  while (i < end && isBlankOrNewline(src.charCodeAt(i))) i++;
  return i;
}

/** A newline: a hard break ("\n" in the text) after two or more spaces, else
 *  a soft one. The spaces on both sides of it are dropped. */
function lineBreak(s: Scan): void {
  let before = s.at;
  while (before > s.from && isBlank(s.src.charCodeAt(before - 1))) before--;
  const hard = s.at - before >= 2;
  flush(s, before);
  if (hard) push(s, TEXT, "\n");
  else push(s, SOFT, "");
  resume(s, skipSpace(s.src, s.at + 1, s.end));
}

function escape(s: Scan): void {
  const next = s.src.charCodeAt(s.at + 1);
  if (next === NEWLINE) {
    flush(s, s.at);
    push(s, TEXT, "\n");
    resume(s, skipSpace(s.src, s.at + 2, s.end));
  } else if (isPunct(next)) {
    // the escaped character starts the next literal text and is not read again
    flush(s, s.at);
    s.from = s.at + 1;
    s.at += 2;
  } else s.at++;
}

/** Where the last backtick run of each length starts. With it an opening run
 *  knows in one lookup whether a closing run exists, so a text of unmatched
 *  backticks is not searched to its end once per run. */
function indexTicks(src: string): Map<number, number> {
  const last = new Map<number, number>();
  let at = src.indexOf("`");
  while (at >= 0) {
    let end = at + 1;
    while (src.charCodeAt(end) === BACKTICK) end++;
    last.set(end - at, at);
    at = src.indexOf("`", end);
  }
  return last;
}

/** A code span's text: line breaks are spaces, and one space is taken off
 *  each end when both ends have one and something else is inside. */
function codeText(raw: string): string {
  const text = raw.indexOf("\n") < 0 ? raw : raw.split("\n").join(" ");
  const n = text.length;
  if (n < 2 || text.charCodeAt(0) !== 0x20 || text.charCodeAt(n - 1) !== 0x20) return text;
  for (let i = 1; i < n - 1; i++) if (text.charCodeAt(i) !== 0x20) return text.slice(1, n - 1);
  return text;
}

function codeSpan(s: Scan): void {
  const src = s.src;
  const start = s.at;
  let open = start + 1;
  while (src.charCodeAt(open) === BACKTICK) open++;
  const length = open - start;
  if (s.ticks === null) s.ticks = indexTicks(src);
  const lastRun = s.ticks.get(length);
  if (lastRun === undefined || lastRun <= start) {
    s.at = open; // no closing run: literal
    return;
  }
  // a run of this length does follow, so this loop ends at it
  let close = open;
  for (;;) {
    close = src.indexOf("`", close);
    let end = close + 1;
    while (src.charCodeAt(end) === BACKTICK) end++;
    if (end - close === length) break;
    close = end;
  }
  flush(s, start);
  push(s, CODE, codeText(src.slice(open, close)));
  resume(s, close + length);
}

/** A run of "*", "_" or "~" that can open or close becomes a piece to pair
 *  later. Strike is exactly "~~": a lone "~" means "about". */
function delimiterRun(s: Scan, c: number): void {
  const src = s.src;
  const start = s.at;
  let end = start + 1;
  while (src.charCodeAt(end) === c) end++;
  const before = start > 0 ? src.charCodeAt(start - 1) : 0x20;
  const after = end < s.end ? src.charCodeAt(end) : 0x20;
  let canOpen = !isSpace(after);
  let canClose = !isSpace(before);
  if (c === UNDERSCORE) {
    canOpen = canOpen && !isWord(before);
    canClose = canClose && !isWord(after);
  }
  const count = end - start;
  if ((c === TILDE && count !== 2) || (!canOpen && !canClose)) {
    s.at = end;
    return;
  }
  flush(s, start);
  push(s, DELIM, "", undefined, { ch: c, count, orig: count, canOpen, canClose, open1: 0, open2: 0, close1: 0, close2: 0 });
  s.delims = true;
  resume(s, end);
}

function openBracket(s: Scan, image: number): void {
  flush(s, s.at);
  push(s, TEXT, image === 1 ? "![" : "[");
  const after = s.at + 1 + image;
  s.brackets.push(s.pieces.length - 1, after, image);
  resume(s, after);
}

/** "]": with the nearest "[" and a "(destination)" after it, a link. The "["
 *  piece becomes the mark where the link starts. A link's text holds no
 *  other link, so every "[" before it is dropped; an image's may sit inside
 *  one ("[![badge](img)](url)"). Empty text shows the destination. */
function closeBracket(s: Scan): void {
  const b = s.brackets;
  if (b.length === 0 || s.src.charCodeAt(s.at + 1) !== LPAREN) {
    b.length = b.length === 0 ? 0 : b.length - 3;
    s.at++;
    return;
  }
  const image = b.pop()!;
  const textStart = b.pop()!;
  const opener = s.pieces[b.pop()!]!;
  const tail = linkTail(s.src, s.at + 1, s.end);
  if (tail === null) {
    s.at++;
    return;
  }
  flush(s, s.at);
  opener.kind = OPEN;
  opener.text = "";
  opener.href = tail.url === "" ? undefined : tail.url;
  if (skipSpace(s.src, textStart, s.at) === s.at) push(s, TEXT, tail.url);
  push(s, CLOSE, "");
  if (image === 0) b.length = 0;
  resume(s, tail.end);
}

interface LinkTail {
  url: string;
  end: number;
}

/** `(destination "title")` from the "(" at `at`: the destination and the
 *  index after the ")", or null. The destination is "<…>" or has no space
 *  and balanced parentheses, at most 32 deep: a run of "[a](b" does not get
 *  read to the end of the text once per "(". The title is dropped. */
function linkTail(src: string, at: number, end: number): LinkTail | null {
  let i = skipSpace(src, at + 1, end);
  const from = i;
  let url: string;
  if (src.charCodeAt(i) === LT) {
    for (i++; ; i++) {
      const c = src.charCodeAt(i);
      if (c === GT) break;
      if (i >= end || c === LT || c === NEWLINE) return null;
    }
    url = src.slice(from + 1, i++);
  } else {
    let depth = 0;
    for (; i < end; i++) {
      const c = src.charCodeAt(i);
      if (c <= 0x20) break;
      if (c === BACKSLASH && isPunct(src.charCodeAt(i + 1))) i++;
      else if (c === LPAREN) {
        if (++depth > 32) return null;
      } else if (c === RPAREN) {
        if (depth === 0) break;
        depth--;
      }
    }
    if (depth !== 0) return null;
    url = src.slice(from, i);
  }
  const gap = i;
  i = skipSpace(src, i, end);
  const quoteChar = src.charCodeAt(i);
  if (i > gap && (quoteChar === 0x22 || quoteChar === 0x27)) {
    for (i++; ; i++) {
      if (i >= end) return null;
      const c = src.charCodeAt(i);
      if (c === quoteChar) break;
      if (c === BACKSLASH) i++;
    }
    i = skipSpace(src, i + 1, end);
  }
  if (i >= end || src.charCodeAt(i) !== RPAREN) return null;
  return { url: unescape(url), end: i + 1 };
}

/** The index after "<br>", "<br/>" or "<br />" at `at`, or 0. */
function brEnd(src: string, at: number): number {
  if ((src.charCodeAt(at + 1) | 0x20) !== 0x62 || (src.charCodeAt(at + 2) | 0x20) !== 0x72) return 0;
  let i = lead(src, at + 3);
  if (src.charCodeAt(i) === 0x2f) i++;
  return src.charCodeAt(i) === GT ? i + 1 : 0;
}

/** The index of the ">" that closes the autolink at `at`, or 0. Only http,
 *  https and mailto: "<std::string>" is a type, not a link. */
function autolinkEnd(src: string, at: number): number {
  if (!src.startsWith("http://", at + 1) && !src.startsWith("https://", at + 1) && !src.startsWith("mailto:", at + 1)) return 0;
  for (let i = at + 8; i < src.length; i++) {
    const c = src.charCodeAt(i);
    if (c === GT) return i;
    if (c <= 0x20 || c === LT) return 0;
  }
  return 0;
}

/** "<": a line break tag or an autolink. Any other tag stays as text. */
function angle(s: Scan): void {
  const br = brEnd(s.src, s.at);
  if (br > 0) {
    flush(s, s.at);
    push(s, TEXT, "\n");
    return resume(s, br);
  }
  const close = autolinkEnd(s.src, s.at);
  if (close > 0) {
    const url = s.src.slice(s.at + 1, close);
    flush(s, s.at);
    push(s, TEXT, url, url);
    return resume(s, close + 1);
  }
  s.at++;
}

/** The index of the ";" that ends the entity at `at`, or -1. The longest is "&#x10FFFF;". */
function entityEnd(text: string, at: number): number {
  const stop = Math.min(text.length, at + 10);
  for (let i = at + 1; i < stop; i++) {
    const c = text.charCodeAt(i);
    if (c === 0x3b) return i;
    if (!isAlnum(c) && c !== HASH) return -1;
  }
  return -1;
}

function codePoint(cp: number): string {
  if (cp === 0 || cp > 0x10ffff || (cp >= 0xd800 && cp <= 0xdfff)) return "�";
  if (cp < 0x10000) return String.fromCharCode(cp);
  return String.fromCharCode(0xd800 + ((cp - 0x10000) >> 10), 0xdc00 + ((cp - 0x10000) & 0x3ff));
}

/** What the entity named `name` (between "&" and ";") stands for, or "". */
function decodeEntity(name: string): string {
  switch (name) {
    case "amp":
      return "&";
    case "lt":
      return "<";
    case "gt":
      return ">";
    case "quot":
      return '"';
    case "apos":
      return "'";
    case "nbsp":
      return " ";
  }
  if (name.charCodeAt(0) !== HASH) return "";
  const hex = (name.charCodeAt(1) | 0x20) === 0x78;
  let i = hex ? 2 : 1;
  if (i >= name.length) return "";
  let cp = 0;
  for (; i < name.length; i++) {
    const c = name.charCodeAt(i);
    const digit = isDigit(c) ? c - 0x30 : hex && (c | 0x20) >= 0x61 && (c | 0x20) <= 0x66 ? (c | 0x20) - 0x57 : -1;
    if (digit < 0) return "";
    cp = cp * (hex ? 16 : 10) + digit;
  }
  return codePoint(cp);
}

function entity(s: Scan): void {
  const semi = entityEnd(s.src, s.at);
  const text = semi < 0 ? "" : decodeEntity(s.src.slice(s.at + 1, semi));
  if (text === "") {
    s.at++;
    return;
  }
  flush(s, s.at);
  push(s, TEXT, text);
  resume(s, semi + 1);
}

/** `text` with its backslash escapes and entities resolved: a link's destination. */
function unescape(text: string): string {
  if (text.indexOf("\\") < 0 && text.indexOf("&") < 0) return text;
  const parts: string[] = [];
  let from = 0;
  let i = 0;
  while (i < text.length) {
    const c = text.charCodeAt(i);
    if (c === BACKSLASH && isPunct(text.charCodeAt(i + 1))) {
      parts.push(text.slice(from, i));
      from = i + 1;
      i += 2;
      continue;
    }
    if (c === AMP) {
      const semi = entityEnd(text, i);
      const decoded = semi < 0 ? "" : decodeEntity(text.slice(i + 1, semi));
      if (decoded !== "") {
        parts.push(text.slice(from, i), decoded);
        from = i = semi + 1;
        continue;
      }
    }
    i++;
  }
  parts.push(text.slice(from));
  return parts.join("");
}

/** Where the bare URL whose path starts at `from` ends. It stops at a space,
 *  a quote or angle bracket, a CJK or typographic character (in Chinese text
 *  the sentence goes on with no space), and at a "]" that may close a link's
 *  text. Then closing punctuation is taken off: ".,;:!?", emphasis
 *  delimiters, and a ")" that no "(" in the URL opens. */
function urlEnd(src: string, from: number, end: number, inBracket: boolean): number {
  let i = from;
  let opened = 0;
  let closed = 0;
  for (; i < end; i++) {
    const c = src.charCodeAt(i);
    if (c <= 0x20 || c === LT || c === GT || c === 0x22 || c === BACKTICK || c >= 0x2e80 || (c >= 0x2000 && c <= 0x206f)) break;
    if (c === RBRACKET && inBracket) break;
    if (c === LPAREN) opened++;
    else if (c === RPAREN) closed++;
  }
  while (i > from) {
    const c = src.charCodeAt(i - 1);
    if (c === RPAREN) {
      if (closed <= opened) break;
      closed--;
    } else if (c !== 0x2e && c !== 0x2c && c !== 0x3b && c !== COLON && c !== BANG && c !== 0x3f && c !== STAR && c !== UNDERSCORE && c !== TILDE && c !== 0x27) break;
    i--;
  }
  return i;
}

/** "h": a bare http:// or https:// URL that does not continue a word. */
function bareUrl(s: Scan): void {
  const src = s.src;
  const at = s.at;
  s.at++;
  if (src.charCodeAt(at + 1) !== 0x74 || src.charCodeAt(at + 2) !== 0x74 || src.charCodeAt(at + 3) !== 0x70) return;
  const colon = src.charCodeAt(at + 4) === 0x73 ? at + 5 : at + 4;
  if (src.charCodeAt(colon) !== COLON || src.charCodeAt(colon + 1) !== 0x2f || src.charCodeAt(colon + 2) !== 0x2f) return;
  if (at > 0 && isAlnum(src.charCodeAt(at - 1))) return;
  const end = urlEnd(src, colon + 3, s.end, s.brackets.length > 0);
  if (end === colon + 3) return;
  const url = src.slice(at, end);
  flush(s, at);
  push(s, TEXT, url, url);
  resume(s, end);
}

// ------------------------------------------------------------------ emphasis

/** Pairs the delimiter runs, in order. A run that can close takes the
 *  nearest run of its character that can open, two characters at a time for
 *  bold while both have two and one for italic otherwise; the openers
 *  between the two are dropped. What is left of a run that can open waits on
 *  its character's stack. Each character has its own stack, so "*" and "~~"
 *  may overlap: runs are flat and can say so. */
function pairDelimiters(pieces: Piece[]): void {
  const stars: Delim[] = [];
  const unders: Delim[] = [];
  const tildes: Delim[] = [];
  const starFloor = [0, 0, 0, 0, 0, 0];
  const underFloor = [0, 0, 0, 0, 0, 0];
  for (let k = 0; k < pieces.length; k++) {
    const d = pieces[k]!.delim;
    if (d === undefined) continue;
    if (d.ch === TILDE) pairStrike(tildes, d);
    else if (d.ch === STAR) pairEmphasis(stars, starFloor, d);
    else pairEmphasis(unders, underFloor, d);
  }
}

function pairStrike(stack: Delim[], d: Delim): void {
  const opener = d.canClose ? stack.pop() : undefined;
  if (opener === undefined) {
    if (d.canOpen) stack.push(d);
    return;
  }
  opener.count = d.count = 0;
  opener.open2++;
  d.close2++;
}

/** CommonMark's rule of three: when either run could both open and close,
 *  the two do not pair if their lengths sum to a multiple of three (unless
 *  both are one). It is what reads "**2*3=6**" as one bold span. */
function mismatched(opener: Delim, closer: Delim): boolean {
  if (!opener.canClose && !closer.canOpen) return false;
  return (opener.orig + closer.orig) % 3 === 0 && (opener.orig % 3 !== 0 || closer.orig % 3 !== 0);
}

/** `floor` is, for each kind of closer (can it open too, its length modulo
 *  three), the height of the stack below which no opener pairs with it. A
 *  search that fails raises it, so the next such closer does not search the
 *  same openers again. */
function pairEmphasis(stack: Delim[], floor: number[], d: Delim): void {
  const kind = (d.canOpen ? 3 : 0) + (d.orig % 3);
  while (d.canClose && d.count > 0) {
    let k = stack.length - 1;
    while (k >= floor[kind]! && mismatched(stack[k]!, d)) k--;
    if (k < floor[kind]!) {
      floor[kind] = stack.length;
      break;
    }
    const opener = stack[k]!;
    if (d.count >= 2 && opener.count >= 2) {
      opener.count -= 2;
      d.count -= 2;
      opener.open2++;
      d.close2++;
    } else {
      opener.count--;
      d.count--;
      opener.open1++;
      d.close1++;
    }
    stack.length = opener.count > 0 ? k + 1 : k;
    for (let c = 0; c < 6; c++) if (floor[c]! > stack.length) floor[c] = stack.length;
  }
  if (d.canOpen && d.count > 0) stack.push(d);
}

// ---------------------------------------------------------------------- runs

interface Builder {
  runs: Run[];
  /** the text of the run being built, joined when its style ends */
  parts: string[];
  flags: number;
  href: string | undefined;
  /** the last text added, for what a soft break sits after */
  last: string;
}

function finishRun(b: Builder): void {
  if (b.parts.length === 0) return;
  const run: Run = { text: b.parts.length === 1 ? b.parts[0]! : b.parts.join("") };
  if (b.flags & BOLD) run.bold = true;
  if (b.flags & ITALIC) run.italic = true;
  if (b.flags & MONO) run.code = true;
  if (b.flags & STRIKE) run.strike = true;
  if (b.href !== undefined) run.href = b.href;
  b.runs.push(run);
  b.parts = [];
}

function add(b: Builder, text: string, flags: number, href: string | undefined): void {
  if (text.length === 0) return;
  if (b.parts.length > 0 && (flags !== b.flags || href !== b.href)) finishRun(b);
  b.flags = flags;
  b.href = href;
  b.parts.push(text);
  b.last = text;
}

/** Whether the soft break before pieces[from] is a space: not at either end
 *  of the text, not beside a hard break, and not between two CJK characters. */
function softSpace(last: string, pieces: Piece[], from: number): boolean {
  if (last === "" || isSpace(last.charCodeAt(last.length - 1))) return false;
  for (let k = from; k < pieces.length; k++) {
    const p = pieces[k]!;
    if (p.kind === SOFT) return false; // that one decides
    if (p.kind === DELIM && p.delim!.count > 0) return true;
    if (p.text !== "") return p.text.charCodeAt(0) !== NEWLINE && !(endsCjk(last) && startsCjk(p.text));
  }
  return false;
}

/** The pieces as runs. A delimiter's closings take effect before its
 *  leftover characters and its openings after them: the leftover is outside
 *  the spans the run made. Inside a link the link's destination wins over a
 *  bare URL's own. */
function buildRuns(pieces: Piece[]): Run[] {
  const b: Builder = { runs: [], parts: [], flags: 0, href: undefined, last: "" };
  let bold = 0;
  let italic = 0;
  let strike = 0;
  let links = 0;
  let link: string | undefined;
  for (let k = 0; k < pieces.length; k++) {
    const p = pieces[k]!;
    const d = p.delim;
    if (d !== undefined) {
      if (d.ch === TILDE) strike -= d.close2;
      else {
        bold -= d.close2;
        italic -= d.close1;
      }
    }
    const flags = (bold > 0 ? BOLD : 0) | (italic > 0 ? ITALIC : 0) | (strike > 0 ? STRIKE : 0);
    if (p.kind === OPEN) {
      if (links++ === 0) link = p.href;
    } else if (p.kind === CLOSE) {
      if (--links === 0) link = undefined;
    } else if (p.kind === SOFT) {
      if (softSpace(b.last, pieces, k + 1)) add(b, " ", flags, link);
    } else if (d !== undefined) {
      if (d.count > 0) add(b, String.fromCharCode(d.ch).repeat(d.count), flags, link);
      if (d.ch === TILDE) strike += d.open2;
      else {
        bold += d.open2;
        italic += d.open1;
      }
    } else add(b, p.text, p.kind === CODE ? flags | MONO : flags, link ?? p.href);
  }
  finishRun(b);
  return b.runs;
}

// ---------------------------------------------------------------- plain text

/** The plain text of runs (for measuring, copying, and a plain-content fallback). */
export function runsText(runs: readonly Run[]): string {
  if (runs.length === 1) return runs[0]!.text;
  let text = "";
  for (let i = 0; i < runs.length; i++) text += runs[i]!.text;
  return text;
}

/** A block list as plain text: what a device that draws no rich content
 *  shows. Lists keep their markers, code keeps its lines, tables become
 *  "a | b" lines. A blank line separates blocks, except inside a list item. */
export function plainText(blocks: readonly Block[]): string {
  const out: string[] = [];
  writeBlocks(blocks, out, true);
  return out.join("\n");
}

function writeBlocks(blocks: readonly Block[], out: string[], spaced: boolean): void {
  for (let i = 0; i < blocks.length; i++) {
    if (spaced && i > 0) out.push("");
    writeBlock(blocks[i]!, out);
  }
}

function writeLines(text: string, out: string[]): void {
  if (text.indexOf("\n") < 0) out.push(text);
  else for (const line of text.split("\n")) out.push(line);
}

function rowText(row: readonly Run[][]): string {
  const cells: string[] = [];
  for (let i = 0; i < row.length; i++) cells.push(runsText(row[i]!).split("\n").join(" "));
  return cells.join(" | ");
}

function writeBlock(block: Block, out: string[]): void {
  switch (block.t) {
    case "p":
    case "h":
      return writeLines(runsText(block.runs), out);
    case "code":
      return writeLines(block.text, out);
    case "hr":
      out.push("---");
      return;
    case "quote": {
      const inner: string[] = [];
      writeBlocks(block.blocks, inner, true);
      for (let i = 0; i < inner.length; i++) out.push(inner[i] === "" ? ">" : "> " + inner[i]);
      return;
    }
    case "list":
      for (let i = 0; i < block.items.length; i++) writeItem(block.items[i]!, block.ordered ? block.start + i + ". " : "- ", out);
      return;
    case "table":
      out.push(rowText(block.head));
      for (let i = 0; i < block.rows.length; i++) out.push(rowText(block.rows[i]!));
      return;
  }
}

/** An item: its marker before its first line, the rest indented under it. */
function writeItem(item: ListItem, marker: string, out: string[]): void {
  const inner: string[] = [];
  writeBlocks(item.blocks, inner, false);
  const box = item.checked === undefined ? "" : item.checked ? "[x] " : "[ ] ";
  const pad = " ".repeat(marker.length);
  out.push((marker + box + (inner[0] ?? "")).trimEnd());
  for (let i = 1; i < inner.length; i++) out.push(inner[i] === "" ? "" : pad + inner[i]);
}
