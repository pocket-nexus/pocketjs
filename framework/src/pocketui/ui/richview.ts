// PocketUI ui/richview.ts — the RichText element: one wrapped paragraph in
// several styles (core/rich.ts breaks it into lines and segments).
//
// A span is set by run (ui/textview.ts): ASCII in its face, the rest in the
// run-time face of its weight. A segment is one native text node at its x and
// line; a span with a background (inline code, a mention) gets a rounded view behind its
// segments. Nodes are kept and reused across layouts: a paragraph that
// streams in changes the last node's text and adds one now and then.
import { createRenderEffect } from "solid-js";
import { createElement, createTextNode, detachNode, insertNode, replaceText, setProp, type NodeMirror } from "../../renderer.ts";
import { layoutRich, type RichLine, type Span } from "../core/rich.ts";
import { Instance, type BoxProps, type Kind, type Size, type UIRoot } from "./engine.ts";
import { faceRevision, measureIn, resolveFace, resolveRuns, textCounters } from "./textview.ts";
import type { Face, TextRole, Tone } from "./theme.ts";

export interface RichSpan {
  text: string;
  role?: TextRole | Face;
  /** what it means: the theme and the part it is in give the colour */
  tone?: Tone;
  /** a colour, in place of the tone's */
  color?: string;
  /** set on the theme's ground for inline code, or for a chip */
  ground?: "code" | "chip";
  /** a fill behind the span, in place of the ground's */
  background?: string;
  /** never broken across lines */
  atomic?: boolean;
}

export interface RichTextProps extends BoxProps {
  spans: readonly RichSpan[];
  /** the face of spans that name none (default "body") */
  role?: TextRole | Face;
  /** the meaning of spans that name none */
  tone?: Tone;
  color?: string;
  lines?: number;
}

interface Style {
  face: Face;
  color: string;
  background: string | undefined;
}

interface Cell {
  node: NodeMirror;
  run: NodeMirror;
  text: string;
  style: Record<string, number | string>;
}

function sameLines(a: readonly RichLine[], b: readonly RichLine[]): boolean {
  if (a.length !== b.length) return false;
  for (let l = 0; l < a.length; l++) {
    const left = a[l]!;
    const right = b[l]!;
    if (left.width !== right.width || left.segments.length !== right.segments.length) return false;
    for (let s = 0; s < left.segments.length; s++) {
      const one = left.segments[s]!;
      const other = right.segments[s]!;
      if (one.text !== other.text || one.x !== other.x || one.style !== other.style || one.width !== other.width) return false;
    }
  }
  return true;
}

class RichTextInstance extends Instance {
  private spans: Span[] = [];
  private styles: Style[] = [];
  private line = 17;
  private laid: { width: number; lines: RichLine[] } | null = null;
  private cells: Cell[] = [];
  private fills: { node: NodeMirror; style: Record<string, number | string> }[] = [];
  private shape = "";
  private body = "";
  private pending = false;
  private waited = false;

  constructor(private readonly richProps: RichTextProps, parent: Instance | null, root: UIRoot) {
    super(richProps, parent, root);
    createRenderEffect(() => {
      const props = this.richProps;
      const theme = root.theme;
      const baseRole = props.role ?? this.roleFor();
      const base = typeof baseRole === "string" ? theme.face[baseRole] : baseRole;
      const baseColor = props.color ?? this.inkFor(props.tone);
      const styles: Style[] = [];
      const index = new Map<string, number>();
      const spans: Span[] = [];
      let line = base.line;
      let pending = false;
      for (const span of props.spans) {
        const role = span.role;
        const wanted = role === undefined ? base : typeof role === "string" ? theme.face[role] : role;
        const color = span.color ?? (span.tone !== undefined ? this.inkFor(span.tone) : baseColor);
        const background = span.background ?? (span.ground === "code" ? theme.color.raised : span.ground === "chip" ? theme.color.selected : undefined);
        const styleOf = (face: Face): number => {
          const key = `${face.slot}/${face.line}|${color}|${background ?? ""}`;
          let style = index.get(key);
          if (style === undefined) {
            style = styles.length;
            styles.push({ face, color, background });
            index.set(key, style);
          }
          if (face.line > line) line = face.line;
          return style;
        };
        // a span that never breaks is one piece in one face; the rest are set by run
        if (span.atomic) {
          const whole = resolveFace(span.text, wanted);
          if (whole.pending) pending = true;
          spans.push({ text: whole.text, style: styleOf(whole.face), atomic: true });
          continue;
        }
        const resolved = resolveRuns(span.text, wanted);
        if (resolved.pending) pending = true;
        for (const run of resolved.runs) spans.push({ text: run.text, style: styleOf(run.face) });
      }
      // the same runs in the same faces: a colour changed at most (an ancestor's state, a theme of the same faces)
      const body = spans.map((span) => `${span.style}\u0001${span.text}`).join("\u0002") + styles.map((style) => `${style.face.slot}/${style.face.line}`).join(",") + `|${line}`;
      // while a glyph is on its way the revision is part of it: each arrival is looked at
      const shape = pending ? `${faceRevision()}|${body}` : body;
      const same = shape === this.shape;
      // the same text in the same faces, laid out before with a glyph missing: what changed is that glyphs arrived
      const arrival = !same && this.pending && body === this.body;
      const before = this.laid;
      if (!same) this.waited = arrival;
      this.pending = pending;
      this.shape = shape;
      this.body = body;
      this.spans = spans;
      this.styles = styles;
      this.line = line;
      if (same) {
        if (this.placed) this.repaintRuns();
        return;
      }
      this.laid = null;
      // glyphs that arrive as wide as the places kept for them move nothing: the same lines, the same nodes (ui/textview.ts)
      if (arrival && before && this.placed && sameLines(before.lines, this.layout(before.width))) return;
      this.invalidate();
    });
  }

  private layout(width: number): RichLine[] {
    const laid = this.laid;
    if (laid && laid.width === width) return laid.lines;
    textCounters.layouts++;
    if (this.waited) {
      textCounters.relayouts++;
      this.waited = false;
    }
    const styles = this.styles;
    const lines = layoutRich(this.spans, width, (text, style) => measureIn(styles[style]!.face.slot)(text), this.richProps.lines ?? Infinity);
    this.laid = { width, lines };
    return lines;
  }

  /** The colours of runs that are laid out as they were: no measuring, the nodes' paint only. */
  private repaintRuns(): void {
    this.arrange(this.w);
  }

  protected measureContent(maxW: number): Size {
    const pad = this.pad;
    const inner = maxW === Infinity ? Infinity : Math.max(0, maxW - pad.l - pad.r);
    const lines = this.layout(inner);
    let width = 0;
    for (const line of lines) if (line.width > width) width = line.width;
    return { w: Math.ceil(width) + pad.l + pad.r, h: lines.length * this.line + pad.t + pad.b };
  }

  protected override arrange(w: number): void {
    const pad = this.pad;
    const lines = this.layout(Math.max(0, w - pad.l - pad.r));
    let used = 0;
    let filled = 0;
    for (let l = 0; l < lines.length; l++) {
      const top = pad.t + l * this.line;
      for (const segment of lines[l]!.segments) {
        const style = this.styles[segment.style]!;
        if (style.background) {
          let fill = this.fills[filled];
          if (!fill) {
            fill = { node: createElement("view"), style: {} };
            insertNode(this.node, fill.node, this.cells[0]?.node ?? null);
            this.fills[filled] = fill;
          }
          const next = { posType: 1, insetL: pad.l + segment.x - 2, insetT: top + 1, width: Math.ceil(segment.width) + 4, height: this.line - 2, bgColor: style.background, radius: 3, opacity: 1 };
          setProp(fill.node, "style", next, fill.style);
          fill.style = next;
          filled++;
        }
        let cell = this.cells[used];
        if (!cell) {
          const node = createElement("text");
          const run = createTextNode("");
          insertNode(node, run);
          insertNode(this.node, node, null);
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
          insetT: top + Math.floor((this.line - style.face.line) / 2),
          fontSlot: style.face.slot,
          lineHeight: style.face.line,
          textColor: style.color,
          opacity: 1,
        };
        setProp(cell.node, "style", next, cell.style);
        cell.style = next;
        used++;
      }
    }
    // nodes a shorter layout no longer uses
    for (let i = this.cells.length - 1; i >= used; i--) {
      detachNode(this.node, this.cells[i]!.node);
      this.cells.pop();
    }
    for (let i = this.fills.length - 1; i >= filled; i--) {
      detachNode(this.node, this.fills[i]!.node);
      this.fills.pop();
    }
  }

  override blocksHit(): boolean {
    return this.interactive;
  }
}

export const RICH_TEXT: Kind<RichTextProps> = (props, parent, root) => new RichTextInstance(props, parent, root);
