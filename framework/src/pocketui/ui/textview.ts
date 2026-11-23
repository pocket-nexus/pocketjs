// PocketUI ui/textview.ts — the Text element: a paragraph that wraps to the
// width it is offered and reports the height that takes; and where text in
// any script comes from.
//
// The baked faces hold ASCII. Text outside it is drawn from a run-time face
// (ui/runtimetext.ts) where the device can make one, by run: a wide character
// and a word with a letter outside ASCII are the run-time face's, the rest
// stays in the baked proportional face, so a mixed line is two fonts side by
// side as it is in any modern text stack. What this leaves out on purpose:
// right-to-left text, shaping and joining. A glyph is a codepoint.
//
// A paragraph in one face is one native text node whatever its length: its
// lines are joined with "\n", the only break the core makes
// (engine/core/src/text.rs). A mixed paragraph is a node per run per line.
import { createRenderEffect } from "solid-js";
import { getOps } from "../../host.ts";
import { createElement, createTextNode, detachNode, insertNode, replaceText, setProp, type NodeMirror } from "../../renderer.ts";
import { createBakedFontCoverage } from "../../font-coverage.ts";
import { needsRuntime, splitRuns } from "../core/glyphfont.ts";
import { clampRich, layoutRich } from "../core/rich.ts";
import { cachedMeasure, ellipsize, wrapText, type Measure } from "../core/text.ts";
import { Instance, type BoxProps, type Kind, type Size, type UINode, type UIRoot } from "./engine.ts";
import { FACES, type Face, type TextRole, type Tone } from "./theme.ts";

export interface TextProps extends BoxProps {
  /** the text; children do the same */
  value?: string | number;
  children?: UINode;
  /** the face by its role (default: the part's it is in, else "body"), or a face */
  role?: TextRole | Face;
  /** what it means: the theme and the part it is in give the colour (default "plain") */
  tone?: Tone;
  /** a colour, in place of the tone's */
  color?: string;
  /** at most this many lines, the last cut with an ellipsis */
  lines?: number;
  align?: "left" | "center" | "right";
}

/** Where glyphs outside the baked faces come from (ui/runtimetext.ts). */
export interface TextSource {
  /** The run-time face in that weight, or null where there is none to be had (no companion that draws glyphs, a host that loads no atlas): such text then shows placeholders in the baked face. */
  face(bold: boolean): Face | null;
  /** `text` is about to be drawn in that face. Returns whether every glyph of it is here; the rest are fetched. */
  want(text: string, bold: boolean): boolean;
  /** The width of text in `slot`, when it is one of this source's: from its own table, no call into the host. */
  measure(slot: number): Measure | null;
  /** a signal read: bumps when glyphs load. A text that waits for one reads it. */
  revision(): number;
  /** a signal read: bumps when what a text resolved to may no longer hold though no glyph arrived (the service was lost or found; glyphs are about to be dropped, and every mounted text names its own again). Every text outside ASCII reads it. */
  epoch(): number;
}

/** What text has cost since the realm began, for a benchmark and a debugger:
 *  paragraphs broken into lines (a layout that was not already held), and of
 *  those the ones broken again because glyphs arrived. */
export const textCounters = { layouts: 0, relayouts: 0 };

let source: TextSource | null = null;
export function setTextSource(next: TextSource | null): void {
  source = next;
}

const measures = new Map<number, Measure>();
/** Width of one line of text in a font slot: a run-time face's from its glyph table, a baked one's from the host, remembered per word. */
export function measureIn(slot: number): Measure {
  const own = source?.measure(slot);
  if (own) return own;
  let measure = measures.get(slot);
  if (!measure) {
    measure = cachedMeasure((text) => getOps().measureText(text, slot));
    measures.set(slot, measure);
  }
  return measure;
}

/** Drop what was measured in a slot: its atlas changed. */
export function forgetMeasures(slot: number): void {
  measures.delete(slot);
}

/** What a face resolves a text to: the slot that can draw it now, and whether to lay it out again when glyphs arrive. An application's own source of glyphs, asked when no TextSource is installed. */
export interface FaceResolver {
  resolve(text: string, face: Face): { face: Face; text: string; pending: boolean };
  /** a signal read: bumps when a run-time atlas loads */
  revision(): number;
}

let resolver: FaceResolver | null = null;
export function setFaceResolver(next: FaceResolver | null): void {
  resolver = next;
}

/** Tabs and no-break spaces as the spaces every face holds; and without the
 *  characters that draw nothing by themselves (zero-width spaces and joiners,
 *  variation selectors, a byte-order mark): a glyph is a codepoint here, so
 *  each would otherwise be a missing character's width of nothing. */
const plainSpaces = (value: string): string => (/[\t\u00a0\u200b-\u200d\u2060\ufe00-\ufe0f\ufeff]/.test(value) ? value.replace(/[\u200b-\u200d\u2060\ufe00-\ufe0f\ufeff]/g, "").replace(/\u00a0/g, " ").replace(/\t/g, "  ") : value);

/** Curly quotes, dashes and ellipses as the ASCII the baked faces hold, so
 *  English prose stays in them. */
function plainPunctuation(value: string): string {
  return value.replace(/[\u2018\u2019\u201a\u2032]/g, "'").replace(/[\u201c\u201d\u201e\u2033]/g, '"').replace(/[\u2013\u2014\u2015\u2212]/g, "-").replace(/\u2026/g, "...");
}

/** A signal read that changes when run-time glyphs arrive, or what a text resolved to may no longer hold: for a consumer that resolves outside an effect of its own. */
export function faceRevision(): number {
  return source ? source.revision() + source.epoch() : resolver ? resolver.revision() : 0;
}

/** The characters each baked slot of the pack holds (font-coverage.ts): a
 *  build bakes what the application's literals and the device's button marks
 *  name, so text outside ASCII can still be the baked face's. */
let coverage: ((scalar: string, slot: number) => boolean) | null = null;
function baked(text: string, face: Face): boolean {
  if (!needsRuntime(text)) return true;
  try {
    coverage ??= createBakedFontCoverage();
    for (const scalar of text) if (scalar !== "\n" && !coverage(scalar, face.slot)) return false;
    return true;
  } catch {
    // no pack (a unit test's realm): the baked faces are ASCII's
    return false;
  }
}

/** What stands for characters no face here can draw: a dot each, three for a longer run. */
const placeheld = (text: string): string => text.replace(/[^\x20-\x7e\n]/g, "\u00b7").replace(/\u00b7+/g, (run) => (run.length > 3 ? "\u00b7\u00b7\u00b7" : run));

/** The run-time face for text set in `face`: its weight's, on a line no shorter than the face's own. */
function runtimeFace(face: Face): Face | null {
  const made = source?.face(face.bold === true);
  if (!made) return null;
  return made.line >= face.line ? made : { ...made, line: face.line };
}

/** The ONE face that can draw the whole of `text` now, and the text as that
 *  face draws it: for a consumer that sets a text in a single face (the
 *  editor, a mention token). Text outside ASCII goes whole to the run-time
 *  face, which holds ASCII too. `exact`: the text comes back as it was given
 *  wherever a face can draw it, character for character (an editor's offsets
 *  are the document's); otherwise prose punctuation the baked faces lack is
 *  folded to ASCII when that keeps the text in them. */
export function resolveFace(text: string, face: Face, exact = false): { face: Face; text: string; pending: boolean } {
  if (baked(text, face)) return { face, text: exact ? text : plainSpaces(text), pending: false };
  const spaced = exact ? text : plainSpaces(text);
  const plain = plainPunctuation(spaced);
  if (!exact && baked(plain, face)) return { face, text: plain, pending: false };
  if (source) {
    source.epoch();
    const made = runtimeFace(face);
    if (!made) return { face, text: placeheld(plain), pending: false };
    return { face: made, text: spaced, pending: !source.want(spaced, face.bold === true) };
  }
  if (resolver) {
    resolver.revision();
    return resolver.resolve(plain, face);
  }
  return { face, text: plain.replace(/[^\x00-\x7f]/g, "?"), pending: false };
}

/** A run of a text and the face that draws it. */
export interface TextRun {
  text: string;
  face: Face;
}

export interface ResolvedText {
  runs: readonly TextRun[];
  /** the distance between baselines: the tallest face's among the runs */
  line: number;
  /** some glyph is still on its way: lay out again when the revision moves */
  pending: boolean;
}

/** `text` as runs, each in the face that draws it: ASCII in `face`, the rest
 *  in the run-time face of its weight. A run that is outside ASCII only for
 *  its quotes, dashes or ellipsis ("it's" with a curly apostrophe) is folded
 *  and stays in `face`; beside Chinese the same marks are drawn as they are.
 *  A signal read where glyphs may arrive. */
export function resolveRuns(text: string, face: Face): ResolvedText {
  if (baked(text, face)) {
    const spaced = plainSpaces(text);
    return { runs: spaced.length > 0 ? [{ text: spaced, face }] : [], line: face.line, pending: false };
  }
  const spaced = plainSpaces(text);
  const plain = plainPunctuation(spaced);
  if (baked(plain, face)) return { runs: [{ text: plain, face }], line: face.line, pending: false };
  if (!source) {
    const whole = resolveFace(text, face);
    return { runs: [{ text: whole.text, face: whole.face }], line: Math.max(face.line, whole.face.line), pending: whole.pending };
  }
  source.epoch();
  const made = runtimeFace(face);
  if (!made) return { runs: [{ text: placeheld(plain), face }], line: face.line, pending: false };
  const bold = face.bold === true;
  const runs: TextRun[] = [];
  let pending = false;
  let drawn = false;
  for (const run of splitRuns(spaced)) {
    let value = run.text;
    let runtime = run.runtime;
    if (runtime) {
      const folded = plainPunctuation(value);
      if (!needsRuntime(folded)) {
        value = folded;
        runtime = false;
      }
    }
    if (runtime) {
      drawn = true;
      if (!source.want(value, bold)) pending = true;
    }
    const last = runs[runs.length - 1];
    const use = runtime ? made : face;
    if (last && last.face === use) last.text += value;
    else runs.push({ text: value, face: use });
  }
  return { runs, line: drawn ? Math.max(face.line, made.line) : face.line, pending };
}

function textOf(value: unknown): string {
  if (value == null || value === false || value === true) return "";
  if (typeof value === "function") return textOf((value as () => unknown)());
  if (Array.isArray(value)) {
    let out = "";
    for (const item of value) out += textOf(item);
    return out;
  }
  return String(value);
}

const ALIGN = { left: 0, center: 1, right: 2 } as const;

interface Piece {
  text: string;
  /** index into the instance's runs: the face */
  run: number;
  x: number;
  width: number;
}
interface Row {
  pieces: Piece[];
  width: number;
}
interface Cell {
  node: NodeMirror;
  run: NodeMirror;
  text: string;
  style: Record<string, number | string>;
}

function sameRows(a: readonly Row[], b: readonly Row[]): boolean {
  if (a.length !== b.length) return false;
  for (let r = 0; r < a.length; r++) {
    const left = a[r]!;
    const right = b[r]!;
    if (left.width !== right.width || left.pieces.length !== right.pieces.length) return false;
    for (let p = 0; p < left.pieces.length; p++) {
      const one = left.pieces[p]!;
      const other = right.pieces[p]!;
      if (one.text !== other.text || one.x !== other.x || one.run !== other.run) return false;
    }
  }
  return true;
}

class TextInstance extends Instance {
  /** No source of run-time glyphs when this was made: the element IS the one
   *  native text node, as it has always been, and a text is set whole in one
   *  face. With a source it is a view of text nodes, one per run per line. */
  private readonly flat: boolean;
  private text = "";
  /** the runs and their faces as one string: what the layout depends on; `key` is that and, while a glyph is on its way, the revision */
  private shape = "";
  private key: string | undefined;
  private runs: readonly TextRun[] = [];
  private base: Face = FACES.body;
  private line = 17;
  private maxLines = Infinity;
  private laid: { width: number; rows: Row[] } | null = null;
  private cells: Cell[] = [];
  private color = "";
  private align: 0 | 1 | 2 = 0;
  private pending = false;
  private waited = false;

  constructor(private readonly textProps: TextProps, parent: Instance | null, root: UIRoot) {
    super(textProps, parent, root, source ? "view" : "text");
    this.flat = source === null;
    if (this.flat) {
      const run = createTextNode("");
      insertNode(this.node, run);
      this.cells.push({ node: this.node, run, text: "", style: {} });
    }
    createRenderEffect(() => {
      const props = this.textProps;
      const value = props.value !== undefined ? String(props.value) : textOf(props.children);
      const role = props.role ?? this.roleFor();
      const base = typeof role === "string" ? this.root.theme.face[role] : role;
      const maxLines = props.lines ?? Infinity;
      let resolved: ResolvedText;
      if (this.flat) {
        const whole = resolveFace(value, base);
        resolved = { runs: [{ text: whole.text, face: whole.face }], line: whole.face.line, pending: whole.pending };
      } else resolved = resolveRuns(value, base);
      this.text = value;
      // What the layout depends on. While a glyph is on its way the revision is
      // part of it, so each arrival lays this text out again; once whole it is
      // not, and what arrives for other texts leaves this one alone. A row
      // whose item was republished unchanged measures nothing again.
      let shape = `${maxLines}|${base.slot}/${base.line}|${resolved.line}`;
      for (const run of resolved.runs) shape += `\u0001${run.face.slot}\u0002${run.text}`;
      const key = resolved.pending ? `${faceRevision()}|${shape}` : shape;
      if (key === this.key) return;
      // the same text in the same faces, laid out before with a glyph missing: what changed is that glyphs arrived
      const arrival = this.pending && shape === this.shape;
      const before = this.laid;
      this.waited = arrival;
      this.pending = resolved.pending;
      this.key = key;
      this.shape = shape;
      this.runs = resolved.runs;
      this.base = base;
      this.line = resolved.line;
      this.maxLines = maxLines;
      this.laid = null;
      if (this.flat) setProp(this.node, "style", { fontSlot: resolved.runs[0]!.face.slot, lineHeight: resolved.line });
      // A glyph that arrives as wide as the place kept for it (a CJK glyph is
      // one size wide) moves nothing: the lines are the same, the nodes hold
      // the same text, and the host draws them from the new atlas. Nothing
      // above this text is laid out again.
      if (arrival && before && this.placed && sameRows(before.rows, this.layout(before.width))) return;
      this.invalidate();
    });
    createRenderEffect(() => {
      const props = this.textProps;
      this.color = props.color ?? this.inkFor(props.tone);
      this.align = ALIGN[props.align ?? "left"];
      if (this.flat) setProp(this.node, "style", { textColor: this.color, textAlign: this.align });
      else if (this.placed) this.arrange(this.w);
    });
  }

  private layout(width: number): Row[] {
    const laid = this.laid;
    if (laid && laid.width === width) return laid.rows;
    textCounters.layouts++;
    if (this.waited) {
      textCounters.relayouts++;
      this.waited = false;
    }
    const runs = this.runs;
    let rows: Row[];
    if (runs.length <= 1) {
      // one face: the paragraph's lines, each a piece
      const face = runs[0]?.face ?? this.base;
      const measure = measureIn(face.slot);
      const drawn = runs[0]?.text ?? "";
      if (this.maxLines === 1 && width !== Infinity) {
        const text = ellipsize(drawn, width, measure);
        const w = measure(text);
        rows = [{ pieces: [{ text, run: 0, x: 0, width: w }], width: w }];
      } else rows = wrapText(drawn, width, measure, { maxLines: this.maxLines, ellipsis: "..." }).map((line) => ({ pieces: [{ text: line.text, run: 0, x: 0, width: line.width }], width: line.width }));
    } else {
      // several faces: broken as one paragraph over all its runs (core/rich.ts); the ellipsis is set in the baked face
      const faces = runs.map((run) => run.face);
      const mark = faces.length;
      faces.push(this.base);
      const measure = (text: string, style: number) => measureIn(faces[style]!.slot)(text);
      const spans = runs.map((run, index) => ({ text: run.text, style: index }));
      let lines = layoutRich(spans, width, measure, this.maxLines === Infinity ? Infinity : this.maxLines + 1);
      if (lines.length > this.maxLines) lines = clampRich(lines, this.maxLines, width, measure, mark);
      rows = lines.map((line) => ({ pieces: line.segments.map((segment) => ({ text: segment.text, run: segment.style, x: segment.x, width: segment.width })), width: line.width }));
    }
    this.laid = { width, rows };
    return rows;
  }

  protected measureContent(maxW: number, _maxH: number): Size {
    const pad = this.pad;
    const inner = maxW === Infinity ? Infinity : Math.max(0, maxW - pad.l - pad.r);
    const rows = this.layout(inner);
    let width = 0;
    for (const row of rows) if (row.width > width) width = row.width;
    return { w: Math.ceil(width) + pad.l + pad.r, h: rows.length * this.line + pad.t + pad.b };
  }

  private put(index: number, text: string, style: Record<string, number | string>): void {
    let cell = this.cells[index];
    if (!cell) {
      const node = createElement("text");
      const run = createTextNode("");
      insertNode(node, run);
      insertNode(this.node, node, null);
      cell = { node, run, text: "", style: {} };
      this.cells[index] = cell;
    }
    if (cell.text !== text) {
      replaceText(cell.run, text);
      cell.text = text;
    }
    setProp(cell.node, "style", style, cell.style);
    cell.style = style;
  }

  protected override arrange(w: number, _h?: number): void {
    const pad = this.pad;
    const inner = Math.max(0, w - pad.l - pad.r);
    const rows = this.layout(inner);
    const line = this.line;
    if (this.flat || this.runs.length <= 1) {
      // one node for the paragraph: the core breaks it at "\n" and aligns it in the node's width
      let joined = "";
      for (let i = 0; i < rows.length; i++) joined += i === 0 ? rows[i]!.pieces[0]!.text : `\n${rows[i]!.pieces[0]!.text}`;
      if (this.flat) {
        const cell = this.cells[0]!;
        if (cell.text !== joined) {
          replaceText(cell.run, joined);
          cell.text = joined;
        }
        setProp(this.node, "style", { paddingT: pad.t, paddingL: pad.l, paddingR: pad.r, paddingB: pad.b });
        return;
      }
      const face = this.runs[0]?.face ?? this.base;
      this.put(0, joined, { posType: 1, insetL: pad.l, insetT: pad.t, width: inner, fontSlot: face.slot, lineHeight: line, textColor: this.color, textAlign: this.align });
      this.trim(1);
      return;
    }
    const faces = this.runs.map((run) => run.face);
    let used = 0;
    for (let r = 0; r < rows.length; r++) {
      const row = rows[r]!;
      const shift = this.align === 0 ? 0 : Math.max(0, inner - row.width) * (this.align === 1 ? 0.5 : 1);
      for (const piece of row.pieces) {
        const face = faces[piece.run] ?? this.base;
        this.put(used++, piece.text, {
          posType: 1,
          insetL: Math.round(pad.l + shift + piece.x),
          insetT: pad.t + r * line + Math.floor((line - face.line) / 2),
          fontSlot: face.slot,
          lineHeight: face.line,
          textColor: this.color,
          textAlign: 0,
        });
      }
    }
    this.trim(used);
  }

  /** Drop the nodes a shorter layout no longer uses. */
  private trim(used: number): void {
    for (let i = this.cells.length - 1; i >= used; i--) {
      detachNode(this.node, this.cells[i]!.node);
      this.cells.pop();
    }
  }

  /** The text as given, for tests and the agent. */
  source(): string {
    return this.text;
  }

  override blocksHit(): boolean {
    return this.interactive;
  }
}

export const TEXT: Kind<TextProps> = (props, parent, root) => new TextInstance(props, parent, root);
