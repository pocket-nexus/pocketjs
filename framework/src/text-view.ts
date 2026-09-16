import { createElement, createTextNode, insertNode, removeNode, replaceText, setProp, type NodeMirror } from "./native-tree.ts";
import { getOps } from "./host.ts";
import type { TextLayout, TextStyle } from "./text.ts";

/** Bounded child pool, owned by the supplied view. Does not own glyph handles. */
export function createTextPainter(parent: NodeMirror, style: TextStyle) {
  const nodes: { node: NodeMirror; kind: string; label?: NodeMirror; text?: string; handle?: number; style?: Record<string, string | number> }[] = [];
  let revision = -1, lastColor = "";
  return {
    paint(layout: TextLayout, color: string) {
      if (revision === layout.revision && color === lastColor) return;
      revision = layout.revision; lastColor = color;
      // Retain source text in the mirror for inspection; native paint uses the
      // positioned children, and source offsets remain in TextLayout.parts.
      parent.text = layout.text;
      const parts = layout.parts.filter(p => p.x < style.width);
      while (nodes.length > parts.length) removeNode(parent, nodes.pop()!.node);
      for (let i = 0; i < parts.length; i++) {
        const part = parts[i], kind = part.kind === "local" ? "text" : part.glyph ? "image" : "view";
        if (nodes[i] && nodes[i].kind !== kind) { removeNode(parent, nodes[i].node); nodes[i] = undefined!; }
        if (!nodes[i]) {
          const node = createElement(kind === "text" ? "view" : kind);
          const label = kind === "text" ? createTextNode(part.text) : undefined;
          if (label) insertNode(node, label);
          insertNode(parent, node); nodes[i] = { node, label, kind, text: kind === "text" ? part.text : undefined };
        }
        const cell = nodes[i];
        const props: Record<string, string | number> = { posType: 1, insetL: part.x, insetT: 0 };
        if (part.kind === "local") {
          if (cell.text !== part.text) { replaceText(cell.label!, part.text); cell.text = part.text; }
          Object.assign(props, { width: part.width, height: style.size + 8, flexDir: 0, align: 1 });
          setProp(cell.label!, "style", { fontSlot: style.fontSlot, textColor: color });
        } else if (part.glyph) {
          const glyph = part.glyph;
          Object.assign(props, { insetL: part.x - glyph.xoff, width: glyph.envelope / style.density,
            height: glyph.height / style.density, opacity: color === "#666666" ? 0.4 : 1 });
          if (cell.handle !== glyph.handle) { getOps().setImage(cell.node.id, glyph.handle); cell.handle = glyph.handle; }
        } else {
          Object.assign(props, { insetL: part.x + 2, insetT: (style.size + 8 - 7) / 2, width: Math.max(4, part.width - 4),
            height: 7, bgColor: "#6c7785", radius: 2, opacity: 0.4 });
        }
        setProp(cell.node, "style", props, cell.style); cell.style = props;
      }
    },
    dispose() { for (const { node } of nodes) removeNode(parent, node); nodes.length = 0; },
  };
}
