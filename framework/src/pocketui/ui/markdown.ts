// PocketUI ui/markdown.ts — Markdown as measured elements.
//
// core/markdown.ts parses the source to blocks; this file maps each block to
// elements: a paragraph is a RichText, a fence is a monospace Text on a
// panel, a list is rows of marker and content. The source is usually an
// agent's answer while it is being written, so the same component is given a
// longer source many times a second. Each block keeps its element while its
// content is the same (the parser keeps finished blocks stable), and a
// paragraph, a heading or a fence that only grew keeps its element and
// changes its text, so a streaming answer relays out its last block and
// nothing above it.
import { createMemo, createSignal, mergeProps, splitProps, type Accessor } from "solid-js";
import { parseMarkdown, plainText, type Block, type Run } from "../core/markdown.ts";
import { element, HSTACK, VSTACK, type BoxProps, type UIElement, type UINode } from "./engine.ts";
import { useUI } from "./mount.ts";
import { RICH_TEXT, type RichSpan } from "./richview.ts";
import { TEXT } from "./textview.ts";

export interface MarkdownProps extends BoxProps {
  source: string;
  /** room between blocks (default 7) */
  spacing?: number;
  /** the body's colour, in place of the ink where it is */
  color?: string;
}

function spansOf(runs: readonly Run[], bold = false): RichSpan[] {
  const out: RichSpan[] = [];
  for (const run of runs) {
    if (run.code) out.push({ text: run.text, role: "mono", tone: "note", ground: "code" });
    else out.push({ text: run.text, role: run.bold || bold ? "strong" : undefined, tone: run.href ? "accent" : run.strike ? "faint" : run.italic ? "muted" : undefined });
  }
  return out;
}

/** Lines of a diff fence, coloured by their first character. */
function diffSpans(text: string): RichSpan[] {
  const out: RichSpan[] = [];
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const first = line.charCodeAt(0);
    const tone = first === 0x2b ? "good" : first === 0x2d ? "bad" : first === 0x40 ? "note" : "muted";
    out.push({ text: i < lines.length - 1 ? `${line}\n` : line, role: "mono", tone });
  }
  return out;
}

function staticBlock(block: Block, depth: number): UIElement {
  switch (block.t) {
    case "p":
      return element(RICH_TEXT, { spans: spansOf(block.runs) });
    case "h":
      return element(RICH_TEXT, { spans: spansOf(block.runs, true), role: block.level <= 2 ? "title" : "strong" });
    case "code":
      return codeBlock(() => block);
    case "hr":
      return element(VSTACK, { height: 1, part: "divider" });
    case "quote":
      return element(HSTACK, {
        align: "stretch",
        spacing: 8,
        children: [element(VSTACK, { width: 2, part: "divider" }), element(VSTACK, { grow: 1, spacing: 6, children: block.blocks.map((inner) => staticBlock(inner, depth + 1)) })] as UINode,
      });
    case "list":
      return element(VSTACK, {
        spacing: 3,
        children: block.items.map((item, index) => {
          const marker = item.checked === true ? "[x]" : item.checked === false ? "[ ]" : block.ordered ? `${block.start + index}.` : depth % 2 === 0 ? "-" : "*";
          return element(HSTACK, {
            align: "start",
            spacing: 4,
            children: [
              element(TEXT, { value: marker, role: "body", tone: "muted", width: block.ordered || item.checked !== undefined ? 20 : 10, align: block.ordered ? "right" : "left" }),
              element(VSTACK, { grow: 1, spacing: 4, children: item.blocks.map((inner) => staticBlock(inner, depth + 1)) }),
            ] as UINode,
          });
        }) as UINode,
      });
    case "table": {
      const row = (cells: readonly Run[][], head: boolean) =>
        element(HSTACK, {
          align: "start",
          spacing: 8,
          padding: [3, 6],
          part: head ? "section" : undefined,
          children: cells.map((cell) => element(RICH_TEXT, { grow: 1, spans: spansOf(cell, head), role: "body" })) as UINode,
        });
      const rows: UIElement[] = [row(block.head, true)];
      for (const cells of block.rows) {
        rows.push(element(VSTACK, { height: 1, part: "divider" }));
        rows.push(row(cells, false));
      }
      return element(VSTACK, { part: "well", variant: "table", padding: 1, clip: true, children: rows as UINode });
    }
  }
}

function codeBlock(block: Accessor<Extract<Block, { t: "code" }>>): UIElement {
  return element(VSTACK, {
    part: "well",
    variant: "code",
    get children() {
      const code = block();
      if (code.lang === "diff" || code.lang === "patch") return element(RICH_TEXT, { spans: diffSpans(code.text), role: "mono" }) as UINode;
      return element(TEXT, {
        get value() {
          return block().text;
        },
        role: "mono",
      }) as UINode;
    },
  });
}

interface Slot {
  /** what the element was built from */
  shape: string;
  el: UIElement;
  /** for a block that changes in place */
  set?: (block: Block) => void;
}

/** A block's content as a string: equal strings draw the same. */
const shapeOf = (block: Block) => JSON.stringify(block);

export function Markdown(props: MarkdownProps): UIElement {
  const ui = useUI();
  const [own, box] = splitProps(props, ["source", "spacing", "color"]);
  const blocks = createMemo(() => parseMarkdown(own.source));
  const slots: Slot[] = [];
  const list = createMemo(() => {
    const next = blocks();
    slots.length = Math.min(slots.length, next.length);
    for (let i = 0; i < next.length; i++) {
      const block = next[i]!;
      const shape = shapeOf(block);
      const slot = slots[i];
      if (slot && slot.shape === shape) continue;
      // a paragraph, heading or fence that changed keeps its element and takes the new content
      if (slot?.set && slot.el.kind === kindOf(block) && sameKind(slot.shape, block)) {
        slot.shape = shape;
        slot.set(block);
        continue;
      }
      if (block.t === "p" || block.t === "h") {
        const [current, set] = createSignal(block, { equals: false });
        const level = block.t === "h" ? block.level : 0;
        slots[i] = {
          shape,
          set: set as (block: Block) => void,
          el: element(RICH_TEXT, {
            get spans() {
              return spansOf((current() as { runs: Run[] }).runs, level > 0);
            },
            role: level === 0 ? "body" : level <= 2 ? "title" : "strong",
            get color() {
              return own.color;
            },
          }),
        };
      } else if (block.t === "code" && block.lang !== "diff" && block.lang !== "patch") {
        const [current, set] = createSignal(block, { equals: false });
        slots[i] = { shape, set: set as (block: Block) => void, el: codeBlock(current) };
      } else slots[i] = { shape, el: staticBlock(block, 0) };
    }
    return slots.map((slot) => slot.el);
  });
  if (ui.idioms().content === "plain") {
    return element(TEXT, mergeProps(box, { get value() { return plainText(blocks()); }, get color() { return own.color; } }));
  }
  return element(
    VSTACK,
    mergeProps(box, {
      get spacing() {
        return own.spacing ?? 7;
      },
      get children() {
        return list() as UINode;
      },
    }),
  );
}

function kindOf(block: Block): unknown {
  return block.t === "p" || block.t === "h" ? RICH_TEXT : VSTACK;
}

/** Whether a slot built for `shape` can take `block` in place: the same block type (and heading level, and fence language). */
function sameKind(shape: string, block: Block): boolean {
  if (block.t === "p") return shape.startsWith('{"t":"p"');
  if (block.t === "h") return shape.startsWith(`{"t":"h","level":${block.level}`);
  if (block.t === "code") return shape.startsWith(`{"t":"code","lang":${JSON.stringify(block.lang)}`);
  return false;
}
