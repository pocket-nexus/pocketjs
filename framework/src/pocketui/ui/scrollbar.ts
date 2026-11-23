// PocketUI ui/scrollbar.ts — the scroll bar where a theme's is a strip
// beside the content: a track, a thumb that is dragged, and, in the
// traditions that have them, a button at each end.
//
// The strip is a sibling of the scroll view it belongs to (primitives.ts
// puts the two in one row), not something drawn over it: it takes its width
// from the content, so text wraps short of it, and its pieces are instances
// the pointer and the theme treat like any other part. Where the theme's
// scroll bar is a thumb over the content (traits.scroll "overlay") the strip
// takes no room and the scroll view draws that thumb itself.
//
// Its width is there whether or not the content is longer than the window:
// a strip that came and went would change the width the content wraps to,
// and with it the content's height. With nothing to scroll, the track and
// the buttons show disabled and there is no thumb.
import { createRenderEffect, onCleanup } from "solid-js";
import { GLYPH } from "./glyph.ts";
import { Container, element, ZSTACK, type BoxProps, type Instance, type Kind, type ScrollTarget, type Size, type UIElement, type UINode, type UIRoot } from "./engine.ts";

export interface ScrollBarProps extends BoxProps {
  /** the scroll view this belongs to, once it is live */
  target: () => ScrollTarget | null;
  /** no strip, whatever the theme */
  never?: boolean;
}

const MIN_THUMB = 24;

class ScrollBarInstance extends Container {
  private thumb: Instance | undefined;
  private up: Instance | undefined;
  private down: Instance | undefined;
  private shown = false;
  private buttons = false;
  private side = 0;
  private last = "";

  constructor(private readonly barProps: ScrollBarProps, parent: Instance | null, root: UIRoot) {
    super(barProps, parent, root);
    createRenderEffect(() => {
      const theme = root.theme;
      this.shown = theme.traits.scroll === "strip" && barProps.never !== true;
      this.buttons = theme.traits.scrollButtons;
      this.side = theme.metric.scrollbar;
      this.last = "";
      this.invalidate();
    });
    const step = () => this.track();
    root.frameHooks.add(step);
    onCleanup(() => root.frameHooks.delete(step));
  }

  /** The pieces, placed by this instance: found by name once the children are live. */
  private pieces(): void {
    if (this.thumb) return;
    for (const child of this.list) {
      const name = child.props.name;
      if (name === "scroll.thumb") this.thumb = child;
      else if (name === "scroll.up") this.up = child;
      else if (name === "scroll.down") this.down = child;
    }
  }

  protected measureContent(_maxW: number, maxH: number): Size {
    return { w: this.shown ? this.side : 0, h: maxH === Infinity ? 0 : maxH };
  }

  protected override arrange(): void {
    this.last = "";
    this.track();
  }

  /** Each frame: the thumb where the content is. A place is two native props when it moved and nothing when it did not. */
  private track(): void {
    if (!this.shown || !this.placed) return;
    this.pieces();
    const target = this.barProps.target();
    const side = this.w;
    const button = this.buttons ? Math.min(side, Math.floor(this.h / 3)) : 0;
    const max = target ? target.max() : 0;
    const extent = target ? target.extent() : 0;
    const offset = target ? Math.min(max, Math.max(0, target.offset())) : 0;
    const key = `${side}|${this.h}|${button}|${max}|${extent}|${Math.round(offset * 4)}`;
    if (key === this.last) return;
    this.last = key;
    const lane = Math.max(0, this.h - 2 * button);
    this.up?.place(0, 0, side, button);
    this.down?.place(0, this.h - button, side, button);
    const thumb = this.thumb;
    if (!thumb) return;
    if (max <= 0 || lane < MIN_THUMB) {
      thumb.place(0, button, side, 0);
      return;
    }
    // the theme's thumb may sit inside the strip: a capsule in a channel
    const inset = this.root.theme.metric.thumbInset;
    const run = lane - 2 * inset;
    const length = Math.max(MIN_THUMB, Math.round((run * extent) / (extent + max)));
    thumb.place(inset, Math.round(button + inset + ((run - length) * offset) / max), side - 2 * inset, length);
  }

  /** How far the content moves for a point of thumb travel. */
  scale(): number {
    const target = this.barProps.target();
    const thumb = this.thumb;
    if (!target || !thumb) return 0;
    const button = this.buttons ? Math.min(this.w, Math.floor(this.h / 3)) : 0;
    const travel = this.h - 2 * button - thumb.h;
    return travel > 0 ? target.max() / travel : 0;
  }

  /** A tap on the track, above or below the thumb: a window's worth that way. */
  override tapped(_x: number, y: number): void {
    const target = this.barProps.target();
    const thumb = this.thumb;
    if (!target || !thumb || y < 0) return;
    if (y < thumb.y) target.scroller.nudge(-target.extent() * 0.9);
    else if (y > thumb.y + thumb.h) target.scroller.nudge(target.extent() * 0.9);
  }
}

/** The thumb's own instance: what input finds under a pan that starts on it. */
function thumbKind(bar: () => ScrollBarInstance | undefined, target: () => ScrollTarget | null): Kind<BoxProps & { children?: UINode }> {
  return (props, parent, root) => {
    const instance = ZSTACK(props, parent, root);
    instance.scrollTarget = () => {
      const real = target();
      const owner = bar();
      if (!real || !owner) return null;
      const scroller = real.scroller;
      return {
        scroller: { beginDrag: () => scroller.beginDrag(), drag: (delta: number) => scroller.drag(-delta * owner.scale()), endDrag: () => scroller.endDrag(0), stop: () => scroller.stop(), state: () => scroller.state(), nudge: (delta: number) => scroller.nudge(delta) },
        max: () => real.max(),
        offset: () => real.offset(),
        extent: () => real.extent(),
        reveal: () => {},
      };
    };
    return instance;
  };
}

export const SCROLLBAR: Kind<ScrollBarProps> = (props, parent, root) => {
  let bar: ScrollBarInstance | undefined;
  const line = (by: number) => () => props.target()?.scroller.nudge(by);
  const button = (name: string, glyph: "up" | "down", by: number): UIElement =>
    element(ZSTACK, {
      name,
      part: "scroll.button",
      // a strip without buttons gives them no height: nothing of them shows
      clip: true,
      focusable: false,
      onPress: line(by),
      children: element(GLYPH, { glyph, size: 7, anchor: "center", state: { variant: "scroll" } }) as UINode,
    });
  const children = [
    button("scroll.up", "up", -40),
    button("scroll.down", "down", 40),
    element(thumbKind(() => bar, props.target), { name: "scroll.thumb", part: "scroll.thumb", children: element(GLYPH, { glyph: "grip", size: 8, anchor: "center", state: { variant: "scroll" } }) as UINode }),
  ];
  bar = new ScrollBarInstance(
    {
      part: "scroll.track",
      focusable: false,
      onPress: () => {},
      get target() {
        return props.target;
      },
      get never() {
        return props.never;
      },
      get hidden() {
        return props.hidden === true || props.never === true || root.theme.traits.scroll !== "strip";
      },
      children: children as UINode,
    } as ScrollBarProps,
    parent,
    root,
  );
  return bar;
};
