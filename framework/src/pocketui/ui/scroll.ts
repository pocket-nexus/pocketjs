// PocketUI ui/scroll.ts — a scroll view over content of any height.
//
// The clip node never moves: the core takes a node's scissor from its own
// box (framework/src/components.ts, Gallery), so the rectangle that clips is
// this instance's node and the children sit on a second node inside it whose
// translateY is the scroll offset. Moving it is one native prop per frame
// and no layout.
//
// The offset is PocketJS's kinetic scroller (framework/src/kinetics-core.ts):
// finger-follow, fling, rubber band and the d-pad's chase are its own, fixed
// step and deterministic.
import { OverlayThumb } from "./thumb.ts";
import { createRenderEffect, onCleanup } from "solid-js";
import { createScroller, type Scroller } from "../../kinetics.ts";
import { createElement, insertNode, setProp, type NodeMirror } from "../../renderer.ts";
import { Container, type BoxProps, type Instance, type Kind, type Rect, type ScrollTarget, type Size, type UINode, type UIRoot } from "./engine.ts";

export interface ScrollHandle {
  offset(): number;
  max(): number;
  scrollTo(offset: number, animated?: boolean): void;
  scrollBy(delta: number): void;
  /** bring a rectangle of the content (its coordinates) into view, with `margin` around it */
  reveal(rect: { y: number; h: number }, margin?: number): void;
  atEnd(slack?: number): boolean;
}

export interface ScrollProps extends BoxProps {
  /** room between children */
  spacing?: number;
  /** keep the end in view as content grows, while the reader is at the end */
  followEnd?: boolean;
  /** the content got within a screen of its end */
  onNearEnd?: () => void;
  onScroll?: (offset: number) => void;
  handle?: (handle: ScrollHandle) => void;
  /** "never": no scroll bar strip beside it, whatever the theme (a menu's short list) */
  bar?: "auto" | "never";
  children?: UINode;
}

export class ScrollInstance extends Container implements ScrollHandle {
  readonly scroller: Scroller;
  private contentH = 0;
  private spacing = 0;
  private thumb: OverlayThumb;

  constructor(private readonly scrollProps: ScrollProps, parent: Instance | null, root: UIRoot) {
    super(scrollProps, parent, root);
    const content = this.host;
    this.thumb = new OverlayThumb(this.node, root);
    setProp(this.node, "style", { overflow: 1 });
    this.scroller = createScroller({ max: () => this.max(), extent: () => this.h || 1 });
    createRenderEffect(() => {
      this.spacing = scrollProps.spacing ?? 0;
      this.invalidate();
    });
    let last = -1;
    let contentStyle: Record<string, number | string> = {};
    createRenderEffect(() => {
      const offset = this.scroller.offset();
      const next = { translateY: -offset };
      setProp(content, "style", next, contentStyle);
      contentStyle = next;
      if (offset !== last) {
        last = offset;
        this.thumb.touch();
        scrollProps.onScroll?.(offset);
        if (scrollProps.onNearEnd && this.max() - offset < this.h) scrollProps.onNearEnd();
      }
    });
    const step = () => {
      this.scroller.step();
      this.paintBar();
    };
    root.frameHooks.add(step);
    onCleanup(() => root.frameHooks.delete(step));
    scrollProps.handle?.(this);
  }

  protected override createHost(): NodeMirror {
    const content = createElement("view");
    setProp(content, "style", { posType: 1, insetL: 0, insetT: 0 });
    insertNode(this.node, content);
    return content;
  }

  protected override paint(): void {
    super.paint();
    this.style({ overflow: 1 });
  }

  private paintBar(): void {
    const strip = this.root.theme.traits.scroll === "strip" && this.scrollProps.bar !== "never";
    this.thumb.frame(this, this.max(), this.scroller.offset(), strip);
  }

  protected measureContent(maxW: number, maxH: number): Size {
    const pad = this.pad;
    const inner = maxW === Infinity ? Infinity : Math.max(0, maxW - pad.l - pad.r);
    let height = 0;
    let width = 0;
    let shown = 0;
    for (const child of this.list) {
      if (child.hidden) continue;
      const size = child.measure(inner, Infinity);
      height += size.h;
      width = Math.max(width, size.w);
      shown++;
    }
    if (shown > 1) height += this.spacing * (shown - 1);
    height += pad.t + pad.b;
    return { w: width + pad.l + pad.r, h: Math.min(height, maxH) };
  }

  protected override arrange(w: number, h: number): void {
    const pad = this.pad;
    const inner = Math.max(0, w - pad.l - pad.r);
    const wasAtEnd = this.scrollProps.followEnd === true && this.scroller.isAtEnd(4);
    let y = pad.t;
    for (const child of this.list) {
      if (child.hidden) continue;
      const size = child.measure(inner, Infinity);
      child.place(pad.l, Math.round(y), inner, Math.round(size.h));
      y += size.h + this.spacing;
    }
    const height = Math.max(0, y - this.spacing + pad.b);
    if (height !== this.contentH) {
      this.contentH = height;
      setProp(this.host, "style", { width: w, height: Math.max(height, h) });
    }
    if (wasAtEnd) this.scroller.scrollTo(this.max(), { immediate: true });
    else if (this.scroller.offset() > this.max()) this.scroller.scrollTo(this.max(), { immediate: true });
  }

  override contentOffset(): readonly [number, number] {
    return [0, -this.scroller.offset()];
  }

  override clips(): boolean {
    return true;
  }

  override scrollTarget(): ScrollTarget {
    return this;
  }

  offset(): number {
    return this.scroller.offset();
  }

  max(): number {
    return Math.max(0, this.contentH - this.h);
  }

  extent(): number {
    return this.h;
  }

  scrollTo(offset: number, animated = true): void {
    const to = Math.min(this.max(), Math.max(0, offset));
    if (animated) this.scroller.scrollTo(to);
    else this.scroller.scrollTo(to, { immediate: true });
  }

  scrollBy(delta: number): void {
    this.scroller.nudge(delta);
  }

  reveal(rect: { y: number; h: number }, margin = 8): void {
    const top = rect.y - margin;
    const bottom = rect.y + rect.h + margin;
    const at = this.scroller.intent();
    if (top < at) this.scroller.chaseTo(Math.max(0, top));
    else if (bottom > at + this.h) this.scroller.chaseTo(Math.min(this.max(), bottom - this.h));
  }

  atEnd(slack = 4): boolean {
    return this.scroller.isAtEnd(slack);
  }

  /** The visible part of the content, in content coordinates. */
  viewport(): Rect {
    return { x: 0, y: this.scroller.offset(), w: this.w, h: this.h };
  }
}

export const SCROLL: Kind<ScrollProps> = (props, parent, root) => new ScrollInstance(props, parent, root);
