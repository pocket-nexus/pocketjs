// PocketUI ui/thumb.ts — the scroll bar that is a thumb over the content: it
// shows while the content moves, fades when it rests, takes no width and no
// press. Scroll and Feed each own one; what it looks like is the theme's
// "scroll.thumb" part in its "overlay" variant.
import { animate, jump } from "../../animation.ts";
import { createElement, insertNode, setProp, type NodeMirror } from "../../renderer.ts";
import type { UIRoot } from "./engine.ts";
import { REST } from "./theme.ts";

const WIDTH = 4;
const INSET = 2;
const MIN_LENGTH = 18;
/** frames it stays after the content last moved */
const LINGER = 36;

export class OverlayThumb {
  private readonly node: NodeMirror;
  private style: Record<string, number | string> = {};
  private linger = 0;
  private showing = false;

  constructor(parent: NodeMirror, private readonly root: UIRoot) {
    this.node = createElement("view");
    setProp(this.node, "style", { posType: 1, width: WIDTH, opacity: 0, hitPass: 1, zIndex: 5 });
    insertNode(parent, this.node);
  }

  /** The content moved. */
  touch(): void {
    this.linger = LINGER;
  }

  /** Each frame: where the thumb is, and whether it shows. `strip`: the theme draws a strip beside the view instead. */
  frame(view: { w: number; h: number }, max: number, offset: number, strip: boolean): void {
    const shown = !strip && max > 0 && this.linger > 0;
    if (this.linger > 0) this.linger--;
    if (shown) {
      const paint = this.root.theme.paint("scroll.thumb", { ...REST, variant: "overlay" });
      const lane = view.h - 2 * INSET;
      const length = Math.max(MIN_LENGTH, (lane * view.h) / (view.h + max));
      const at = Math.min(max, Math.max(0, offset));
      const next: Record<string, number | string> = {
        insetL: view.w - WIDTH - INSET,
        insetT: Math.round(INSET + ((lane - length) * at) / max),
        height: Math.round(length),
        bgColor: paint.fill ?? this.root.theme.color.faint,
        radius: paint.radius ?? 0,
      };
      setProp(this.node, "style", next, this.style);
      this.style = { ...this.style, ...next };
    }
    if (shown === this.showing) return;
    this.showing = shown;
    if (shown) jump(this.node, "opacity", 1);
    else animate(this.node, "opacity", 0, { dur: 260, easing: "out" });
  }
}
