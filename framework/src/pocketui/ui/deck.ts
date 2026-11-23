// PocketUI ui/deck.ts — panes one at a time, with the change between two as
// a motion that can be followed and let go either way.
//
// A Deck lays every child out at its full size and shows the one `index`
// names. A change of index is a transition between two panes:
//
//   follow   a horizontal pan toward the previous pane drags both panes
//            with the contact; letting go past a third of the width, or
//            with speed, completes the move back (onBack), otherwise both
//            return. Nothing is decided until the contact lifts.
//   animate  the incoming pane slides over 240 ms. A second change while it
//            plays starts from where the panes are (the core's animations
//            start from the current value), so Back during a push reverses
//            it mid-way.
//   cut      the next frame shows the new pane: a panel that repaints
//            slowly, or a device whose frames are expensive.
//
// Only the shown pane (and, during a transition, the one arriving) takes the
// pointer and the focus; the others stay mounted with their state: a list
// keeps its scroll offset behind the detail it opened.
import { createRenderEffect, onCleanup } from "solid-js";
import { setProp } from "../../renderer.ts";
import { animate, jump, spring } from "../../animation.ts";
import { Container, element, ZSTACK, type BoxProps, type Instance, type Kind, type PanSession, type Size, type UIElement, type UINode, type UIRoot } from "./engine.ts";

export interface DeckProps extends BoxProps {
  /** the child that shows */
  index: number;
  /** a pan back completed: make `index` one less */
  onBack?: () => void;
  transition?: "follow" | "animate" | "cut";
  children?: UINode;
}

const DURATION_MS = 240;
const SETTLE_FRAMES = 18;
/** how far the pane underneath sits to the side while covered, as a share of the width */
const PARALLAX = 0.25;

export class DeckInstance extends Container {
  protected shown = 0;
  /** frames until the transition's outgoing pane is parked */
  protected settling = 0;
  protected outgoing = -1;
  private wrappers = new WeakMap<UIElement, UIElement>();
  protected dragging = false;
  protected active: Instance[] = [];

  constructor(protected readonly deckProps: DeckProps, parent: Instance | null, root: UIRoot) {
    super(deckProps, parent, root);
    this.shown = Math.max(0, deckProps.index);
    let first = true;
    createRenderEffect(() => {
      const index = Math.max(0, deckProps.index);
      if (first) {
        first = false;
        this.shown = index;
        return;
      }
      if (index !== this.shown) this.go(index);
    });
    const step = () => {
      if (this.settling > 0 && --this.settling === 0) this.park();
    };
    root.frameHooks.add(step);
    onCleanup(() => root.frameHooks.delete(step));
  }

  protected override paint(): void {
    super.paint();
    this.style({ overflow: 1 });
  }

  protected override adopt(elements: UIElement[]): UIElement[] {
    // each child rides in a wrapper this deck moves: the child's own node keeps its own paint
    return elements.map((el) => {
      let wrapper = this.wrappers.get(el);
      if (!wrapper) {
        wrapper = element(ZSTACK, { children: el });
        this.wrappers.set(el, wrapper);
      }
      return wrapper;
    });
  }

  protected mode(): NonNullable<DeckProps["transition"]> {
    return this.deckProps.transition ?? "animate";
  }

  /** Put every pane where a settled deck has it: the shown one in place, the rest out of sight. */
  protected park(): void {
    this.outgoing = -1;
    const list = this.list;
    for (let i = 0; i < list.length; i++) {
      const node = list[i]!.node;
      jump(node, "translateX", i === this.shown ? 0 : this.w + 8);
      jump(node, "opacity", i === this.shown ? 1 : 0);
    }
  }

  protected go(index: number): void {
    const from = this.shown;
    this.shown = index;
    const list = this.list;
    const incoming = list[index];
    const leaving = list[from];
    if (!this.placed || !incoming || this.mode() === "cut" || this.w === 0) {
      this.settling = 0;
      this.park();
      this.root.schedule();
      return;
    }
    const forward = index > from;
    // an interrupted transition's other pane leaves at once
    if (this.outgoing >= 0 && this.outgoing !== from && this.outgoing !== index) {
      const stray = list[this.outgoing];
      if (stray) {
        jump(stray.node, "translateX", this.w + 8);
        jump(stray.node, "opacity", 0);
      }
    }
    if (this.settling === 0 && !this.dragging) {
      // a fresh transition: the incoming pane starts at its side
      jump(incoming.node, "translateX", forward ? this.w : -this.w * PARALLAX);
    }
    jump(incoming.node, "opacity", 1);
    animate(incoming.node, "translateX", 0, { dur: DURATION_MS, easing: "out" });
    if (leaving) animate(leaving.node, "translateX", forward ? -this.w * PARALLAX : this.w, { dur: DURATION_MS, easing: "out" });
    this.outgoing = from;
    this.settling = SETTLE_FRAMES;
    // the pane that arrives paints over the one that leaves when it comes forward
    this.raise(forward ? index : from);
  }

  /** Paint `index` above its siblings for the length of a transition. */
  protected raise(index: number): void {
    const list = this.list;
    for (let i = 0; i < list.length; i++) setProp(list[i]!.node, "style", { zIndex: i === index ? 2 : i === this.shown || i === this.outgoing ? 1 : 0 });
  }

  protected measureContent(maxW: number, maxH: number): Size {
    let w = 0;
    let h = 0;
    for (const child of this.list) {
      const size = child.measure(maxW, maxH);
      w = Math.max(w, size.w);
      h = Math.max(h, size.h);
    }
    return { w: maxW === Infinity ? w : maxW, h: maxH === Infinity ? h : maxH };
  }

  protected override arrange(w: number, h: number): void {
    const list = this.list;
    if (this.shown >= list.length) this.shown = Math.max(0, list.length - 1);
    for (const child of list) child.place(0, 0, w, h);
    if (this.settling === 0 && !this.dragging) this.park();
  }

  override kids(): readonly Instance[] {
    // the shown pane alone takes the pointer and the focus
    const shown = this.list[this.shown];
    this.active.length = 0;
    if (shown) this.active.push(shown);
    return this.active;
  }

  override clips(): boolean {
    return true;
  }

  override claimPan(dx: number, dy: number): PanSession | null {
    if (this.mode() !== "follow" || !this.deckProps.onBack || this.shown === 0 || dx <= 0 || Math.abs(dy) > Math.abs(dx)) return null;
    const current = this.list[this.shown];
    const under = this.list[this.shown - 1];
    if (!current || !under) return null;
    this.dragging = true;
    this.settling = 0;
    this.outgoing = this.shown - 1;
    jump(under.node, "opacity", 1);
    this.raise(this.shown);
    const w = this.w;
    let at = 0;
    const follow = (x: number) => {
      at = Math.min(w, Math.max(0, x));
      jump(current.node, "translateX", at);
      jump(under.node, "translateX", -w * PARALLAX * (1 - at / w));
    };
    follow(dx);
    return {
      move: (x) => follow(x),
      end: (vx, _vy, cancelled) => {
        this.dragging = false;
        const complete = !cancelled && (at > w / 3 || vx > 350) && vx > -200;
        if (!complete) return this.settleBack(current, under);
        // the owner makes `index` one less; go() then animates both panes on from where they are
        this.settling = 1;
        this.deckProps.onBack?.();
        if (this.list[this.shown] !== under) this.settleBack(current, under);
      },
    };
  }

  /** A pan let go short: both panes return. */
  private settleBack(current: Instance, under: Instance): void {
    spring(current.node, "translateX", 0);
    animate(under.node, "translateX", -this.w * PARALLAX, { dur: DURATION_MS, easing: "out" });
    this.settling = SETTLE_FRAMES + 12;
  }
}

export const DECK: Kind<DeckProps> = (props, parent, root) => new DeckInstance(props, parent, root);
