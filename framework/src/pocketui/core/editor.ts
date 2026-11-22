// PocketUI core/editor.ts — the model of a text composer: a string, mention
// tokens over it, a caret and a selection, an IME preedit, and undo.
//
// PocketJS has no native text field: the host sends decoded text events
// (committed characters, named keys, IME preedit updates) and draws whatever
// the application draws. So every editing rule lives here, in a model with no
// rendering and no dependency. A view lays out `snapshot().text`, draws the
// caret and the token ranges, and feeds the events in.
//
// The document is one string plus token ranges over it (UTF-16 offsets,
// sorted, never overlapping). A token is atomic: the caret never rests
// inside one, stepping crosses it as one unit, and an edit that touches part
// of it takes all of it. Stepping and deleting otherwise move by a cluster:
// a code point with the marks that follow it (combining accents, variation
// selectors, skin tones), sequences joined by U+200D, and a pair of regional
// indicators. QuickJS has no Intl.Segmenter, and these few rules cover what
// people type.
//
// While an IME composes, the preedit is spliced into `text` so the view lays
// out one string, and the document as it was before the composition is kept
// aside. Ending the composition puts that document back; a commit puts it
// back and then inserts as typing does. So the two orders a host may send
// (commit then end, end then commit) give the same text, the preedit never
// reaches `value()` or the history, and `maxLength` counts what is sent.
//
// History is a stack of whole documents. That is cheap here: strings and
// token arrays are immutable and shared between steps, and a composer holds
// a few hundred characters. A run of typed characters is one step, as is a
// run of deletions in one direction.
//
// Two choices where an offset is ambiguous. `select()` snaps an offset
// inside a token to the nearer edge, while an edit over a range grows the
// range to whole tokens. And where a wrapped line ends at the offset the
// next line starts at, that offset belongs to the next line, so End stops
// one character short of it and stays on the line it was pressed on.

export interface Token {
  start: number;
  end: number;
  kind: string;
  id: string;
}

export interface Selection {
  anchor: number;
  focus: number;
}

export interface Composition {
  start: number;
  end: number;
  caret: number;
}

export interface EditorSnapshot {
  text: string;
  tokens: readonly Token[];
  selection: Selection;
  composition: Composition | null;
}

export interface EditorLayout {
  lines: readonly { start: number; end: number }[];
  x(offset: number): number;
  offsetAt(line: number, x: number): number;
}

export interface EditorOptions {
  /** in UTF-16 units; inserts are truncated to fit, never splitting a surrogate pair */
  maxLength?: number;
  /** "\n" in inserted text becomes a space; Enter is never a newline */
  singleLine?: boolean;
  /** Visual lines for ArrowUp/ArrowDown/Home/End: [start,end) offsets of each
   *  drawn line, in order, covering the text; and the x of an offset within
   *  its line. Without it, lines are the "\n"-separated ones and x is the
   *  offset within the line. */
  layout?: () => EditorLayout;
  onChange?: (snapshot: EditorSnapshot, change: { text: boolean; selection: boolean }) => void;
}

export interface Editor {
  snapshot(): EditorSnapshot;
  /** text without any active preedit, and the tokens shifted accordingly: what gets sent */
  value(): { text: string; tokens: Token[] };
  /** resets selection to the end and clears history */
  setValue(text: string, tokens?: readonly Token[]): void;
  isEmpty(): boolean;
  /** replaces the selection; ends in one undo step per typing run */
  insert(text: string): void;
  /** inserts the label as an atomic token (replacing `replace`, e.g. the
   *  "@que" being completed) followed by one space, caret after the space */
  insertToken(token: { kind: string; id: string; label: string }, replace?: { start: number; end: number }): void;
  compose(text: string, selectionStart: number, selectionEnd: number): void;
  endComposition(): void;
  /** returns true when the key was an editing key this handled; Enter returns
   *  false when `singleLine` (the caller submits), Shift+Enter/Alt+Enter
   *  always insert a newline in multi-line; plain Enter inserts a newline
   *  unless `enterSubmits` */
  key(key: string, options?: { enterSubmits?: boolean }): boolean;
  /** clamped; never lands inside a token or a surrogate pair (snaps to the nearer edge) */
  select(anchor: number, focus?: number): void;
  selectAll(): void;
  selectedText(): string;
  undo(): boolean;
  redo(): boolean;
  /** the trigger the caret is completing: `char` is one of `chars`, `query`
   *  the text typed after it up to the caret. Present when the trigger char
   *  starts the text or follows whitespace, an opening bracket/quote, or a
   *  CJK character, the query has no whitespace and is at most `maxQuery`
   *  (default 32) units long, the caret is not inside a token, and no
   *  composition is active. */
  trigger(chars: readonly string[], maxQuery?: number): { char: string; start: number; end: number; query: string } | null;
}

const HISTORY = 100;
const ZWJ = 0x200d;
const NO_TOKENS: readonly Token[] = [];

// what the last edit was, so the next one knows whether it continues it
const RUN_NONE = 0;
const RUN_TYPING = 1;
const RUN_BACKWARD = 2;
const RUN_FORWARD = 3;

const SPACE = 0;
const WORD = 1;
const CJK = 2;
const OTHER = 3;

// ( [ { < " ' ` and the curly and angle quotes that open
const OPENING = new Set([0x28, 0x5b, 0x7b, 0x3c, 0x22, 0x27, 0x60, 0x201c, 0x2018, 0xab, 0x2039]);

/** One document: what a history step and a suspended composition hold. */
interface Step {
  text: string;
  tokens: readonly Token[];
  anchor: number;
  focus: number;
}

// ---- characters -----------------------------------------------------------

function isHigh(c: number): boolean {
  return c >= 0xd800 && c <= 0xdbff;
}

function isLow(c: number): boolean {
  return c >= 0xdc00 && c <= 0xdfff;
}

/** The code point that starts at `at`; a lone surrogate reads as itself. */
function codeAt(text: string, at: number): number {
  const c = text.charCodeAt(at);
  if (isHigh(c) && at + 1 < text.length) {
    const d = text.charCodeAt(at + 1);
    if (isLow(d)) return (c - 0xd800) * 0x400 + (d - 0xdc00) + 0x10000;
  }
  return c;
}

/** The code point that ends at `at`. */
function codeBefore(text: string, at: number): number {
  const d = text.charCodeAt(at - 1);
  if (isLow(d) && at >= 2) {
    const c = text.charCodeAt(at - 2);
    if (isHigh(c)) return (c - 0xd800) * 0x400 + (d - 0xdc00) + 0x10000;
  }
  return d;
}

function units(cp: number): number {
  return cp >= 0x10000 ? 2 : 1;
}

/** `at` is between the two halves of a surrogate pair. */
function splitsPair(text: string, at: number): boolean {
  return at > 0 && at < text.length && isHigh(text.charCodeAt(at - 1)) && isLow(text.charCodeAt(at));
}

function isSpace(cp: number): boolean {
  if (cp <= 0x20) return cp === 0x20 || (cp >= 0x09 && cp <= 0x0d);
  if (cp < 0xa0) return cp === 0x85;
  return cp === 0xa0 || cp === 0x3000 || cp === 0x1680 || (cp >= 0x2000 && cp <= 0x200a) || cp === 0x2028 || cp === 0x2029 || cp === 0x202f || cp === 0x205f;
}

/** A mark that belongs to the character before it: combining accents,
 *  enclosing marks (the keycap), variation selectors, skin tones. */
function isExtender(cp: number): boolean {
  return (cp >= 0x300 && cp <= 0x36f) || (cp >= 0x20d0 && cp <= 0x20ff) || (cp >= 0xfe00 && cp <= 0xfe0f) || (cp >= 0x1f3fb && cp <= 0x1f3ff);
}

function isRegional(cp: number): boolean {
  return cp >= 0x1f1e6 && cp <= 0x1f1ff;
}

/** Where the cluster that starts at `at` ends. */
function clusterEnd(text: string, at: number): number {
  const n = text.length;
  if (at >= n) return n;
  const first = codeAt(text, at);
  let end = at + units(first);
  if (first === 0x0a) return end;
  if (first === 0x0d) return end < n && text.charCodeAt(end) === 0x0a ? end + 1 : end;
  if (isRegional(first) && end < n && isRegional(codeAt(text, end))) end += 2;
  while (end < n) {
    const cp = codeAt(text, end);
    if (isExtender(cp)) end += units(cp);
    else if (cp === ZWJ) {
      // the joiner takes the character after it, whatever that is
      end++;
      if (end < n) {
        const joined = codeAt(text, end);
        if (joined > 0x20) end += units(joined);
      }
    } else break;
  }
  return end;
}

/** Where the cluster that ends at (or contains) `at` starts. Clusters are
 *  defined forwards, so this backs up to an offset that is certainly a
 *  boundary and walks forward from it: the two directions cannot disagree. */
function clusterStart(text: string, at: number): number {
  if (at <= 0) return 0;
  let safe = at - units(codeBefore(text, at));
  while (safe > 0) {
    const cp = codeAt(text, safe);
    const before = codeBefore(text, safe);
    const joins = isExtender(cp) || cp === ZWJ || isRegional(cp) || before === ZWJ || isRegional(before) || before === 0x0d;
    if (!joins) break;
    safe -= units(before);
  }
  let start = safe;
  for (;;) {
    const next = clusterEnd(text, start);
    if (next >= at) return start;
    start = next;
  }
}

/** What a character is to word motion. Letters of any script run together;
 *  a han character or a kana is a word by itself, there being no dictionary
 *  here to say where a Chinese word ends. */
function unitClass(cp: number): number {
  if (isSpace(cp)) return SPACE;
  if (cp < 0x80) return (cp >= 0x30 && cp <= 0x39) || (cp >= 0x41 && cp <= 0x5a) || (cp >= 0x61 && cp <= 0x7a) || cp === 0x5f ? WORD : OTHER;
  if (cp < 0xc0) return cp === 0xaa || cp === 0xb5 || cp === 0xba ? WORD : OTHER;
  if (cp < 0x2000) return cp === 0xd7 || cp === 0xf7 ? OTHER : WORD;
  if (cp < 0x2e80) return cp >= 0x2c00 && cp < 0x2e00 ? WORD : OTHER;
  if (cp < 0xa000) return cp >= 0x3000 && cp < 0x3040 ? OTHER : CJK;
  if (cp < 0xe000) return WORD;
  if (cp < 0xf900) return OTHER;
  if (cp < 0xfb00) return CJK;
  if (cp < 0xfe00) return WORD;
  if (cp < 0xff00) return cp >= 0xfe70 ? WORD : OTHER;
  if (cp < 0x10000) {
    if ((cp >= 0xff10 && cp <= 0xff19) || (cp >= 0xff21 && cp <= 0xff3a) || (cp >= 0xff41 && cp <= 0xff5a) || (cp >= 0xffa0 && cp <= 0xffdc)) return WORD;
    return cp >= 0xff66 && cp <= 0xff9f ? CJK : OTHER;
  }
  if (cp >= 0x20000 && cp < 0x40000) return CJK;
  if (cp >= 0x1f000 && cp < 0x1fb00) return OTHER;
  return WORD;
}

// ---- tokens ---------------------------------------------------------------

/** The token `offset` is strictly inside, or -1. */
function tokenAround(tokens: readonly Token[], offset: number): number {
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i]!;
    if (token.start >= offset) break;
    if (offset < token.end) return i;
  }
  return -1;
}

/** The first token that starts at or after `offset`; `tokens.length` when none does. */
function tokenFrom(tokens: readonly Token[], offset: number): number {
  let i = 0;
  while (i < tokens.length && tokens[i]!.start < offset) i++;
  return i;
}

/** The last token that ends at or before `offset`, or -1. */
function tokenUpTo(tokens: readonly Token[], offset: number): number {
  let i = tokens.length - 1;
  while (i >= 0 && tokens[i]!.end > offset) i--;
  return i;
}

/** `offset` moved back off the inside of a token or a surrogate pair. */
function edgeBefore(text: string, tokens: readonly Token[], offset: number): number {
  const i = tokenAround(tokens, offset);
  if (i >= 0) return tokens[i]!.start;
  return splitsPair(text, offset) ? offset - 1 : offset;
}

/** `offset` moved forward off the inside of a token or a surrogate pair. */
function edgeAfter(text: string, tokens: readonly Token[], offset: number): number {
  const i = tokenAround(tokens, offset);
  if (i >= 0) return tokens[i]!.end;
  return splitsPair(text, offset) ? offset + 1 : offset;
}

/** The tokens after [start, end) became `added` units, with `placed` put at
 *  `start`. The range holds whole tokens only. A token that ends at `start`
 *  stays and one that starts at `end` shifts, so text put at a token's edge
 *  is never part of it. Returns `tokens` itself when nothing moved. */
function shiftTokens(tokens: readonly Token[], start: number, end: number, added: number, placed: Token | null): readonly Token[] {
  const delta = added - (end - start);
  let kept = 0;
  while (kept < tokens.length && tokens[kept]!.end <= start) kept++;
  let rest = kept;
  while (rest < tokens.length && tokens[rest]!.start < end) rest++;
  if (placed === null && kept === rest && (delta === 0 || rest === tokens.length)) return tokens;
  const out: Token[] = [];
  for (let i = 0; i < kept; i++) out.push(tokens[i]!);
  if (placed !== null) out.push(placed);
  for (let i = rest; i < tokens.length; i++) {
    const token = tokens[i]!;
    out.push(delta === 0 ? token : { start: token.start + delta, end: token.end + delta, kind: token.kind, id: token.id });
  }
  return out.length === 0 ? NO_TOKENS : out;
}

function sameTokens(a: readonly Token[], b: readonly Token[]): boolean {
  if (a === b) return true;
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    const x = a[i]!;
    const y = b[i]!;
    if (x.start !== y.start || x.end !== y.end || x.kind !== y.kind || x.id !== y.id) return false;
  }
  return true;
}

function copyTokens(tokens: readonly Token[]): Token[] {
  const out: Token[] = [];
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i]!;
    out.push({ start: token.start, end: token.end, kind: token.kind, id: token.id });
  }
  return out;
}

/** The tokens of `given` that are ranges of `text`, sorted, as copies. One
 *  that is empty, out of bounds, cut through a surrogate pair, or overlaps
 *  an earlier one is dropped. */
function validTokens(text: string, given: readonly Token[] | undefined): readonly Token[] {
  if (given === undefined || given.length === 0) return NO_TOKENS;
  const sorted: Token[] = [];
  for (let i = 0; i < given.length; i++) {
    const token = given[i];
    if (token === null || typeof token !== "object") continue;
    const { start, end, kind, id } = token;
    if (!Number.isInteger(start) || !Number.isInteger(end) || typeof kind !== "string" || typeof id !== "string") continue;
    if (start < 0 || end > text.length || start >= end || splitsPair(text, start) || splitsPair(text, end)) continue;
    let at = sorted.length;
    while (at > 0 && sorted[at - 1]!.start > start) at--;
    sorted.splice(at, 0, { start, end, kind, id });
  }
  const out: Token[] = [];
  let free = 0;
  for (let i = 0; i < sorted.length; i++) {
    const token = sorted[i]!;
    if (token.start < free) continue;
    out.push(token);
    free = token.end;
  }
  return out.length === 0 ? NO_TOKENS : out;
}

// ---- lines ----------------------------------------------------------------

/** The line `offset` is on: the last one that starts at or before it. */
function lineOf(lines: readonly { start: number; end: number }[], offset: number): number {
  let i = lines.length - 1;
  while (i > 0 && lines[i]!.start > offset) i--;
  return i;
}

/** The layout of unwrapped text: one line per "\n", x counted in units. */
function plainLayout(text: string): EditorLayout {
  const lines: { start: number; end: number }[] = [];
  let start = 0;
  for (;;) {
    const stop = text.indexOf("\n", start);
    if (stop < 0) break;
    lines.push({ start, end: stop });
    start = stop + 1;
  }
  lines.push({ start, end: text.length });
  return {
    lines,
    x: (offset) => offset - lines[lineOf(lines, offset)]!.start,
    offsetAt: (line, x) => Math.min(lines[line]!.start + Math.max(0, Math.round(x)), lines[line]!.end),
  };
}

// ---- the editor -----------------------------------------------------------

export function createEditor(options: EditorOptions = {}): Editor {
  const maxLength = options.maxLength !== undefined && options.maxLength >= 0 ? Math.floor(options.maxLength) : Infinity;
  const singleLine = options.singleLine === true;

  let text = "";
  let tokens: readonly Token[] = NO_TOKENS;
  let anchor = 0;
  let focus = 0;

  // the document the preedit was put into, and where the preedit is in `text`
  let base: Step | null = null;
  let preStart = -1;
  let preEnd = -1;

  const undoStack: Step[] = [];
  const redoStack: Step[] = [];
  let run = RUN_NONE;
  let runSpace = false; // the typing run's last character was a space

  // the x vertical moves aim for; `heldGoal` is the one the call started with
  let goal: number | null = null;
  let heldGoal: number | null = null;

  // the state a public call started from, to tell what it changed
  let wasText = text;
  let wasTokens = tokens;
  let wasAnchor = 0;
  let wasFocus = 0;
  let wasPreStart = -1;
  let wasPreEnd = -1;
  let cached: EditorSnapshot | null = null;

  function begin(): void {
    wasText = text;
    wasTokens = tokens;
    wasAnchor = anchor;
    wasFocus = focus;
    wasPreStart = preStart;
    wasPreEnd = preEnd;
    heldGoal = goal;
    goal = null;
  }

  function finish(): void {
    const textChanged = text !== wasText || !sameTokens(tokens, wasTokens);
    const selectionChanged = anchor !== wasAnchor || focus !== wasFocus || preStart !== wasPreStart || preEnd !== wasPreEnd;
    if (!textChanged && !selectionChanged) return;
    cached = null;
    if (options.onChange) options.onChange(snapshot(), { text: textChanged, selection: selectionChanged });
  }

  function snapshot(): EditorSnapshot {
    if (cached === null) {
      const composition = base === null ? null : { start: preStart, end: preEnd, caret: focus };
      cached = { text, tokens, selection: { anchor, focus }, composition };
    }
    return cached;
  }

  // ---- history ----

  function here(): Step {
    return { text, tokens, anchor, focus };
  }

  function restore(step: Step): void {
    text = step.text;
    tokens = step.tokens;
    anchor = step.anchor;
    focus = step.focus;
  }

  /** The document as it is becomes an undo step: called before an edit. */
  function record(): void {
    undoStack.push(here());
    if (undoStack.length > HISTORY) undoStack.shift();
    redoStack.length = 0;
  }

  function stepBack(): boolean {
    run = RUN_NONE;
    const step = undoStack.pop();
    if (step === undefined) return false;
    redoStack.push(here());
    restore(step);
    return true;
  }

  function stepForward(): boolean {
    run = RUN_NONE;
    const step = redoStack.pop();
    if (step === undefined) return false;
    undoStack.push(here());
    restore(step);
    return true;
  }

  // ---- edits ----

  /** Takes the preedit out: the document is as it was before the composition. */
  function dropPreedit(): void {
    if (base === null) return;
    restore(base);
    base = null;
    preStart = -1;
    preEnd = -1;
  }

  /** text[start, end) becomes `added`; the range holds whole tokens only. */
  function splice(start: number, end: number, added: string, placed: Token | null): void {
    tokens = shiftTokens(tokens, start, end, added.length, placed);
    text = text.slice(0, start) + added + text.slice(end);
  }

  function flat(input: string): string {
    return singleLine && input.indexOf("\n") >= 0 ? input.replace(/\n/g, " ") : input;
  }

  /** `input` as it may enter the text: "\r\n" and "\r" are "\n". */
  function clean(input: string): string {
    return flat(input.indexOf("\r") >= 0 ? input.replace(/\r\n?/g, "\n") : input);
  }

  /** The prefix of `added` that fits in `room` units. */
  function fit(added: string, room: number): string {
    if (added.length <= room) return added;
    let cut = room > 0 ? room : 0;
    if (cut > 0 && isHigh(added.charCodeAt(cut - 1)) && isLow(added.charCodeAt(cut))) cut--;
    return added.slice(0, cut);
  }

  function put(input: string): void {
    const start = Math.min(anchor, focus);
    const end = Math.max(anchor, focus);
    const added = fit(clean(input), maxLength - (text.length - (end - start)));
    if (added.length === 0 && start === end) return;
    const single = added.length > 0 && clusterEnd(added, 0) === added.length;
    const space = single && isSpace(added.charCodeAt(0));
    // a newline, or the first space after a word, starts the next step
    const opens = added === "\n" || (space && !runSpace);
    if (run !== RUN_TYPING || !single || start !== end || opens) record();
    splice(start, end, added, null);
    anchor = focus = start + added.length;
    run = single ? RUN_TYPING : RUN_NONE;
    runSpace = space;
  }

  /** Deletes [start, end). `kind` is the run it belongs to, RUN_NONE for a
   *  deletion that stands alone (a selection). */
  function erase(start: number, end: number, kind: number): void {
    if (start === end) return;
    if (kind === RUN_NONE || run !== kind) record();
    splice(start, end, "", null);
    anchor = focus = start;
    run = kind;
  }

  function eraseBackward(word: boolean): void {
    if (anchor !== focus) erase(Math.min(anchor, focus), Math.max(anchor, focus), RUN_NONE);
    else erase(word ? wordLeft(focus) : left(focus), focus, RUN_BACKWARD);
  }

  function eraseForward(word: boolean): void {
    if (anchor !== focus) erase(Math.min(anchor, focus), Math.max(anchor, focus), RUN_NONE);
    else erase(focus, word ? wordRight(focus) : right(focus), RUN_FORWARD);
  }

  // ---- positions ----

  /** Any number as an offset into the text. */
  function clamp(offset: number): number {
    if (!(offset > 0)) return 0;
    return offset >= text.length ? text.length : Math.floor(offset);
  }

  /** Any number as a caret position: clamped, and off the inside of a token
   *  (to its nearer edge) or a surrogate pair. */
  function settle(offset: number): number {
    const at = clamp(offset);
    const i = tokenAround(tokens, at);
    if (i >= 0) {
      const token = tokens[i]!;
      return at - token.start < token.end - at ? token.start : token.end;
    }
    return splitsPair(text, at) ? at - 1 : at;
  }

  /** One step right: a token or a cluster. */
  function right(at: number): number {
    if (at >= text.length) return text.length;
    const i = tokenFrom(tokens, at);
    const end = clusterEnd(text, at);
    if (i === tokens.length) return end;
    const token = tokens[i]!;
    if (token.start === at) return token.end;
    return token.start < end ? token.start : end;
  }

  /** One step left. */
  function left(at: number): number {
    if (at <= 0) return 0;
    const i = tokenUpTo(tokens, at);
    const start = clusterStart(text, at);
    if (i < 0) return start;
    const token = tokens[i]!;
    if (token.end === at) return token.start;
    return token.end > start ? token.end : start;
  }

  /** Past the spaces, then to the end of the word, the token, the one han
   *  character or the run of punctuation that follows. */
  function wordRight(at: number): number {
    const i = tokenFrom(tokens, at);
    const stop = i < tokens.length ? tokens[i]!.start : text.length;
    let p = at;
    while (p < stop && unitClass(codeAt(text, p)) === SPACE) p = Math.min(clusterEnd(text, p), stop);
    if (p >= stop) return i < tokens.length ? tokens[i]!.end : stop;
    const kind = unitClass(codeAt(text, p));
    p = Math.min(clusterEnd(text, p), stop);
    if (kind === CJK) return p;
    while (p < stop && unitClass(codeAt(text, p)) === kind) p = Math.min(clusterEnd(text, p), stop);
    return p;
  }

  function wordLeft(at: number): number {
    const i = tokenUpTo(tokens, at);
    const stop = i >= 0 ? tokens[i]!.end : 0;
    let p = at;
    while (p > stop && unitClass(codeBefore(text, p)) === SPACE) p = Math.max(clusterStart(text, p), stop);
    if (p <= stop) return i >= 0 ? tokens[i]!.start : stop;
    p = Math.max(clusterStart(text, p), stop);
    const kind = unitClass(codeAt(text, p));
    if (kind === CJK) return p;
    while (p > stop) {
      const start = Math.max(clusterStart(text, p), stop);
      if (unitClass(codeAt(text, start)) !== kind) break;
      p = start;
    }
    return p;
  }

  function move(to: number, extend: boolean): void {
    focus = to;
    if (!extend) anchor = to;
    run = RUN_NONE;
  }

  // ---- lines ----

  function layout(): EditorLayout {
    const given = options.layout ? options.layout() : null;
    return given !== null && given.lines.length > 0 ? given : plainLayout(text);
  }

  /** The last offset that is on line `k` and no other. */
  function lineLast(lines: readonly { start: number; end: number }[], k: number): number {
    const line = lines[k]!;
    const end = Math.min(line.end, text.length);
    if (k + 1 < lines.length && lines[k + 1]!.start <= end && end > line.start) return Math.max(line.start, left(end));
    return end;
  }

  function lineEdge(end: boolean): number {
    const lines = layout().lines;
    const k = lineOf(lines, focus);
    if (end) return edgeAfter(text, tokens, lineLast(lines, k));
    return edgeBefore(text, tokens, Math.min(Math.max(lines[k]!.start, 0), text.length));
  }

  function vertical(down: boolean, extend: boolean): void {
    const map = layout();
    const lines = map.lines;
    const k = lineOf(lines, focus);
    const x = heldGoal !== null ? heldGoal : map.x(focus);
    let to: number;
    if (down ? k >= lines.length - 1 : k <= 0) to = down ? text.length : 0;
    else {
      const next = down ? k + 1 : k - 1;
      const first = lines[next]!.start;
      const last = lineLast(lines, next);
      const raw = Math.min(Math.max(map.offsetAt(next, x), first), last);
      to = settle(raw);
      // a token wrapped over both lines: take the edge that makes progress
      if (down ? to <= focus : to >= focus) to = down ? edgeAfter(text, tokens, clamp(raw)) : edgeBefore(text, tokens, clamp(raw));
    }
    move(to, extend);
    goal = x;
  }

  // ---- keys ----

  function press(name: string, control: boolean, alt: boolean, shift: boolean, enterSubmits: boolean): boolean {
    const word = control || alt;
    switch (name) {
      case "Enter":
        if (singleLine || control) return false;
        if (enterSubmits && !shift && !alt) return false;
        put("\n");
        return true;
      case "Backspace":
        eraseBackward(word);
        return true;
      case "Delete":
        eraseForward(word);
        return true;
      case "ArrowLeft":
        if (word) move(wordLeft(focus), shift);
        else if (!shift && anchor !== focus) move(Math.min(anchor, focus), false);
        else move(left(focus), shift);
        return true;
      case "ArrowRight":
        if (word) move(wordRight(focus), shift);
        else if (!shift && anchor !== focus) move(Math.max(anchor, focus), false);
        else move(right(focus), shift);
        return true;
      case "ArrowUp":
      case "ArrowDown":
        if (word) return false;
        vertical(name === "ArrowDown", shift);
        return true;
      case "Home":
        if (alt) return false;
        move(control ? 0 : lineEdge(false), shift);
        return true;
      case "End":
        if (alt) return false;
        move(control ? text.length : lineEdge(true), shift);
        return true;
    }
    if (!control || alt || name.length !== 1) return false;
    const letter = name.charCodeAt(0) | 0x20;
    if (letter === 0x61 && !shift) {
      anchor = 0;
      focus = text.length;
      run = RUN_NONE;
      return true;
    }
    if (letter === 0x7a) {
      if (shift) stepForward();
      else stepBack();
      return true;
    }
    if (letter === 0x79 && !shift) {
      stepForward();
      return true;
    }
    return false;
  }

  function key(name: string, keyOptions?: { enterSubmits?: boolean }): boolean {
    // the IME owns the keys while it composes
    if (base !== null) {
      if (name !== "Escape") return false;
      endComposition();
      return true;
    }
    // held modifiers come first, in the order Control, Alt, Shift, Meta
    let at = 0;
    let control = false;
    let alt = false;
    let shift = false;
    if (name.startsWith("Control+") && name.length > 8) {
      control = true;
      at = 8;
    }
    if (name.startsWith("Alt+", at) && name.length > at + 4) {
      alt = true;
      at += 4;
    }
    if (name.startsWith("Shift+", at) && name.length > at + 6) {
      shift = true;
      at += 6;
    }
    // a chord with Meta is the window manager's or the application's
    if (name.startsWith("Meta+", at) && name.length > at + 5) return false;
    begin();
    const handled = press(at === 0 ? name : name.slice(at), control, alt, shift, keyOptions !== undefined && keyOptions.enterSubmits === true);
    if (!handled) goal = heldGoal;
    finish();
    return handled;
  }

  // ---- the public surface ----

  function value(): { text: string; tokens: Token[] } {
    return base === null ? { text, tokens: copyTokens(tokens) } : { text: base.text, tokens: copyTokens(base.tokens) };
  }

  function setValue(next: string, given?: readonly Token[]): void {
    begin();
    base = null;
    preStart = -1;
    preEnd = -1;
    const fitted = fit(flat(next), maxLength);
    const valid = validTokens(fitted, given);
    text = fitted;
    if (!sameTokens(valid, tokens)) tokens = valid;
    anchor = focus = text.length;
    undoStack.length = 0;
    redoStack.length = 0;
    run = RUN_NONE;
    finish();
  }

  function isEmpty(): boolean {
    return (base === null ? text : base.text).length === 0;
  }

  function insert(input: string): void {
    begin();
    dropPreedit();
    put(input);
    finish();
  }

  function insertToken(token: { kind: string; id: string; label: string }, replace?: { start: number; end: number }): void {
    begin();
    dropPreedit();
    run = RUN_NONE;
    let start = Math.min(anchor, focus);
    let end = Math.max(anchor, focus);
    if (replace !== undefined) {
      start = edgeBefore(text, tokens, clamp(Math.min(replace.start, replace.end)));
      end = edgeAfter(text, tokens, clamp(Math.max(replace.start, replace.end)));
    }
    const label = flat(token.label);
    const room = maxLength - (text.length - (end - start));
    // a label that does not fit is not cut: half a mention names nothing
    if (label.length > 0 && label.length <= room) {
      const added = label.length < room ? label + " " : label;
      record();
      splice(start, end, added, { start, end: start + label.length, kind: token.kind, id: token.id });
      anchor = focus = start + added.length;
    }
    finish();
  }

  function compose(input: string, selectionStart: number, selectionEnd: number): void {
    begin();
    if (input.length === 0) dropPreedit();
    else {
      if (base === null) {
        base = here();
        run = RUN_NONE;
      }
      const pre = flat(input);
      const start = Math.min(base.anchor, base.focus);
      const end = Math.max(base.anchor, base.focus);
      tokens = shiftTokens(base.tokens, start, end, pre.length, null);
      text = base.text.slice(0, start) + pre + base.text.slice(end);
      preStart = start;
      preEnd = start + pre.length;
      anchor = start + within(pre, selectionStart);
      focus = start + within(pre, selectionEnd);
    }
    finish();
  }

  /** An offset the IME gave, inside its preedit. */
  function within(pre: string, offset: number): number {
    if (!(offset > 0)) return 0;
    if (offset >= pre.length) return pre.length;
    const at = Math.floor(offset);
    return splitsPair(pre, at) ? at - 1 : at;
  }

  function endComposition(): void {
    begin();
    dropPreedit();
    finish();
  }

  /** An offset into the text with the preedit in it, as an offset into the
   *  document without it. */
  function withoutPreedit(offset: number): number {
    if (base === null || !(offset > preStart)) return offset;
    return offset >= preEnd ? offset - preEnd + Math.max(base.anchor, base.focus) : preStart;
  }

  function select(to: number, focusTo: number = to): void {
    begin();
    const a = withoutPreedit(to);
    const f = withoutPreedit(focusTo);
    dropPreedit();
    anchor = settle(a);
    focus = settle(f);
    run = RUN_NONE;
    finish();
  }

  function selectAll(): void {
    begin();
    dropPreedit();
    anchor = 0;
    focus = text.length;
    run = RUN_NONE;
    finish();
  }

  function selectedText(): string {
    return text.slice(Math.min(anchor, focus), Math.max(anchor, focus));
  }

  function undo(): boolean {
    begin();
    dropPreedit();
    const done = stepBack();
    finish();
    return done;
  }

  function redo(): boolean {
    begin();
    dropPreedit();
    const done = stepForward();
    finish();
    return done;
  }

  /** `at` may open a trigger: nothing before it, or a space, an opening
   *  bracket or quote, or a wide character (han, kana, their punctuation). */
  function opensTrigger(at: number): boolean {
    if (at === 0) return true;
    const cp = codeBefore(text, at);
    return isSpace(cp) || OPENING.has(cp) || cp >= 0x2e80;
  }

  function trigger(chars: readonly string[], maxQuery = 32): { char: string; start: number; end: number; query: string } | null {
    if (base !== null || anchor !== focus) return null;
    // the query cannot reach back into a token
    const i = tokenUpTo(tokens, focus);
    const floor = i >= 0 ? tokens[i]!.end : 0;
    for (let at = focus - 1; at >= floor && focus - at - 1 <= maxQuery; at--) {
      if (isSpace(text.charCodeAt(at))) return null;
      for (let c = 0; c < chars.length; c++) {
        const char = chars[c]!;
        if (char.length === 0 || at + char.length > focus || !text.startsWith(char, at) || !opensTrigger(at)) continue;
        return { char, start: at, end: focus, query: text.slice(at + char.length, focus) };
      }
    }
    return null;
  }

  return { snapshot, value, setValue, isEmpty, insert, insertToken, compose, endComposition, key, select, selectAll, selectedText, undo, redo, trigger };
}
