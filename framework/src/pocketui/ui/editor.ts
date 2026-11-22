// PocketUI ui/editor.ts — the TextEditor element: a multi-line field with
// mention tokens, a caret, a selection and an IME's preedit, drawn from the
// model in core/editor.ts.
//
// PocketJS has no native text field. The host sends text events (committed
// text, named keys, preedit updates: framework/src/text-input.ts) and this
// element owns everything a person sees of typing: it lays the document out
// with core/rich.ts (tokens are atomic spans, so a mention wraps whole),
// answers the model's questions about visual lines, and paints the caret,
// the selection and the preedit's underline as views over the text.
//
// The field takes the keyboard when it is tapped or confirmed with the
// focus on it (ui/input.ts setTextTarget), and gives it up on Escape, on a
// tap elsewhere, or when the application says so. Where the surface has no
// keyboard of its own the application docks one (ui/kit.tsx Keyboard).
import { createRenderEffect, onCleanup, untrack } from "solid-js";
import type { TextEvent } from "../../input-api.ts";
import { createElement, createTextNode, detachNode, insertNode, replaceText, setProp, type NodeMirror } from "../../renderer.ts";
import { createEditor, type Editor, type EditorLayout, type EditorSnapshot } from "../core/editor.ts";
import { layoutRich, type RichLine, type Span } from "../core/rich.ts";
import { type PanSession, Instance, type BoxProps, type Kind, type Size, type UIRoot } from "./engine.ts";
import type { TextTarget } from "./input.ts";
import type { UI } from "./mount.ts";
import { faceRevision, measureIn, resolveFace } from "./textview.ts";
import { FACES, type Face, type TextRole } from "./theme.ts";

export interface EditorHandle {
  readonly model: Editor;
  /** take the keyboard */
  focus(): void;
  /** give the keyboard up */
  blur(): void;
  /** it has the keyboard */
  isTyping(): boolean;
  clear(): void;
}

export interface TextEditorProps extends BoxProps {
  /** the UI it is on (useUI()) */
  ui: UI;
  placeholder?: string;
  role?: TextRole | Face;
  /** grows to this many lines, then scrolls (default 6) */
  maxLines?: number;
  minLines?: number;
  singleLine?: boolean;
  maxLength?: number;
  /** Enter sends and Shift+Enter breaks the line (default true) */
  enterSubmits?: boolean;
  onSubmit?: (value: { text: string; tokens: { start: number; end: number; kind: string; id: string }[] }) => void;
  onChange?: (snapshot: EditorSnapshot) => void;
  /** it took or gave up the keyboard */
  onTyping?: (typing: boolean) => void;
  /** sees a key before the field does; true keeps it from the field (a completion menu's arrows and Enter) */
  interceptKey?: (key: string) => boolean;
  handle?: (handle: EditorHandle) => void;
  /** the text it starts with */
  initial?: { text: string; tokens?: { start: number; end: number; kind: string; id: string }[] };
}

interface Cell {
  node: NodeMirror;
  run: NodeMirror;
  text: string;
  style: Record<string, number | string>;
}

const STYLE_TEXT = 0;
const STYLE_TOKEN = 1;
const STYLE_PREEDIT = 2;

class EditorInstance extends Instance implements EditorHandle, TextTarget {
  readonly model: Editor;
  readonly owner: Instance = this;
  private inkText = "#000000";
  private inkToken = "#000000";
  private face: Face = FACES.body;
  private drawFace: Face = FACES.body;
  private snapshot: EditorSnapshot;
  private spans: Span[] = [];
  /** the document offset each span starts at */
  private spanStart: number[] = [];
  private laid: { width: number; lines: RichLine[] } | null = null;
  private content: NodeMirror;
  private cells: Cell[] = [];
  private boxes: { node: NodeMirror; style: Record<string, number | string> }[] = [];
  private caret: NodeMirror;
  private caretStyle: Record<string, number | string> = {};
  private placeholder: NodeMirror;
  private placeholderRun: NodeMirror;
  private typing = false;
  private blink = 0;
  private scroll = 0;
  private innerW = 0;
  /** some of the text waits for its glyphs */
  private pending = false;
  /** constructed: changes are the owner's to hear */
  private ready = false;

  constructor(private readonly editorProps: TextEditorProps, parent: Instance | null, root: UIRoot) {
    super(editorProps, parent, root);
    this.content = createElement("view");
    setProp(this.content, "style", { posType: 1, insetL: 0, insetT: 0 });
    insertNode(this.node, this.content);
    this.placeholder = createElement("text");
    this.placeholderRun = createTextNode("");
    insertNode(this.placeholder, this.placeholderRun);
    insertNode(this.content, this.placeholder);
    this.caret = createElement("view");
    setProp(this.caret, "style", { posType: 1, width: 2, radius: 1, opacity: 0 });
    this.model = createEditor({
      maxLength: untrack(() => editorProps.maxLength),
      singleLine: untrack(() => editorProps.singleLine),
      layout: () => this.visualLayout(),
      onChange: (snapshot, change) => {
        this.snapshot = snapshot;
        this.blink = 0;
        if (change.text) {
          this.rebuild();
          this.invalidate();
        } else this.paintOverlays();
        // the text it starts with is not a change: the owner hears from the first edit on
        if (this.ready) this.editorProps.onChange?.(snapshot);
      },
    });
    const initial = untrack(() => editorProps.initial);
    if (initial && initial.text) this.model.setValue(initial.text, initial.tokens);
    this.snapshot = this.model.snapshot();
    createRenderEffect(() => {
      // glyphs that arrive for text typed before they were there
      faceRevision();
      const role = editorProps.role ?? "body";
      const theme = root.theme;
      this.face = typeof role === "string" ? theme.face[role] : role;
      // the ink of the field it is in: read here so a change of theme, or of the field's state, draws the text again
      this.inkText = this.inkFor(undefined);
      this.inkToken = this.inkFor("accent");
      setProp(this.caret, "style", { bgColor: theme.color.caret });
      const placeholder = editorProps.placeholder ?? "";
      const resolved = resolveFace(placeholder, this.face);
      replaceText(this.placeholderRun, resolved.text);
      setProp(this.placeholder, "style", { posType: 1, fontSlot: resolved.face.slot, lineHeight: resolved.face.line, textColor: this.inkFor("faint") });
      this.rebuild();
      this.invalidate();
    });
    insertNode(this.content, this.caret);
    const tick = () => {
      if (!this.typing) return;
      this.blink = (this.blink + 1) % 60;
      const on = this.blink < 34 && this.snapshot.selection.anchor === this.snapshot.selection.focus;
      if ((this.caretStyle.opacity === 1) !== on) {
        setProp(this.caret, "style", { opacity: on ? 1 : 0 }, this.caretStyle);
        this.caretStyle = { ...this.caretStyle, opacity: on ? 1 : 0 };
      }
    };
    root.frameHooks.add(tick);
    onCleanup(() => {
      root.frameHooks.delete(tick);
      if (this.typing) editorProps.ui.input.setTextTarget(null);
    });
    editorProps.handle?.(this);
    this.ready = true;
  }

  protected override paint(): void {
    super.paint();
    this.style({ overflow: 1 });
  }

  // --- the document as spans --------------------------------------------------

  private rebuild(): void {
    const { text, tokens, composition } = this.snapshot;
    // cut the text at token and preedit edges
    const cuts: { at: number; end: number; style: number }[] = [];
    for (const token of tokens) cuts.push({ at: token.start, end: token.end, style: STYLE_TOKEN });
    if (composition && composition.end > composition.start) cuts.push({ at: composition.start, end: composition.end, style: STYLE_PREEDIT });
    cuts.sort((a, b) => a.at - b.at);
    const spans: Span[] = [];
    const starts: number[] = [];
    let at = 0;
    // the whole field in one face, character for character: the run-time face once anything is outside ASCII
    const resolved = resolveFace(text, this.face, true);
    this.drawFace = resolved.face;
    // What is drawn has the document's length, so offsets are the same in
    // both. A character whose glyph is on its way is an empty advance of the
    // face's size until it arrives; where no face can draw it, a dot stands in.
    const drawn = resolved.text.length === text.length ? resolved.text : text.replace(/[^\x20-\x7e\n]/g, "·");
    this.pending = drawn !== text && resolved.text.length !== text.length ? true : resolved.pending;
    for (const cut of cuts) {
      if (cut.at < at) continue;
      if (cut.at > at) {
        spans.push({ text: drawn.slice(at, cut.at), style: STYLE_TEXT });
        starts.push(at);
      }
      spans.push({ text: drawn.slice(cut.at, cut.end), style: cut.style, atomic: cut.style === STYLE_TOKEN });
      starts.push(cut.at);
      at = cut.end;
    }
    if (at < text.length || spans.length === 0) {
      spans.push({ text: drawn.slice(at), style: STYLE_TEXT });
      starts.push(at);
    }
    this.spans = spans;
    this.spanStart = starts;
    this.laid = null;
  }

  private lines(width: number): RichLine[] {
    const laid = this.laid;
    if (laid && laid.width === width) return laid.lines;
    const measure = measureIn(this.drawFace.slot);
    const lines = layoutRich(this.spans, this.editorProps.singleLine ? Infinity : width, (text) => measure(text));
    this.laid = { width, lines };
    return lines;
  }

  /** A line's first and last document offsets. */
  private lineRange(line: RichLine, index: number, lines: RichLine[]): { start: number; end: number } {
    const first = line.segments[0];
    const last = line.segments[line.segments.length - 1];
    if (first && last) return { start: this.spanStart[first.span]! + first.start, end: this.spanStart[last.span]! + last.end };
    // an empty line: after the newline that ended the line before
    let at = 0;
    for (let i = index - 1; i >= 0; i--) {
      const prev = lines[i]!;
      const tail = prev.segments[prev.segments.length - 1];
      if (tail) {
        at = this.spanStart[tail.span]! + tail.end + (index - i);
        break;
      }
      if (i === 0) at = index;
    }
    return { start: Math.min(at, this.snapshot.text.length), end: Math.min(at, this.snapshot.text.length) };
  }

  private xIn(line: RichLine, offset: number): number {
    const measure = measureIn(this.drawFace.slot);
    let x = 0;
    for (const segment of line.segments) {
      const start = this.spanStart[segment.span]! + segment.start;
      const end = this.spanStart[segment.span]! + segment.end;
      if (offset <= start) return segment.x;
      if (offset <= end) return segment.x + measure(segment.text.slice(0, offset - start));
      x = segment.x + segment.width;
    }
    return x;
  }

  private visualLayout(): EditorLayout {
    const lines = this.lines(this.innerW || Infinity);
    const ranges = lines.map((line, index) => this.lineRange(line, index, lines));
    // a line owns the offsets up to where the next one starts
    for (let i = 0; i < ranges.length - 1; i++) ranges[i]!.end = Math.max(ranges[i]!.end, Math.min(ranges[i + 1]!.start, ranges[i]!.end + 1) - (this.snapshot.text.charCodeAt(ranges[i]!.end) === 0x0a ? 1 : 0));
    const lineOf = (offset: number) => {
      for (let i = ranges.length - 1; i >= 0; i--) if (offset >= ranges[i]!.start) return i;
      return 0;
    };
    return {
      lines: ranges,
      x: (offset) => this.xIn(lines[lineOf(offset)]!, offset),
      offsetAt: (index, x) => this.offsetAt(lines, ranges, index, x),
    };
  }

  private offsetAt(lines: RichLine[], ranges: { start: number; end: number }[], index: number, x: number): number {
    const line = lines[Math.max(0, Math.min(lines.length - 1, index))];
    const range = ranges[Math.max(0, Math.min(ranges.length - 1, index))]!;
    if (!line || line.segments.length === 0) return range.start;
    const measure = measureIn(this.drawFace.slot);
    for (const segment of line.segments) {
      if (x > segment.x + segment.width) continue;
      const start = this.spanStart[segment.span]! + segment.start;
      if (this.spans[segment.span]!.atomic) return x - segment.x < segment.width / 2 ? start : start + segment.text.length;
      // the character boundary nearest x
      let best = 0;
      let bestDistance = Math.abs(x - segment.x);
      for (let i = 1; i <= segment.text.length; i++) {
        const c = segment.text.charCodeAt(i - 1);
        if (c >= 0xd800 && c <= 0xdbff) continue;
        const distance = Math.abs(x - (segment.x + measure(segment.text.slice(0, i))));
        if (distance < bestDistance) {
          bestDistance = distance;
          best = i;
        } else break;
      }
      return start + best;
    }
    return range.end;
  }

  // --- layout and paint -----------------------------------------------------

  protected measureContent(maxW: number): Size {
    const pad = this.pad;
    const inner = maxW === Infinity ? 240 : Math.max(0, maxW - pad.l - pad.r);
    const lines = this.lines(inner);
    const line = this.drawFace.line;
    const min = this.editorProps.minLines ?? 1;
    const max = this.editorProps.singleLine ? 1 : (this.editorProps.maxLines ?? 6);
    const shown = Math.max(min, Math.min(max, lines.length));
    return { w: maxW === Infinity ? 240 : maxW, h: shown * line + pad.t + pad.b };
  }

  protected override arrange(w: number, h: number): void {
    const pad = this.pad;
    this.innerW = Math.max(0, w - pad.l - pad.r);
    const lines = this.lines(this.innerW);
    const line = this.drawFace.line;
    let used = 0;
    for (let l = 0; l < lines.length; l++) {
      for (const segment of lines[l]!.segments) {
        let cell = this.cells[used];
        if (!cell) {
          const node = createElement("text");
          const run = createTextNode("");
          insertNode(node, run);
          insertNode(this.content, node, this.caret);
          cell = { node, run, text: "", style: {} };
          this.cells[used] = cell;
        }
        if (cell.text !== segment.text) {
          replaceText(cell.run, segment.text);
          cell.text = segment.text;
        }
        const next = {
          posType: 1,
          insetL: Math.round(pad.l + segment.x),
          insetT: pad.t + l * line,
          fontSlot: this.drawFace.slot,
          lineHeight: line,
          textColor: segment.style === STYLE_TOKEN ? this.inkToken : this.inkText,
        };
        setProp(cell.node, "style", next, cell.style);
        cell.style = next;
        used++;
      }
    }
    for (let i = this.cells.length - 1; i >= used; i--) {
      detachNode(this.content, this.cells[i]!.node);
      this.cells.pop();
    }
    setProp(this.placeholder, "style", { insetL: pad.l, insetT: pad.t, opacity: this.snapshot.text.length === 0 ? 1 : 0 });
    setProp(this.content, "style", { width: w, height: Math.max(h, lines.length * line + pad.t + pad.b) });
    this.paintOverlays();
  }

  /** The caret, the selection and the preedit's underline. */
  private paintOverlays(): void {
    if (!this.placed) return;
    const pad = this.pad;
    const lines = this.lines(this.innerW);
    const layout = this.visualLayout();
    const line = this.drawFace.line;
    const c = this.root.theme.color;
    const { selection, composition } = this.snapshot;
    const lineOf = (offset: number) => {
      for (let i = layout.lines.length - 1; i >= 0; i--) if (offset >= layout.lines[i]!.start) return i;
      return 0;
    };
    let used = 0;
    const box = (x: number, y: number, w: number, h: number, color: string) => {
      let entry = this.boxes[used];
      if (!entry) {
        entry = { node: createElement("view"), style: {} };
        insertNode(this.content, entry.node, this.cells[0]?.node ?? this.caret);
        this.boxes[used] = entry;
      }
      const next = { posType: 1, insetL: Math.round(x), insetT: Math.round(y), width: Math.max(1, Math.round(w)), height: h, bgColor: color, radius: 1 };
      setProp(entry.node, "style", next, entry.style);
      entry.style = next;
      used++;
    };
    const range = (from: number, to: number, paint: (x: number, y: number, w: number) => void) => {
      const a = lineOf(from);
      const b = lineOf(to);
      for (let l = a; l <= b; l++) {
        const x0 = l === a ? layout.x(from) : 0;
        const x1 = l === b ? this.xIn(lines[l]!, to) : lines[l]!.width + 4;
        paint(pad.l + x0, pad.t + l * line, x1 - x0);
      }
    };
    const from = Math.min(selection.anchor, selection.focus);
    const to = Math.max(selection.anchor, selection.focus);
    if (to > from) range(from, to, (x, y, w) => box(x, y, w, line, c.selection));
    if (composition && composition.end > composition.start) range(composition.start, composition.end, (x, y, w) => box(x, y + line - 2, w, 1, this.inkText));
    for (let i = this.boxes.length - 1; i >= used; i--) {
      detachNode(this.content, this.boxes[i]!.node);
      this.boxes.pop();
    }
    const caretAt = composition ? composition.caret : selection.focus;
    const caretLine = lineOf(caretAt);
    const next = { insetL: Math.round(pad.l + layout.x(caretAt)) - 1, insetT: pad.t + caretLine * line + 1, height: line - 2, opacity: this.typing && to === from ? 1 : 0 };
    setProp(this.caret, "style", next, this.caretStyle);
    this.caretStyle = { ...this.caretStyle, ...next };
    // keep the caret's line in the box
    const top = caretLine * line;
    const viewH = this.h - pad.t - pad.b;
    if (top < this.scroll) this.scroll = top;
    else if (top + line > this.scroll + viewH) this.scroll = top + line - viewH;
    this.scroll = Math.max(0, Math.min(this.scroll, Math.max(0, lines.length * line - viewH)));
    setProp(this.content, "style", { translateY: -this.scroll });
  }

  // --- input ------------------------------------------------------------------

  event(event: TextEvent): boolean {
    const model = this.model;
    switch (event.kind) {
      case "commit":
        model.insert(event.text);
        return true;
      case "composition":
        model.compose(event.text, event.selectionStart, event.selectionEnd);
        return true;
      case "compositionEnd":
        model.endComposition();
        return true;
      case "key": {
        if (!event.pressed) return true;
        if (this.editorProps.interceptKey?.(event.key)) return true;
        const submits = this.editorProps.enterSubmits !== false;
        if (event.key === "Enter" && (submits || this.editorProps.singleLine) && !this.snapshot.composition) {
          this.editorProps.onSubmit?.(model.value());
          return true;
        }
        if (model.key(event.key, { enterSubmits: submits })) return true;
        if (event.key === "Escape") {
          this.blur();
          return true;
        }
        return false;
      }
    }
  }

  override tapped(x: number, y: number): void {
    this.focus();
    if (x >= 0) {
      const layout = this.visualLayout();
      const line = Math.floor((y - this.pad.t + this.scroll) / this.drawFace.line);
      this.model.select(layout.offsetAt(Math.max(0, Math.min(layout.lines.length - 1, line)), x - this.pad.l));
    }
    this.editorProps.onPress?.();
  }

  /** A drag through the text of the field that has the keyboard draws a
   *  selection from where it began to where it is. A field that is not being
   *  typed in leaves the drag to the page, which scrolls. */
  override claimDrag(x: number, y: number): PanSession | null {
    if (!this.typing || this.editorProps.disabled) return null;
    const at = (px: number, py: number): number => {
      const layout = this.visualLayout();
      const line = Math.floor((py - this.pad.t + this.scroll) / this.drawFace.line);
      return layout.offsetAt(Math.max(0, Math.min(layout.lines.length - 1, line)), px - this.pad.l);
    };
    const anchor = at(x, y);
    this.model.select(anchor);
    return {
      move: (dx, dy) => this.model.select(anchor, at(x + dx, y + dy)),
      end: () => {},
    };
  }

  override get interactive(): boolean {
    return !this.editorProps.disabled;
  }

  override get takesFocus(): boolean {
    return !this.editorProps.disabled && !this.hidden;
  }

  focus(): void {
    if (this.typing) return;
    this.typing = true;
    this.blink = 0;
    this.editorProps.ui.input.setTextTarget(this);
    this.paintOverlays();
    this.editorProps.onTyping?.(true);
  }

  blur(): void {
    if (!this.typing) return;
    this.typing = false;
    this.model.endComposition();
    if (this.editorProps.ui.input.textTarget() === this) this.editorProps.ui.input.setTextTarget(null);
    this.paintOverlays();
    this.editorProps.onTyping?.(false);
  }

  isTyping(): boolean {
    return this.typing;
  }

  clear(): void {
    this.model.setValue("");
  }
}

export const TEXT_EDITOR: Kind<TextEditorProps> = (props, parent, root) => new EditorInstance(props, parent, root);
