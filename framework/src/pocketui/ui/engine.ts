// PocketUI ui/engine.ts — the element tree and its layout pass.
//
// PocketJS gives an app three node types under a flexbox the app cannot read
// back: no laid-out rectangle reaches JavaScript, and text does not wrap. A
// production tool needs both (a transcript's rows have the height their text
// wraps to, a focus move picks the nearest control, a menu opens beside what
// it belongs to), so PocketUI lays its own tree out:
//
//   element   what a component returns: `{ kind, props }`, with the props
//             Solid's JSX compiled as getters. A component is a function
//             from props to an element, as a SwiftUI view's body is.
//   instance  one live element: it owns a native node, positions it
//             absolutely and knows its rectangle. Measuring is a pure
//             function of the size offered (`measure(maxW, maxH)`); placing
//             writes the rectangle (`place(x, y, w, h)`).
//   root      owns the surface: one layout pass per frame over the instances
//             a change dirtied, then input and focus over known rectangles.
//
// Reactivity is Solid's, at the grain of one prop: a prop that changes the
// size (text, padding, a child list) invalidates the path to the root and the
// next pass measures that path again; a prop that only paints (a colour) sets
// one native prop and no layout runs.
import { children as resolveChildren, createMemo, createRenderEffect, createRoot, createSignal, getOwner, onCleanup, runWithOwner, untrack, type Accessor, type JSX, type Owner } from "solid-js";
import { createElement, detachNode, getNextSibling, insertNode, setProp, type NodeMirror } from "../../renderer.ts";
import { inkOf, type Ink, type Layer, type Paint, type Part, type TextRole, type Theme, type Tone } from "./theme.ts";

// ---------------------------------------------------------------------------
// Elements
// ---------------------------------------------------------------------------

/** An element is typed as a node of Solid's JSX (`Node` is the opaque type
 *  PocketJS declares in framework/src/jsx.d.ts), so a component that returns
 *  one is a JSX component and elements are valid JSX children. It is never a
 *  native node: only a PocketUI container makes it live. */
export interface UIElement extends Node {
  readonly $$pui: true;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  readonly kind: Kind<any>;
  readonly props: unknown;
  /** the reactive scope the component ran in: the instance's own scope is
   *  made under it, so context a component could read (the UI, the command
   *  centre) is there for what the instance creates later (a feed's rows) */
  readonly owner: Owner | null;
}

/** What makes an element live. */
export type Kind<P> = (props: P, parent: Instance | null, root: UIRoot) => Instance;

/** What a component may return or take as children. */
export type UINode = JSX.Element;

export function element<P>(kind: Kind<P>, props: P): UIElement {
  return { $$pui: true, kind, props, owner: getOwner() } as unknown as UIElement;
}

function isElement(value: unknown): value is UIElement {
  return typeof value === "object" && value !== null && (value as UIElement).$$pui === true;
}

/** The elements in a resolved child list, in order. Strings are text for
 *  `Text` alone; anywhere else they are not elements and are dropped. */
export function elementsOf(value: unknown, out: UIElement[] = []): UIElement[] {
  if (Array.isArray(value)) for (const item of value) elementsOf(item, out);
  else if (typeof value === "function") elementsOf((value as () => unknown)(), out);
  else if (isElement(value)) out.push(value);
  return out;
}

// ---------------------------------------------------------------------------
// Props every element takes
// ---------------------------------------------------------------------------

export type Align = "start" | "center" | "end" | "stretch";
export type Anchor = "topLeading" | "top" | "topTrailing" | "leading" | "center" | "trailing" | "bottomLeading" | "bottom" | "bottomTrailing";
export type Edges = number | readonly [number, number] | readonly [number, number, number, number];

export interface BoxProps {
  /** a fixed size in points, or "fill": all that is offered */
  width?: number | "fill";
  height?: number | "fill";
  minWidth?: number;
  maxWidth?: number;
  minHeight?: number;
  maxHeight?: number;
  /** the share of a stack's leftover main-axis room this takes */
  grow?: number;
  /** across a stack's main axis, in place of the stack's `align` */
  alignSelf?: Align;
  /** in a ZStack: hug the content and sit at this corner or edge instead of filling */
  anchor?: Anchor;
  /** all sides, [vertical, horizontal] or [top, right, bottom, left] */
  padding?: Edges;
  /** takes no room and paints nothing */
  hidden?: boolean;

  /** what this is, for the theme to paint: its fill, edge, the ink and the
   *  padding of what is inside come from the active theme, in the state the
   *  element is in. The paint props below, where given, replace the theme's. */
  part?: Part;
  /** the part's kind: a button's "filled", a bubble's "self" */
  variant?: string;
  /** the part's meaning, where it has one: a badge that warns */
  tone?: Tone;
  /** state for the part: the row that is open, the toggle that is on */
  selected?: boolean;
  /** state for the part: its frame has the input (default true) */
  active?: boolean;

  background?: string;
  radius?: number;
  borderColor?: string;
  borderWidth?: number;
  opacity?: number;
  /** paint nothing outside the box */
  clip?: boolean;
  shadow?: 0 | 1 | 2 | 3;
  /** paint-only offset from the laid-out place, [dx, dy] */
  offset?: readonly [number, number];

  /** a tap, a click, or confirm while focused */
  onPress?: () => void;
  onLongPress?: () => void;
  /** takes the d-pad's focus; default: whether it has an onPress */
  focusable?: boolean;
  disabled?: boolean;
  /** shown while a finger is down on it, or it is pressed by a button */
  pressedBackground?: string;
  /** shown while it has the d-pad's focus, in place of the focus ring */
  focusedBackground?: string;
  /** called when focus arrives or leaves */
  onFocus?: (focused: boolean) => void;
  /** where a d-pad's focus first lands in its scope */
  autoFocus?: boolean;

  /** the name in DevTools and in test queries */
  name?: string;
  ref?: (instance: Instance) => void;
}

export interface Size {
  w: number;
  h: number;
}

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** The moving part of a scroll view, as input drives it. */
export interface ScrollTarget {
  /** PocketJS's kinetic scroller (framework/src/kinetics-core.ts) */
  scroller: { beginDrag(): void; drag(delta: number): void; endDrag(velocity: number): void; stop(): void; state(): string; nudge(delta: number): void };
  max(): number;
  offset(): number;
  /** the height of the window onto the content */
  extent(): number;
  /** bring a rectangle of the content (its coordinates) into view */
  reveal(rect: { y: number; h: number }, margin?: number): void;
}

/** A pan an instance took: it hears every move and the release. */
export interface PanSession {
  move(dx: number, dy: number): void;
  /** `vx`, `vy`: the release velocity in points a second */
  end(vx: number, vy: number, cancelled: boolean): void;
}

export interface Pad {
  t: number;
  r: number;
  b: number;
  l: number;
}
const NO_PAD: Pad = { t: 0, r: 0, b: 0, l: 0 };

function padOf(edges: Edges | undefined): Pad {
  if (edges === undefined) return NO_PAD;
  if (typeof edges === "number") return edges === 0 ? NO_PAD : { t: edges, r: edges, b: edges, l: edges };
  if (edges.length === 2) return { t: edges[0], r: edges[1], b: edges[0], l: edges[1] };
  return { t: edges[0], r: edges[1], b: edges[2]!, l: edges[3]! };
}

const clamp = (value: number, min: number | undefined, max: number | undefined) => {
  let out = value;
  if (max !== undefined && out > max) out = max;
  if (min !== undefined && out < min) out = min;
  return out;
};

// ---------------------------------------------------------------------------
// Instances
// ---------------------------------------------------------------------------

type Style = Record<string, number | string>;

export abstract class Instance {
  readonly node: NodeMirror;
  parent: Instance | null;
  readonly root: UIRoot;
  /** the rectangle, in the parent's content space */
  x = 0;
  y = 0;
  w = 0;
  h = 0;
  /** laid out at least once */
  placed = false;

  // layout props, read in one effect
  protected fixedW: number | undefined;
  protected fixedH: number | undefined;
  protected fillW = false;
  protected fillH = false;
  protected minW: number | undefined;
  protected maxW: number | undefined;
  protected minH: number | undefined;
  protected maxH: number | undefined;
  grow = 0;
  alignSelf: Align | undefined;
  anchor: Anchor | undefined;
  hidden = false;
  protected pad: Pad = NO_PAD;

  // interaction
  readonly props: BoxProps;
  pressed = false;
  focused = false;
  hovered = false;

  /** the paint the theme gives this part now; undefined: it names no part */
  look: Accessor<Paint> | undefined;
  private bump: ((value: number) => void) | undefined;
  private ticks = 0;
  private decor: NodeMirror[] = [];
  private layers: readonly Layer[] = NO_LAYERS;
  private given: readonly Layer[] = NO_LAYERS;
  /** a view node: it can hold the layers a part paints under its content (a text node cannot) */
  private readonly box: boolean;
  private nudgeX = 0;
  private nudgeY = 0;

  private dirty = true;
  private cacheA: [number, number, number, number] | null = null;
  private cacheB: [number, number, number, number] | null = null;
  private frameStyle: Style = {};
  private paintStyle: Style = {};
  private disposer: (() => void) | undefined;

  constructor(props: BoxProps, parent: Instance | null, root: UIRoot, tag: "view" | "text" | "image" = "view") {
    this.props = props;
    this.parent = parent;
    this.root = root;
    this.node = createElement(tag);
    this.box = tag === "view";
    setProp(this.node, "style", { posType: 1 });
    let lookPad: Accessor<Paint["pad"]> | undefined;
    if ("part" in props) {
      const [tick, setTick] = createSignal(0);
      this.bump = setTick;
      const look = createMemo<Paint>(() => {
        const part = props.part;
        if (!part) return NO_PAINT;
        tick();
        return root.theme.paint(part, { pressed: this.pressed, focused: this.focused, hovered: this.hovered, disabled: props.disabled === true, selected: props.selected === true, active: props.active !== false, variant: props.variant, tone: props.tone });
      });
      this.look = look;
      // a state that only repaints (pressed) leaves the padding, and so the layout, alone
      lookPad = createMemo(() => look().pad, undefined, { equals: sameEdges });
    }
    createRenderEffect(() => {
      const width = props.width;
      const height = props.height;
      this.fixedW = typeof width === "number" ? width : undefined;
      this.fixedH = typeof height === "number" ? height : undefined;
      this.fillW = width === "fill";
      this.fillH = height === "fill";
      this.minW = props.minWidth;
      this.maxW = props.maxWidth;
      this.minH = props.minHeight;
      this.maxH = props.maxHeight;
      this.grow = props.grow ?? 0;
      this.alignSelf = props.alignSelf;
      this.anchor = props.anchor;
      this.pad = padOf(props.padding ?? lookPad?.());
      const hidden = props.hidden === true;
      if (hidden !== this.hidden) {
        this.hidden = hidden;
        this.style({ display: hidden ? 1 : 0 });
      }
      this.invalidate();
    });
  }

  /** Called once the constructors have run (instantiate): the effects that
   *  call methods a subclass overrides start here, when the subclass's own
   *  fields exist. A render effect runs where it is created, so one made in
   *  this class's constructor would call an override before its class had
   *  initialised. */
  mounted(): void {
    const props = this.props;
    createRenderEffect(() => this.paint());
    if (props.name) createRenderEffect(() => setProp(this.node, "debugName", props.name));
    if (props.ref) props.ref(this);
  }

  /** Paint-only props onto the node: the theme's paint for the part, under the props that name a paint themselves. */
  protected paint(): void {
    const props = this.props;
    const look = this.look ? this.look() : NO_PAINT;
    const next: Style = {};
    let background = props.background ?? look.fill;
    let gradient = props.background === undefined ? look.gradient : undefined;
    if (this.focused && props.focusedBackground) (background = props.focusedBackground), (gradient = undefined);
    if (this.pressed && props.pressedBackground) (background = props.pressedBackground), (gradient = undefined);
    next.bgColor = background ?? CLEAR;
    if (gradient) {
      next.gradFrom = gradient[0];
      next.gradTo = gradient[gradient.length - 1]!;
      next.gradDir = GRAD_DIR[look.gradientDir ?? "down"];
      if (gradient.length === 3) {
        next.gradVia = gradient[1]!;
        next.gradViaPos = look.gradientMid ?? 0.5;
      } else next.gradViaPos = NaN;
    } else next.gradDir = NO_GRADIENT;
    const radius = props.radius ?? look.radius ?? 0;
    next.radius = radius;
    const borderColor = props.borderColor ?? look.border;
    const borderWidth = props.borderWidth ?? (borderColor !== undefined ? (look.borderWidth ?? 1) : 0);
    // A rounded box with an edge is two rounded boxes, the edge's colour and,
    // inside it by the edge's width, the body: the core's own rounded border
    // thins to a hair along the arcs, and a capsule's rim came out uneven.
    let body: Layer | undefined;
    if (this.box && radius > 0 && borderColor !== undefined && borderWidth > 0 && (gradient ? gradient.every(opaque) : background !== undefined && opaque(background))) {
      body = { l: borderWidth, t: borderWidth, r: borderWidth, b: borderWidth, radius: Math.max(0, radius - borderWidth), fill: gradient ? undefined : background, gradient, gradientDir: look.gradientDir, gradientMid: look.gradientMid };
      next.bgColor = borderColor;
      next.gradDir = NO_GRADIENT;
      next.borderWidth = 0;
      next.borderColor = CLEAR;
    } else {
      next.borderWidth = borderWidth;
      next.borderColor = borderColor ?? CLEAR;
    }
    const bevel = radius > 0 ? undefined : look.bevel;
    next.bevelOuterLight = bevel?.outerLight ?? CLEAR;
    next.bevelOuterDark = bevel?.outerDark ?? CLEAR;
    next.bevelInnerLight = bevel?.innerLight ?? CLEAR;
    next.bevelInnerDark = bevel?.innerDark ?? CLEAR;
    next.bevelWidth = bevel?.width ?? 1;
    next.opacity = props.opacity ?? look.opacity ?? (props.disabled ? 0.45 : 1);
    next.overflow = props.clip ? 1 : 0;
    next.shadow = props.shadow ?? look.shadow ?? 0;
    next.translateX = (props.offset ? props.offset[0] : 0) + this.nudgeX;
    next.translateY = (props.offset ? props.offset[1] : 0) + this.nudgeY;
    this.style(next);
    if (this.look || body) {
      const under = look.under ?? NO_LAYERS;
      this.setLayers(body ? [body, ...under] : under);
      const nudge = look.nudge;
      const dx = nudge ? nudge[0] : 0;
      const dy = nudge ? nudge[1] : 0;
      for (const kid of this.kids()) kid.nudge(dx, dy);
    }
  }

  /** Moved with the part it is inside (a pressed button's label). */
  nudge(dx: number, dy: number): void {
    if (dx === this.nudgeX && dy === this.nudgeY) return;
    this.nudgeX = dx;
    this.nudgeY = dy;
    untrack(() => this.paint());
  }

  /** The rectangles the part paints under its content: one native node each, before the content's. */
  private setLayers(given: readonly Layer[]): void {
    if (given === this.given) return;
    this.given = given;
    // a rounded layer with an edge is drawn the way a rounded part is: edge, then body inside it
    let layers = given;
    if (given.some(rimmed)) {
      const out: Layer[] = [];
      for (const layer of given) {
        if (!rimmed(layer)) {
          out.push(layer);
          continue;
        }
        const width = layer.borderWidth ?? 1;
        out.push({ l: layer.l, t: layer.t, r: layer.r, b: layer.b, w: layer.w, h: layer.h, hFrac: layer.hFrac, radius: layer.radius, fill: layer.border, opacity: layer.opacity });
        out.push({ ...layer, border: undefined, l: (layer.l ?? 0) + width, t: (layer.t ?? 0) + width, r: (layer.r ?? 0) + width, b: (layer.b ?? 0) + width, radius: Math.max(0, (layer.radius ?? 0) - width) });
      }
      layers = out;
    }
    this.layers = layers;
    if (!this.box) return;
    const decor = this.decor;
    while (decor.length > layers.length) {
      const node = decor.pop()!;
      if (node.parent) detachNode(node.parent, node);
    }
    while (decor.length < layers.length) {
      const node = createElement("view");
      setProp(node, "style", { posType: 1, hitPass: 1 });
      insertNode(this.node, node, this.node.children[decor.length] ?? null);
      decor.push(node);
    }
    for (let i = 0; i < layers.length; i++) {
      const layer = layers[i]!;
      const style: Style = { bgColor: layer.fill ?? CLEAR, radius: layer.radius ?? 0, opacity: layer.opacity ?? 1 };
      const gradient = layer.gradient;
      if (gradient) {
        style.gradFrom = gradient[0];
        style.gradTo = gradient[gradient.length - 1]!;
        style.gradDir = GRAD_DIR[layer.gradientDir ?? "down"];
        if (gradient.length === 3) {
          style.gradVia = gradient[1]!;
          style.gradViaPos = layer.gradientMid ?? 0.5;
        } else style.gradViaPos = NaN;
      } else style.gradDir = NO_GRADIENT;
      style.borderWidth = layer.border !== undefined ? (layer.borderWidth ?? 1) : 0;
      style.borderColor = layer.border ?? CLEAR;
      const bevel = layer.radius ? undefined : layer.bevel;
      style.bevelOuterLight = bevel?.outerLight ?? CLEAR;
      style.bevelOuterDark = bevel?.outerDark ?? CLEAR;
      style.bevelInnerLight = bevel?.innerLight ?? CLEAR;
      style.bevelInnerDark = bevel?.innerDark ?? CLEAR;
      style.bevelWidth = bevel?.width ?? 1;
      setProp(decor[i]!, "style", style);
    }
    if (this.placed) this.placeLayers();
  }

  private placeLayers(): void {
    const W = this.w;
    const H = this.h;
    for (let i = 0; i < this.decor.length; i++) {
      const layer = this.layers[i]!;
      const w = layer.w ?? Math.max(0, W - (layer.l ?? 0) - (layer.r ?? 0));
      const h = layer.h ?? (layer.hFrac !== undefined ? Math.round(H * layer.hFrac) : Math.max(0, H - (layer.t ?? 0) - (layer.b ?? 0)));
      const x = layer.l !== undefined ? layer.l : layer.r !== undefined ? W - layer.r - w : 0;
      const y = layer.t !== undefined ? layer.t : layer.b !== undefined ? H - layer.b - h : 0;
      setProp(this.decor[i]!, "style", { insetL: x, insetT: y, width: w, height: h });
    }
  }

  /** The colour content of `tone` takes here: the nearest part's ink for it, else the theme's. A signal read. */
  inkFor(tone: Tone | undefined): string {
    const key: keyof Ink = tone === undefined || tone === "plain" ? "text" : tone;
    for (let p: Instance | null = this; p; p = p.parent) {
      const ink = p.look?.().ink;
      if (ink && ink[key] !== undefined) return ink[key]!;
    }
    return inkOf(tone, undefined, this.root.theme.color);
  }

  /** The face a text here takes when it names none: the nearest part's, else body. A signal read. */
  roleFor(): TextRole {
    for (let p: Instance | null = this; p; p = p.parent) {
      const role = p.look?.().text;
      if (role !== undefined) return role;
    }
    return "body";
  }

  /** Set native style props, skipping the ones that hold that value already. */
  protected style(next: Style): void {
    setProp(this.node, "style", next, this.paintStyle);
    this.paintStyle = { ...this.paintStyle, ...next };
  }

  /** The size this wants when offered at most `maxW` x `maxH` (Infinity: unbounded). */
  measure(maxW: number, maxH: number): Size {
    if (this.hidden) return { w: 0, h: 0 };
    const a = this.cacheA;
    if (a && a[0] === maxW && a[1] === maxH) return { w: a[2], h: a[3] };
    const b = this.cacheB;
    if (b && b[0] === maxW && b[1] === maxH) return { w: b[2], h: b[3] };
    const offerW = this.fixedW ?? clamp(maxW, undefined, this.maxW);
    const offerH = this.fixedH ?? clamp(maxH, undefined, this.maxH);
    const content = this.measureContent(offerW, offerH);
    const w = this.fixedW ?? (this.fillW && offerW !== Infinity ? offerW : clamp(Math.min(content.w, offerW), this.minW, this.maxW));
    const h = this.fixedH ?? (this.fillH && offerH !== Infinity ? offerH : clamp(Math.min(content.h, offerH), this.minH, this.maxH));
    this.cacheB = this.cacheA;
    this.cacheA = [maxW, maxH, w, h];
    return { w, h };
  }

  /** The content's size including padding, offered `maxW` x `maxH`. */
  protected abstract measureContent(maxW: number, maxH: number): Size;

  /** Position children inside w x h. */
  protected arrange(_w: number, _h: number): void {}

  /** Take the rectangle the parent decided. */
  place(x: number, y: number, w: number, h: number): void {
    const moved = x !== this.x || y !== this.y;
    const resized = w !== this.w || h !== this.h;
    if (moved || resized || !this.placed) {
      this.x = x;
      this.y = y;
      this.w = w;
      this.h = h;
      const next: Style = { insetL: x, insetT: y, width: w, height: h };
      setProp(this.node, "style", next, this.frameStyle);
      this.frameStyle = next;
      if (resized && this.decor.length > 0) this.placeLayers();
    }
    if (this.dirty || resized || !this.placed) {
      const first = !this.placed;
      this.placed = true;
      this.dirty = false;
      if (first && this.decor.length > 0) this.placeLayers();
      this.arrange(w, h);
    }
  }

  /** A size-affecting change: the path to the root is measured again next pass. */
  invalidate(): void {
    this.cacheA = null;
    this.cacheB = null;
    if (this.dirty && this.parent?.isDirty()) return;
    this.dirty = true;
    if (this.parent) this.parent.invalidate();
    else this.root.schedule();
  }

  isDirty(): boolean {
    return this.dirty;
  }

  /** Child instances, back to front. */
  kids(): readonly Instance[] {
    return NONE;
  }

  /** Where children's coordinates start, relative to this rectangle (a scroll view's content moves). */
  contentOffset(): readonly [number, number] {
    return ORIGIN;
  }

  /** Whether children outside the rectangle are neither painted nor hit. */
  clips(): boolean {
    return this.props.clip === true;
  }

  /** This rectangle in the surface's coordinates. */
  frame(): Rect {
    let x = this.x;
    let y = this.y;
    for (let p = this.parent; p; p = p.parent) {
      const [ox, oy] = p.contentOffset();
      x += p.x + ox;
      y += p.y + oy;
    }
    return { x, y, w: this.w, h: this.h };
  }

  /** a scroll view: a pan inside it moves its content */
  scrolls(): boolean {
    return this.scrollTarget() !== null;
  }

  /** Take a horizontal pan that started inside this instance: a pane that
   *  follows the finger back. Null: not this one's. */
  claimPan(_dx: number, _dy: number): PanSession | null {
    return null;
  }

  /** Take a pan that started on this instance at (x, y) of its rectangle, in
   *  any direction, before a scroll view does: a selection drawn through a
   *  field's text. Null: not this one's. */
  claimDrag(_x: number, _y: number): PanSession | null {
    return null;
  }

  /** What a pan, the d-pad and a focus move drive when this scrolls. */
  scrollTarget(): ScrollTarget | null {
    return null;
  }

  /** Whether a point inside this box stops here: a box that paints nothing
   *  and takes no press lets the point through to what is behind it. */
  blocksHit(): boolean {
    return this.interactive || this.props.background !== undefined || this.props.part !== undefined || this.scrolls();
  }

  /** A tap or a click landed at (x, y) of this rectangle, or confirm was pressed while it had the focus (then x and y are -1). */
  tapped(_x: number, _y: number): void {
    this.props.onPress?.();
  }

  /** A finger went down on it or lifted: one repaint, no layout. */
  setPressed(pressed: boolean): void {
    if (pressed === this.pressed) return;
    this.pressed = pressed;
    this.repaint();
  }

  /** The state changed: the part's paint is looked up again, or the paint props applied. */
  protected repaint(): void {
    if (this.bump) this.bump(++this.ticks);
    else untrack(() => this.paint());
  }

  /** A pointer came to rest on it or left: a repaint where the part's look says so. */
  setHovered(hovered: boolean): void {
    if (hovered === this.hovered) return;
    this.hovered = hovered;
    if (this.bump) this.bump(++this.ticks);
  }

  setFocused(focused: boolean): void {
    if (focused === this.focused) return;
    this.focused = focused;
    this.repaint();
    this.props.onFocus?.(focused);
  }

  get interactive(): boolean {
    return !this.props.disabled && (this.props.onPress !== undefined || this.props.onLongPress !== undefined);
  }

  get takesFocus(): boolean {
    if (this.props.disabled || this.hidden) return false;
    return this.props.focusable ?? this.props.onPress !== undefined;
  }

  setDisposer(dispose: () => void): void {
    this.disposer = dispose;
  }

  dispose(): void {
    this.root.forget(this);
    this.disposer?.();
    if (this.node.parent) detachNode(this.node.parent, this.node);
  }
}

const NONE: readonly Instance[] = [];
const NO_PAINT: Paint = {};
const NO_LAYERS: readonly Layer[] = [];
const CLEAR = "#00000000";
/** PROP.gradDir (contracts/spec/spec.ts ENUMS.GradDir); any other value draws the flat fill */
const GRAD_DIR = { up: 0, down: 1, left: 2, right: 3 } as const;
const NO_GRADIENT = -1;
/** A colour that hides what is under it: "#rrggbb", or "#rrggbbaa" with aa at its most. */
const opaque = (color: string): boolean => color.length <= 7 || color.slice(7).toLowerCase() === "ff";

/** A layer that is a filled rounded box with an edge, pinned on all four sides: the kind drawn as two boxes. */
function rimmed(layer: Layer): boolean {
  if (!layer.radius || layer.border === undefined || layer.l === undefined || layer.t === undefined || layer.r === undefined || layer.b === undefined) return false;
  return layer.gradient ? layer.gradient.every(opaque) : layer.fill !== undefined && opaque(layer.fill);
}

function sameEdges(a: Paint["pad"], b: Paint["pad"]): boolean {
  if (a === b) return true;
  if (typeof a !== "object" || typeof b !== "object" || a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}
const ORIGIN: readonly [number, number] = [0, 0];

/** Make `element` live under `parent`, in a reactive scope of its own. */
export function instantiate(el: UIElement, parent: Instance | null, root: UIRoot, owner: Owner | null): Instance {
  return runWithOwner(el.owner ?? owner, () =>
    createRoot((dispose) => {
      const instance = el.kind(el.props, parent, root);
      instance.setDisposer(dispose);
      instance.mounted();
      return instance;
    }),
  )!;
}

/** An instance with child elements: it keeps one instance per child element,
 *  in the order the child list resolves to. */
export abstract class Container extends Instance {
  protected list: Instance[] = [];
  private live = new Map<UIElement, Instance>();
  /** the native node children go under (a scroll view's moving content) */
  protected host: NodeMirror;

  constructor(props: BoxProps & { children?: UINode }, parent: Instance | null, root: UIRoot) {
    super(props, parent, root);
    this.host = this.createHost();
  }

  override mounted(): void {
    super.mounted();
    const props = this.props as BoxProps & { children?: UINode };
    const owner = getOwner();
    const resolved = resolveChildren(() => props.children as never);
    createRenderEffect(() => {
      const elements = elementsOf(resolved());
      untrack(() => this.reconcile(this.adopt(elements), owner));
    });
    onCleanup(() => {
      for (const child of this.list) child.dispose();
      this.list = [];
      this.live.clear();
    });
  }

  /** The elements that become this container's children: a subclass may wrap each. */
  protected adopt(elements: UIElement[]): UIElement[] {
    return elements;
  }

  /** The node children are inserted under. Called from the constructor,
   *  before a subclass's own fields exist: it may use `this.node` only. */
  protected createHost(): NodeMirror {
    return this.node;
  }

  private reconcile(elements: UIElement[], owner: Owner | null): void {
    const next = new Map<UIElement, Instance>();
    const list: Instance[] = [];
    for (const el of elements) {
      if (next.has(el)) continue; // the same element twice: one instance
      const instance = this.live.get(el) ?? instantiate(el, this, this.root, owner);
      next.set(el, instance);
      list.push(instance);
    }
    for (const [el, instance] of this.live) if (!next.has(el)) instance.dispose();
    this.live = next;
    this.list = list;
    // native order follows the list: later children paint over earlier ones
    let anchor: NodeMirror | undefined;
    for (let i = list.length - 1; i >= 0; i--) {
      const node = list[i]!.node;
      if (node.parent !== this.host || getNextSibling(node) !== anchor) insertNode(this.host, node, anchor ?? null);
      anchor = node;
    }
    this.invalidate();
  }

  override kids(): readonly Instance[] {
    return this.list;
  }
}

// ---------------------------------------------------------------------------
// Stacks
// ---------------------------------------------------------------------------

export interface StackProps extends BoxProps {
  /** room between children */
  spacing?: number;
  /** across the main axis: VStack defaults to "stretch", HStack to "center" */
  align?: Align;
  /** along the main axis when no child grows */
  justify?: "start" | "center" | "end" | "between";
  children?: UINode;
}

class StackInstance extends Container {
  private spacing = 0;
  private align: Align;
  private justify: NonNullable<StackProps["justify"]> = "start";
  private sizes: Size[] = [];

  constructor(props: StackProps, parent: Instance | null, root: UIRoot, private readonly axis: "v" | "h") {
    super(props, parent, root);
    this.align = axis === "v" ? "stretch" : "center";
    createRenderEffect(() => {
      this.spacing = props.spacing ?? 0;
      this.align = props.align ?? (axis === "v" ? "stretch" : "center");
      this.justify = props.justify ?? "start";
      this.invalidate();
    });
  }

  /** Children's sizes for an inner box of main x cross; returns [main used, cross used]. */
  private solve(main: number, cross: number): [number, number] {
    const v = this.axis === "v";
    const list = this.list;
    const sizes = this.sizes;
    sizes.length = list.length;
    let used = 0;
    let shown = 0;
    let growing = 0;
    let across = 0;
    for (let i = 0; i < list.length; i++) {
      const child = list[i]!;
      if (child.hidden) {
        sizes[i] = { w: 0, h: 0 };
        continue;
      }
      shown++;
      if (child.grow > 0 && main !== Infinity) {
        growing += child.grow;
        continue;
      }
      const room = main === Infinity ? Infinity : Math.max(0, main - used);
      const size = v ? child.measure(cross, Infinity) : child.measure(room, cross);
      sizes[i] = size;
      used += v ? size.h : size.w;
      across = Math.max(across, v ? size.w : size.h);
    }
    const gaps = shown > 1 ? this.spacing * (shown - 1) : 0;
    if (growing > 0) {
      let left = Math.max(0, main - used - gaps);
      let weight = growing;
      for (let i = 0; i < list.length; i++) {
        const child = list[i]!;
        if (child.hidden || !(child.grow > 0)) continue;
        const share = weight > 0 ? Math.floor((left * child.grow) / weight) : 0;
        left -= share;
        weight -= child.grow;
        const size = v ? child.measure(cross, share) : child.measure(share, cross);
        sizes[i] = v ? { w: size.w, h: share } : { w: share, h: size.h };
        used += share;
        across = Math.max(across, v ? size.w : size.h);
      }
    }
    return [used + gaps, across];
  }

  protected measureContent(maxW: number, maxH: number): Size {
    const pad = this.pad;
    const innerW = maxW === Infinity ? Infinity : Math.max(0, maxW - pad.l - pad.r);
    const innerH = maxH === Infinity ? Infinity : Math.max(0, maxH - pad.t - pad.b);
    const v = this.axis === "v";
    const [main, across] = v ? this.solve(innerH, innerW) : this.solve(innerW, innerH);
    return v ? { w: across + pad.l + pad.r, h: main + pad.t + pad.b } : { w: main + pad.l + pad.r, h: across + pad.t + pad.b };
  }

  protected override arrange(w: number, h: number): void {
    const pad = this.pad;
    const innerW = Math.max(0, w - pad.l - pad.r);
    const innerH = Math.max(0, h - pad.t - pad.b);
    const v = this.axis === "v";
    const main = v ? innerH : innerW;
    const cross = v ? innerW : innerH;
    const [used] = this.solve(main, cross);
    const list = this.list;
    const sizes = this.sizes;
    let shown = 0;
    for (const child of list) if (!child.hidden) shown++;
    const free = Math.max(0, main - used);
    let at = this.justify === "center" ? free / 2 : this.justify === "end" ? free : 0;
    const between = this.justify === "between" && shown > 1 ? free / (shown - 1) : 0;
    for (let i = 0; i < list.length; i++) {
      const child = list[i]!;
      if (child.hidden) continue;
      const size = sizes[i]!;
      const align = child.alignSelf ?? this.align;
      const length = v ? size.h : size.w;
      const breadth = align === "stretch" ? cross : Math.min(v ? size.w : size.h, cross);
      const start = align === "center" ? (cross - breadth) / 2 : align === "end" ? cross - breadth : 0;
      if (v) child.place(Math.round(pad.l + start), Math.round(pad.t + at), Math.round(breadth), Math.round(length));
      else child.place(Math.round(pad.l + at), Math.round(pad.t + start), Math.round(length), Math.round(breadth));
      at += length + this.spacing + between;
    }
  }
}

class LayerInstance extends Container {
  protected measureContent(maxW: number, maxH: number): Size {
    const pad = this.pad;
    const innerW = maxW === Infinity ? Infinity : Math.max(0, maxW - pad.l - pad.r);
    const innerH = maxH === Infinity ? Infinity : Math.max(0, maxH - pad.t - pad.b);
    let w = 0;
    let h = 0;
    for (const child of this.list) {
      if (child.hidden) continue;
      const size = child.measure(innerW, innerH);
      w = Math.max(w, size.w);
      h = Math.max(h, size.h);
    }
    return { w: w + pad.l + pad.r, h: h + pad.t + pad.b };
  }

  protected override arrange(w: number, h: number): void {
    const pad = this.pad;
    const innerW = Math.max(0, w - pad.l - pad.r);
    const innerH = Math.max(0, h - pad.t - pad.b);
    for (const child of this.list) {
      if (child.hidden) continue;
      const anchor = child.anchor;
      if (!anchor) {
        child.place(pad.l, pad.t, innerW, innerH);
        continue;
      }
      const size = child.measure(innerW, innerH);
      const cw = Math.min(size.w, innerW);
      const ch = Math.min(size.h, innerH);
      const x = anchor.endsWith("Leading") || anchor === "leading" ? 0 : anchor.endsWith("Trailing") || anchor === "trailing" ? innerW - cw : (innerW - cw) / 2;
      const y = anchor.startsWith("top") ? 0 : anchor.startsWith("bottom") ? innerH - ch : (innerH - ch) / 2;
      child.place(Math.round(pad.l + x), Math.round(pad.t + y), Math.round(cw), Math.round(ch));
    }
  }
}

export const stackKind =
  (axis: "v" | "h"): Kind<StackProps> =>
  (props, parent, root) =>
    new StackInstance(props, parent, root, axis);
export const VSTACK = stackKind("v");
export const HSTACK = stackKind("h");
export const ZSTACK: Kind<StackProps> = (props, parent, root) => new LayerInstance(props, parent, root);

// ---------------------------------------------------------------------------
// The root
// ---------------------------------------------------------------------------

/** Owns a surface: the element tree's instances, the layout pass, and (in
 *  ui/input.ts) the pointer and the focus that read its rectangles. */
export class UIRoot {
  readonly host: NodeMirror;
  width: number;
  height: number;
  /** the layers, back to front: the app's content, then what is presented over it */
  readonly layers: Instance[] = [];
  readonly frameHooks = new Set<() => void>();
  /** runs after every layout pass that placed something */
  readonly afterLayout = new Set<() => void>();
  private scheduled = false;
  private flushing = false;
  /** called when an instance leaves the tree, so input drops what it held */
  onForget: ((instance: Instance) => void) | undefined;
  private readonly themeSignal: Accessor<Theme>;
  private readonly writeTheme: (theme: Theme) => void;
  passes = 0;

  constructor(host: NodeMirror, width: number, height: number, theme: Theme) {
    this.host = host;
    this.width = width;
    this.height = height;
    const [read, write] = createSignal(theme);
    this.themeSignal = read;
    this.writeTheme = write;
  }

  /** The active theme: a signal read, so what paints from it paints again when it changes. */
  get theme(): Theme {
    return this.themeSignal();
  }

  set theme(theme: Theme) {
    this.writeTheme(theme);
    this.schedule();
  }

  /** Add a layer over the ones there; returns what removes it. */
  addLayer(el: UIElement, owner: Owner | null): { instance: Instance; remove(): void } {
    const instance = instantiate(el, null, this, owner);
    insertNode(this.host, instance.node, null);
    this.layers.push(instance);
    this.schedule();
    return {
      instance,
      remove: () => {
        const at = this.layers.indexOf(instance);
        if (at >= 0) this.layers.splice(at, 1);
        instance.dispose();
        this.schedule();
      },
    };
  }

  resize(width: number, height: number): void {
    if (width === this.width && height === this.height) return;
    this.width = width;
    this.height = height;
    for (const layer of this.layers) layer.invalidate();
    this.schedule();
  }

  schedule(): void {
    if (this.scheduled) return;
    this.scheduled = true;
    queueMicrotask(() => this.flush());
  }

  /** One layout pass over what is dirty. */
  flush(): void {
    if (this.flushing) return;
    this.scheduled = false;
    this.flushing = true;
    try {
      let placed = false;
      // a pass may dirty the tree again (a list that mounts rows it now knows it needs)
      for (let round = 0; round < 4; round++) {
        let any = false;
        for (const layer of this.layers) {
          if (!layer.isDirty() && layer.placed && layer.w === this.width && layer.h === this.height) continue;
          layer.measure(this.width, this.height);
          layer.place(0, 0, this.width, this.height);
          any = true;
        }
        if (!any) break;
        placed = true;
        this.passes++;
      }
      if (placed) for (const hook of this.afterLayout) hook();
    } finally {
      this.flushing = false;
    }
  }

  forget(instance: Instance): void {
    this.onForget?.(instance);
  }

  /** The instances under a point of the surface, deepest first. */
  hit(x: number, y: number): Instance[] {
    const path: Instance[] = [];
    for (let i = this.layers.length - 1; i >= 0; i--) {
      if (hitInto(this.layers[i]!, x, y, path)) break;
    }
    return path;
  }
}

function hitInto(instance: Instance, x: number, y: number, path: Instance[]): boolean {
  if (instance.hidden || !instance.placed) return false;
  const lx = x - instance.x;
  const ly = y - instance.y;
  const inside = lx >= 0 && ly >= 0 && lx < instance.w && ly < instance.h;
  if (!inside && instance.clips()) return false;
  const [ox, oy] = instance.contentOffset();
  const kids = instance.kids();
  for (let i = kids.length - 1; i >= 0; i--) {
    if (hitInto(kids[i]!, lx - ox, ly - oy, path)) {
      path.push(instance);
      return true;
    }
  }
  if (!inside || !instance.blocksHit()) return false;
  path.push(instance);
  return true;
}
