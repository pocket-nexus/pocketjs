// PocketUI ui/feed.ts — the Feed element: rows of any height, any number,
// that stay where the reader left them (core/feed.ts holds the rule).
//
// Only the rows near the window are mounted. A mounted row is an ordinary
// instance: it measures itself at the feed's width, and when its content
// changes (a paragraph streaming in) it invalidates the feed, which measures
// it again and tells the model; the model answers with how far the offset
// moved to keep the anchor still, and the scroller is rebased by that much
// in the same pass, so the correction and the new positions reach the screen
// in one frame.
import { OverlayThumb } from "./thumb.ts";
import { createRenderEffect, createRoot, createSignal, getOwner, onCleanup, runWithOwner, untrack, type Accessor, type Owner } from "solid-js";
import { createScroller, type Scroller } from "../../kinetics.ts";
import { createElement, insertNode, setProp, type NodeMirror } from "../../renderer.ts";
import { FeedModel, type FeedAnchor } from "../core/feed.ts";
import { element, elementsOf, Instance, instantiate, VSTACK, type BoxProps, type Kind, type ScrollTarget, type Size, type UIElement, type UINode, type UIRoot } from "./engine.ts";

export interface FeedHandle {
  /** go to the end and follow it */
  toEnd(animated?: boolean): void;
  toKey(key: string, align?: "start" | "nearest" | "end"): void;
  atEnd(): boolean;
  /** where the reader is, to hand back as `position` after a remount; null while following the end */
  position(): FeedAnchor | null;
  scrollBy(delta: number): void;
}

export interface FeedProps<T> extends BoxProps {
  each: readonly T[];
  /** a row's identity: the same key keeps its instance and its height */
  by: (item: T) => string;
  /** a row's content */
  children: (item: Accessor<T>, index: Accessor<number>) => UINode;
  spacing?: number;
  /** a row's height before it is measured */
  estimate?: number;
  /** start at the end and keep it in view while the reader is there (a transcript) */
  followEnd?: boolean;
  /** where the reader was (FeedHandle.position()), to return to */
  position?: FeedAnchor | null;
  /** the window got within a screen of the first row: load older rows */
  onNearStart?: () => void;
  onNearEnd?: () => void;
  /** whether the reader is at the end, when that changes */
  onAtEnd?: (atEnd: boolean) => void;
  /** rows kept mounted beyond the window, in window heights (default 0.75) */
  overscan?: number;
  handle?: (handle: FeedHandle) => void;
  /** "never": no scroll bar strip beside it, whatever the theme */
  bar?: "auto" | "never";
}

interface Row<T> {
  key: string;
  instance: Instance;
  item: T;
  setItem(item: T): void;
  setIndex(index: number): void;
  dispose(): void;
}

class FeedInstance<T> extends Instance implements ScrollTarget, FeedHandle {
  readonly scroller: Scroller;
  private readonly model: FeedModel;
  private readonly content: NodeMirror;
  private readonly thumb: OverlayThumb;
  private rows = new Map<string, Row<T>>();
  private order: Instance[] = [];
  private items: readonly T[] = [];
  private byKey = new Map<string, T>();
  private readonly owner: Owner | null;
  /** the scroller is being moved by the model, not by the reader */
  private rebasing = false;
  private wasAtEnd: boolean | null = null;
  private lastWindow = "";

  constructor(private readonly feedProps: FeedProps<T>, parent: Instance | null, root: UIRoot) {
    super(feedProps, parent, root);
    this.owner = getOwner();
    const pad = untrack(() => this.pad);
    this.model = new FeedModel({ estimate: untrack(() => feedProps.estimate), gap: untrack(() => feedProps.spacing) ?? 0, padStart: pad.t, padEnd: pad.b });
    this.model.following = untrack(() => feedProps.followEnd) === true;
    this.content = createElement("view");
    setProp(this.content, "style", { posType: 1, insetL: 0, insetT: 0 });
    insertNode(this.node, this.content);
    this.thumb = new OverlayThumb(this.node, root);
    this.scroller = createScroller({ max: () => this.model.max(), extent: () => this.h || 1 });

    // the rows
    let first = true;
    createRenderEffect(() => {
      const items = feedProps.each;
      untrack(() => {
        const by = feedProps.by;
        const keys: string[] = new Array(items.length);
        const map = new Map<string, T>();
        for (let i = 0; i < items.length; i++) {
          const key = by(items[i]!);
          keys[i] = key;
          map.set(key, items[i]!);
        }
        this.items = items;
        this.byKey = map;
        this.rebase(this.model.setKeys(keys));
        if (first) {
          first = false;
          if (feedProps.position) this.model.restore(feedProps.position);
        }
        for (const row of this.rows.values()) {
          const item = map.get(row.key);
          if (item !== undefined && item !== row.item) {
            row.item = item;
            row.setItem(item);
          }
        }
        this.lastWindow = "";
        this.invalidate();
      });
    });

    // the offset
    let contentStyle: Record<string, number | string> = {};
    createRenderEffect(() => {
      const offset = this.scroller.offset();
      const next = { translateY: -offset };
      setProp(this.content, "style", next, contentStyle);
      contentStyle = next;
      untrack(() => {
        this.thumb.touch();
        if (this.rebasing) return;
        this.model.scrollTo(offset);
        this.afterScroll();
      });
    });
    const step = () => {
      this.scroller.step();
      this.paintBar();
    };
    root.frameHooks.add(step);
    onCleanup(() => {
      root.frameHooks.delete(step);
      for (const row of this.rows.values()) row.dispose();
      this.rows.clear();
    });
    feedProps.handle?.(this);
  }

  protected override paint(): void {
    super.paint();
    this.style({ overflow: 1 });
  }

  /** Shift the scroller by what the model moved, so the two agree. */
  private rebase(delta: number): void {
    if (delta === 0) return;
    this.rebasing = true;
    this.scroller.rebase(delta);
    this.rebasing = false;
  }

  /** After the window moved: mount what it now needs, and say where the reader is. */
  private afterScroll(): void {
    const overscan = (this.feedProps.overscan ?? 0.75) * this.h;
    const win = this.model.window(overscan);
    const name = win ? `${win[0]}:${win[1]}` : "";
    if (name !== this.lastWindow) this.invalidate();
    const props = this.feedProps;
    const top = this.model.scrollTop;
    if (props.onNearStart && top < this.h && this.model.count > 0) props.onNearStart();
    if (props.onNearEnd && this.model.max() - top < this.h) props.onNearEnd();
    const atEnd = this.model.atEnd();
    if (atEnd !== this.wasAtEnd) {
      this.wasAtEnd = atEnd;
      props.onAtEnd?.(atEnd);
    }
  }

  private mount(key: string, index: number): Row<T> {
    const item = this.byKey.get(key)!;
    return runWithOwner(this.owner, () =>
      createRoot((dispose) => {
        const [current, setItem] = createSignal(item, { equals: false });
        const [at, setIndex] = createSignal(index);
        const elements = elementsOf(this.feedProps.children(current, at));
        const el: UIElement = elements.length === 1 ? elements[0]! : element(VSTACK, { children: elements as UINode });
        const instance = instantiate(el, this, this.root, getOwner());
        insertNode(this.content, instance.node, null);
        return { key, instance, item, setItem, setIndex, dispose: () => { instance.dispose(); dispose(); } };
      }),
    )!;
  }

  protected measureContent(maxW: number, maxH: number): Size {
    // a feed takes what it is offered: it has no natural height
    return { w: maxW === Infinity ? 0 : maxW, h: maxH === Infinity ? 0 : maxH };
  }

  protected override arrange(w: number, h: number): void {
    const pad = this.pad;
    const inner = Math.max(0, w - pad.l - pad.r);
    const model = this.model;
    let moved = model.setViewport(h);
    const overscan = (this.feedProps.overscan ?? 0.75) * h;
    let win: [number, number] | null = null;
    // heights learnt in a round can change which rows the window holds
    for (let round = 0; round < 4; round++) {
      win = model.window(overscan);
      let learnt = false;
      if (win) {
        for (let i = win[0]; i <= win[1]; i++) {
          const key = model.keyAt(i)!;
          let row = this.rows.get(key);
          if (!row) {
            row = this.mount(key, i);
            this.rows.set(key, row);
          } else row.setIndex(i);
          const size = row.instance.measure(inner, Infinity);
          const delta = model.setHeight(key, Math.ceil(size.h));
          if (delta !== 0 || !row.instance.placed) learnt = true;
          moved += delta;
        }
      }
      if (!learnt) break;
    }
    // rows that left the window
    for (const [key, row] of this.rows) {
      const at = model.indexOf(key);
      if (at < 0 || !win || at < win[0] || at > win[1]) {
        row.dispose();
        this.rows.delete(key);
      }
    }
    this.order.length = 0;
    if (win) {
      for (let i = win[0]; i <= win[1]; i++) {
        const key = model.keyAt(i)!;
        const row = this.rows.get(key)!;
        row.instance.place(pad.l, Math.round(model.topOf(i)), inner, model.heightOf(key));
        this.order.push(row.instance);
      }
      this.lastWindow = `${win[0]}:${win[1]}`;
    } else this.lastWindow = "";
    setProp(this.content, "style", { width: w, height: Math.max(model.total(), h) });
    this.rebase(moved);
    // the first layout of a feed that follows its end starts there
    if (Math.abs(this.scroller.offset() - model.scrollTop) > 0.5 && this.scroller.state() === "idle") {
      this.rebasing = true;
      this.scroller.scrollTo(model.scrollTop, { immediate: true });
      this.rebasing = false;
    }
    const atEnd = model.atEnd();
    if (atEnd !== this.wasAtEnd) {
      this.wasAtEnd = atEnd;
      this.feedProps.onAtEnd?.(atEnd);
    }
  }

  private paintBar(): void {
    const strip = this.root.theme.traits.scroll === "strip" && this.feedProps.bar !== "never";
    this.thumb.frame(this, this.model.max(), this.scroller.offset(), strip);
  }

  override kids(): readonly Instance[] {
    return this.order;
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

  extent(): number {
    return this.h;
  }

  max(): number {
    return this.model.max();
  }

  reveal(rect: { y: number; h: number }, margin = 8): void {
    const top = rect.y - margin;
    const bottom = rect.y + rect.h + margin;
    const at = this.scroller.intent();
    if (top < at) this.scroller.chaseTo(Math.max(0, top));
    else if (bottom > at + this.h) this.scroller.chaseTo(Math.min(this.max(), bottom - this.h));
  }

  toEnd(animated = true): void {
    this.model.followEnd();
    if (animated) this.scroller.scrollTo(this.model.max());
    else {
      this.rebasing = true;
      this.scroller.scrollTo(this.model.max(), { immediate: true });
      this.rebasing = false;
    }
    this.invalidate();
  }

  toKey(key: string, align: "start" | "nearest" | "end" = "start"): void {
    this.model.scrollToKey(key, align, 8);
    this.scroller.scrollTo(this.model.scrollTop);
    this.invalidate();
  }

  atEnd(): boolean {
    return this.model.atEnd();
  }

  position(): FeedAnchor | null {
    return this.model.anchor();
  }

  scrollBy(delta: number): void {
    this.scroller.nudge(delta);
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const FEED: Kind<FeedProps<any>> = (props, parent, root) => new FeedInstance(props, parent, root);
