// Component-facing public API.

import type { Accessor, JSX as SolidJSX } from "solid-js";
import { Key } from "@solid-primitives/keyed";
import {
  children as resolveChildren,
  createEffect,
  createRenderEffect,
  createSignal,
  mergeProps,
  onCleanup,
  onMount,
  Show as SolidShow,
  splitProps,
  untrack,
  useContext,
} from "solid-js";
import { BTN, ENUMS, SCREEN_H, SCREEN_W } from "../../contracts/spec/spec.ts";
import { animate, type EasingName } from "./anim.ts";
import { pushButtonHandlerBlock, onButtonPress, onAxisDelta, onFrame, type ButtonPressOptions } from "./frame.ts";
import { RelativeAxis } from "./relative-axis.ts";
import type { i32 } from "./numeric-microts.ts";
import { RowContext, captureNodeRow, type RowContextValue } from "./solid-row.ts";
import { getOps, hostViewport } from "./host.ts";
import { pushFocusGrid, pushFocusScope, type FocusGridOptions, type FocusScopeOptions } from "./input.ts";
import { getOverlayRoot } from "./overlay.ts";
import { getAuxiliarySurfaceRoots } from "./display.ts";
import { View, type ViewProps } from "./primitives.ts";
import {
  createElement,
  detachNode,
  insertNode,
  render as rendererRender,
  setProp,
  type NodeMirror,
} from "./renderer.ts";
import { createCommentNode, setDebugName } from "./native-tree.ts";

export {
  View,
  Text,
  Image,
  Sprite,
  CompositorSurface,
  type ViewProps,
  type TextProps,
  type ImageProps,
  type SpriteProps,
  type CompositorSurfaceProps,
} from "./primitives.ts";
export {
  DeepZoom,
  type DeepZoomGesture,
  type DeepZoomProps,
  type DeepZoomView,
  type TileDoc,
  type TileLevel,
} from "./deepzoom.ts";
export type { NodeMirror } from "./renderer.ts";

type RefProp = ViewProps["ref"];

function callRef(ref: RefProp | undefined, node: NodeMirror): void {
  if (typeof ref === "function") ref(node);
}

function resolveActive(active: boolean | (() => boolean) | undefined): boolean {
  if (typeof active === "function") return active();
  return active ?? true;
}

export interface ScreenProps extends ViewProps {}

export function Screen(props: ScreenProps): SolidJSX.Element {
  // mergeProps keeps caller prop GETTERS live — an object spread would
  // read them once and freeze every dynamic class/style at mount.
  return View(
    mergeProps({ class: "relative flex-col w-full h-full bg-slate-50 overflow-hidden" }, props),
  );
}

export interface FocusableProps extends ViewProps {
  onPress?: () => void;
}

export function Focusable(props: FocusableProps): SolidJSX.Element {
  // mergeProps, not object spread: spreading reads the compiled prop
  // getters once and freezes dynamic class/style (the reactive-leak class
  // of bug this file must never reintroduce).
  return View(mergeProps(props, { focusable: true }) as ViewProps);
}

export interface NamedProps {
  /** Semantic name shown in the DevTools component tree (docs/DEVTOOLS.md). */
  name: string;
  children?: SolidJSX.Element;
}

/**
 * DevTools semantic scope: tags the host nodes it renders with `name`, so a
 * wrapped component subtree reads as one thing in the component tree
 * (`<Named name="MessageCard"><Card …/></Named>`). A node's own `debugName`
 * prop wins over the wrapper. Renders nothing itself — zero native nodes.
 */
export function Named(props: NamedProps): SolidJSX.Element {
  const resolved = resolveChildren(() => props.children);
  createRenderEffect(() => {
    const items = resolved.toArray();
    for (const item of items) {
      if (item && typeof item === "object" && "id" in item && "children" in item) {
        const node = item as unknown as NodeMirror;
        if (!node.debugName) setDebugName(node, props.name);
      }
    }
  });
  return resolved as unknown as SolidJSX.Element;
}

export interface FocusScopeProps extends ViewProps, FocusScopeOptions {
  active?: boolean | (() => boolean);
}

export function FocusScope(props: FocusScopeProps): SolidJSX.Element {
  let root: NodeMirror | undefined;
  const [scopeProps, viewProps] = splitProps(props, ["active", "autoFocus", "restoreFocus"]);
  createEffect(() => {
    if (!root || !resolveActive(scopeProps.active)) return;
    const dispose = pushFocusScope(root, {
      autoFocus: scopeProps.autoFocus,
      restoreFocus: scopeProps.restoreFocus,
    });
    onCleanup(dispose);
  });
  return View({
    ...viewProps,
    ref: (node) => {
      root = node;
      callRef(viewProps.ref, node);
    },
  });
}

export interface FocusGridProps extends ViewProps, FocusGridOptions {
  active?: boolean | (() => boolean);
}

export function FocusGrid(props: FocusGridProps): SolidJSX.Element {
  let root: NodeMirror | undefined;
  const [gridProps, viewProps] = splitProps(props, ["active", "columns", "wrap"]);
  createEffect(() => {
    if (!root || !resolveActive(gridProps.active)) return;
    const dispose = pushFocusGrid(root, {
      columns: gridProps.columns,
      wrap: gridProps.wrap,
    });
    onCleanup(dispose);
  });
  return View({
    ...viewProps,
    ref: (node) => {
      root = node;
      callRef(viewProps.ref, node);
    },
  });
}

export interface ActionHandlerProps extends ButtonPressOptions {
  button: number;
  onPress: (pressed: number, buttons: number) => void;
  children?: SolidJSX.Element;
}

export function ActionHandler(props: ActionHandlerProps): SolidJSX.Element {
  const marker = inputPlacement("action");
  onButtonPress(props.button, props.onPress, {
    allowWhenBlocked: props.allowWhenBlocked,
    active: () => resolveActive(props.active),
    latched: props.latched,
  }, marker);
  return inputBlock(marker, () => props.children);
}

function inputPlacement(name: string): NodeMirror {
  const marker = createCommentNode(name);
  setProp(marker, "style", { display: ENUMS.Display.None });
  captureNodeRow(marker);
  return marker;
}

function inputBlock(marker: NodeMirror, children: () => SolidJSX.Element): SolidJSX.Element {
  return [marker, children] as unknown as SolidJSX.Element;
}

export interface AxisHandlerProps {
  axis: "primary" | "secondary";
  active?: boolean;
  onDelta: (delta: i32) => void;
  children?: SolidJSX.Element;
}

export function AxisHandler(props: AxisHandlerProps): SolidJSX.Element {
  if (props.axis !== "primary" && props.axis !== "secondary") throw new Error(`Unknown relative axis ${props.axis}`);
  const marker = inputPlacement("axis");
  onAxisDelta(props.axis === "primary" ? RelativeAxis.Primary : RelativeAxis.Secondary,
    props.onDelta, { active: () => props.active ?? true }, marker);
  return inputBlock(marker, () => props.children);
}

export interface ForProps<T, K> {
  each: readonly T[] | undefined;
  by: (item: T) => K;
  fallback?: SolidJSX.Element;
  children: (item: Accessor<T>, index: Accessor<number>) => SolidJSX.Element;
}

/** Keep the row owner by key, and expose dispatch snapshots through accessors. */
export function For<T, K>(props: ForProps<T, K>): SolidJSX.Element {
  const parent = useContext(RowContext);
  return Key({
    get each() {
      const list = props.each;
      const seen = new Set<K>();
      for (const item of list ?? []) {
        const key = props.by(item);
        if (seen.has(key)) throw new Error(`PocketJS: duplicate For key ${String(key)}`);
        seen.add(key);
      }
      return list;
    },
    by: props.by,
    get fallback() { return props.fallback; },
    children: (row: Accessor<T>, rowIndex: Accessor<number>) => {
      const key = props.by(untrack(row));
      const context: RowContextValue<T> = {
        parent,
        resolve() {
          const list = props.each ?? [];
          const index = list.findIndex(item => props.by(item) === key);
          return index < 0 ? undefined : { item: list[index]!, index };
        },
      };
      const item = () => {
        if (context.snapshot) return context.snapshot.item;
        // A model may mutate a plain record and publish a new source array.
        // Key's own row signal compares object identity, so subscribe to the
        // source too to make that published write visible to row bindings.
        void props.each;
        return row();
      };
      const index = () => context.snapshot ? context.snapshot.index : rowIndex();
      return RowContext.Provider({ value: context, get children() { return props.children(item, index); } });
    },
  });
}

export interface PortalProps {
  children?: SolidJSX.Element | (() => SolidJSX.Element);
}

function renderPortalChild(child: PortalProps["children"]): unknown {
  if (typeof child === "function") return child();
  return child;
}

export function Portal(props: PortalProps): SolidJSX.Element {
  let host: NodeMirror | undefined;
  let dispose: (() => void) | undefined;

  onMount(() => {
    host = createElement("view");
    // Size to the live logical viewport — desktop widget hosts resize it
    // (resizeViewport keeps ui.__viewport fresh); console hosts read the
    // spec screen. A portal opened after a resize lands full-window.
    const vp = hostViewport(getOps());
    setProp(
      host,
      "style",
      {
        width: vp?.w ?? SCREEN_W,
        height: vp?.h ?? SCREEN_H,
        posType: ENUMS.PosType.Absolute,
        insetT: 0,
        insetR: 0,
        insetB: 0,
        insetL: 0,
        zIndex: 1000,
        // Pure plumbing: a full-screen box that must NEVER claim a hit
        // itself (bounds facts would resolve every touch to it — the
        // overlay-root lesson of op 42, portal edition). Its CONTENT still
        // claims normally (a modal scrim keeps blocking touches behind it).
        hitPass: 1,
      },
      undefined,
    );
    insertNode(getOverlayRoot(), host);
    dispose = rendererRender(() => renderPortalChild(props.children) as NodeMirror, host);
  });

  onCleanup(() => {
    dispose?.();
    if (host?.parent) detachNode(host.parent, host);
  });

  return null;
}

export interface AuxiliarySurfaceProps {
  children?: SolidJSX.Element | (() => SolidJSX.Element);
}

/** Mount children into the current AppInstance's auxiliary output. */
export function AuxiliarySurface(props: AuxiliarySurfaceProps): SolidJSX.Element {
  let host: NodeMirror | undefined;
  let dispose: (() => void) | undefined;
  onMount(() => {
    const surface = getAuxiliarySurfaceRoots();
    host = createElement("view");
    setProp(
      host,
      "style",
      {
        width: surface.viewport.width,
        height: surface.viewport.height,
        overflow: ENUMS.Overflow.Hidden,
      },
      undefined,
    );
    insertNode(surface.app, host);
    dispose = rendererRender(() => renderPortalChild(props.children) as NodeMirror, host);
  });
  onCleanup(() => {
    dispose?.();
    if (host?.parent) detachNode(host.parent, host);
  });
  return null;
}

/** Render overlay content above the auxiliary application layer. */
export function AuxiliaryPortal(props: AuxiliarySurfaceProps): SolidJSX.Element {
  let host: NodeMirror | undefined;
  let dispose: (() => void) | undefined;
  onMount(() => {
    const surface = getAuxiliarySurfaceRoots();
    host = createElement("view");
    setProp(
      host,
      "style",
      {
        width: surface.viewport.width,
        height: surface.viewport.height,
        posType: ENUMS.PosType.Absolute,
        insetT: 0,
        insetR: 0,
        insetB: 0,
        insetL: 0,
        hitPass: 1,
      },
      undefined,
    );
    insertNode(surface.overlay, host);
    dispose = rendererRender(() => renderPortalChild(props.children) as NodeMirror, host);
  });
  onCleanup(() => {
    dispose?.();
    if (host?.parent) detachNode(host.parent, host);
  });
  return null;
}

export interface ModalProps {
  class?: string;
  panelClass?: string;
  open?: boolean | (() => boolean);
  children?: SolidJSX.Element;
}

function ModalFrame(props: ModalProps): SolidJSX.Element {
  let backdrop: NodeMirror | undefined;
  let panel: NodeMirror | undefined;
  let unblockButtons: (() => void) | undefined;

  const open = () => resolveActive(props.open);

  createEffect(() => {
    const visible = open();
    if (visible && !unblockButtons) {
      unblockButtons = pushButtonHandlerBlock();
    } else if (!visible && unblockButtons) {
      unblockButtons();
      unblockButtons = undefined;
    }

    if (backdrop) setProp(backdrop, "style", { opacity: visible ? 0.62 : 0 }, undefined);
    if (panel) {
      setProp(
        panel,
        "style",
        {
          opacity: visible ? 1 : 0,
          translateY: 0,
          scale: 1,
        },
        undefined,
      );
    }
  });
  onCleanup(() => unblockButtons?.());

  return View({
    class: props.class ?? "absolute inset-0 z-50 flex-col items-center justify-center",
    children: [
      View({
        ref: (node) => {
          backdrop = node;
        },
        class: "absolute inset-0 bg-slate-950",
        style: { opacity: 0 },
      }),
      FocusScope({
        active: open,
        ref: (node) => {
          panel = node;
        },
        class:
          props.panelClass ??
          "flex-col gap-2 w-[328] p-3 rounded-xl shadow-lg bg-white border-slate-200",
        style: { opacity: 0, translateY: 0, scale: 1 },
        children: props.children,
      }),
    ],
  });
}

export function Modal(props: ModalProps): SolidJSX.Element {
  return Portal({ children: () => ModalFrame(props) });
}

export interface ActionBarProps extends ViewProps {}

export function ActionBar(props: ActionBarProps): SolidJSX.Element {
  return Portal({
    children: () =>
      View(
        mergeProps(
          {
            class:
              "absolute left-3 right-3 bottom-3 flex-row items-center justify-between px-2 py-1 rounded-lg shadow-md bg-white border-slate-200",
          },
          props,
        ),
      ),
  });
}

// ---------------------------------------------------------------------------
// Grid — a wrapping tile layout with optional d-pad grid traversal
// ---------------------------------------------------------------------------

export interface GridProps extends ViewProps, Partial<FocusGridOptions> {
  /** Cross-axis gap in px, applied via the style object (stays a full literal). */
  gap?: number;
  /**
   * Enable FocusGrid d-pad traversal (needs `columns`). Accepts a signal —
   * same `active` convention as FocusScope / FocusGrid / ActionHandler.
   */
  active?: boolean | (() => boolean);
}

/**
 * Lay tiles out as a wrapping row (`flex-row flex-wrap`) and, when `columns`
 * is given, hand its focusables row/column d-pad traversal via [`FocusGrid`].
 * Layout stays pure flexbox — `columns` drives *traversal only* (the same
 * contract FocusGrid already documents); the visible column count emerges from
 * the fixed tile width vs. the container width. Pass `gap` as a number so the
 * caller's `class` can stay a single compiled literal.
 */
export function Grid(props: GridProps): SolidJSX.Element {
  const [g, rest] = splitProps(props, ["gap", "columns", "wrap", "active", "class", "style"]);
  const style = g.gap != null ? { ...(g.style ?? {}), gap: g.gap } : g.style;
  const cls = g.class ?? "flex-row flex-wrap";
  if (g.columns != null) {
    return FocusGrid({
      ...rest,
      class: cls,
      style,
      columns: g.columns,
      wrap: g.wrap,
      active: g.active,
    });
  }
  return View({ ...rest, class: cls, style });
}

// ---------------------------------------------------------------------------
// Lazy — on-demand mount with an optional reveal (loading) delay
// ---------------------------------------------------------------------------

export interface LazyProps {
  /** Mount the content while this is truthy; unmount (destroy) when false. */
  when: boolean | (() => boolean);
  /**
   * Host frames to show `fallback` before revealing `children` the first time
   * this becomes active (default 0 = reveal immediately). Simulates an
   * asset/decode load — note textures themselves are uploaded eagerly at pak
   * load, so this models on-demand *content build*, not texture residency.
   */
  reveal?: number;
  /** Shown during the reveal delay (a spinner/skeleton). */
  fallback?: SolidJSX.Element | (() => SolidJSX.Element);
  /** Deferred content — only built once `when` is truthy AND the reveal elapsed. */
  children: () => SolidJSX.Element;
}

/**
 * Gate a subtree on demand. While `when` is false nothing is built (the native
 * subtree is destroyed by the end-of-frame sweep — one recursive `destroyNode`
 * [R]); when it turns true the content is created, optionally after a short
 * `reveal` delay that shows `fallback`. The reveal is a ONE-SHOT latch: it runs
 * the first time the subtree activates and, once elapsed, the content stays
 * revealed for this component's lifetime — a later re-activation shows it
 * immediately (no replayed spinner). There is no per-frame work when `reveal`
 * is 0.
 */
export function Lazy(props: LazyProps): SolidJSX.Element {
  const active = () => resolveActive(props.when);
  const reveal = Math.max(0, Math.floor(props.reveal ?? 0));
  const [ready, setReady] = createSignal(reveal === 0);

  if (reveal > 0) {
    let elapsed = 0;
    onFrame(() => {
      if (ready() || !active()) return; // count only while active; latch once ready
      if (++elapsed >= reveal) setReady(true);
    });
  }

  const fallback = (): SolidJSX.Element =>
    typeof props.fallback === "function"
      ? (props.fallback as () => SolidJSX.Element)()
      : (props.fallback ?? null);

  // Two nested <Show>s, with reactive getters for when/fallback and a lazy
  // `get children()` (deferred exactly like the Solid JSX compiler's output),
  // invoked directly as Modal calls FocusScope here. Owner = the demo's <Lazy>.
  const content = (): SolidJSX.Element =>
    SolidShow({
      get when() {
        return ready();
      },
      get fallback() {
        return fallback();
      },
      get children() {
        return props.children();
      },
    });

  return SolidShow({
    get when() {
      return active();
    },
    get children() {
      return content();
    },
  });
}

// ---------------------------------------------------------------------------
// Gallery — full-screen L/R paged strip (the "screen-by-screen" pager)
// ---------------------------------------------------------------------------

export interface GalleryProps {
  /** Total number of pages. */
  count: number;
  /** Controlled current page accessor (0-based). */
  page: () => number;
  /** Called with the next page when L/R paging is requested. */
  onPageChange?: (next: number) => void;
  /** Page factory — only invoked for pages inside the mount window (lazy). */
  renderPage: (index: number) => SolidJSX.Element;
  /** Pages kept mounted on each side of the current one (default 1). */
  window?: number;
  /** Slide duration in ms (default 300). */
  duration?: number;
  /** Slide easing (default "out"). */
  easing?: EasingName;
  /** Bind LTRIGGER/RTRIGGER to page(-/+1) internally (default true). */
  bindTriggers?: boolean;
  /** Wrap past the ends instead of clamping (default false). */
  wrap?: boolean;
  /** Override the outer viewport class (must keep it untransformed — see below). */
  class?: string;
}

/**
 * A horizontally paged, full-screen strip: pressing LTRIGGER/RTRIGGER slides a
 * whole screen at a time.
 *
 * Structure (two nodes for a reason):
 *   - an **untransformed** `overflow-hidden` viewport — the scissor is taken
 *     from the node's OWN world box (draw.rs), so the clipping node must not
 *     move, or it would clip the wrong region;
 *   - an inner **strip** whose `translateX` is animated to `-page*SCREEN_W`.
 *     Each page cell is `absolute inset-0` with a static `translateX = i*SCREEN_W`;
 *     a parent's animated transform composes with each child's static one
 *     (world = parent ∘ local), so page `i` lands on screen exactly when the
 *     strip reaches `-i*SCREEN_W`. translateX is paint-only + native-ticked, so
 *     the slide costs no relayout and one FFI crossing per press.
 *
 * Off-window pages are not built (see [`Lazy`]/`<Show>`), so a many-page gallery
 * stays within the PSP draw budget.
 */
export function Gallery(props: GalleryProps): SolidJSX.Element {
  let strip: NodeMirror | undefined;
  const win = Math.max(0, Math.floor(props.window ?? 1));
  const dur = props.duration ?? 300;
  const easing = props.easing ?? "out";
  const bind = props.bindTriggers ?? true;
  const initialPage = props.page();

  const clampPage = (n: number): number =>
    props.wrap
      ? ((n % props.count) + props.count) % props.count
      : Math.max(0, Math.min(props.count - 1, n));

  const go = (delta: number): void => {
    const next = clampPage(props.page() + delta);
    if (next !== props.page()) props.onPageChange?.(next);
  };

  if (bind) {
    onButtonPress(BTN.LTRIGGER, () => go(-1));
    onButtonPress(BTN.RTRIGGER, () => go(1));
  }

  // Slide on every page change; skip the mount run so the strip starts in place.
  let prevPage = initialPage;
  createEffect(() => {
    const p = props.page();
    if (!strip || p === prevPage) return;
    prevPage = p;
    animate(strip, "translateX", -p * SCREEN_W, { dur, easing });
  });

  const cells: SolidJSX.Element[] = [];
  for (let i = 0; i < props.count; i++) {
    const index = i;
    cells.push(
      View({
        style: {
          posType: ENUMS.PosType.Absolute,
          insetT: 0,
          insetR: 0,
          insetB: 0,
          insetL: 0,
          translateX: index * SCREEN_W,
        },
        children: SolidShow({
          get when() {
            return Math.abs(index - props.page()) <= win;
          },
          get children() {
            return props.renderPage(index);
          },
        }),
      }),
    );
  }

  return View({
    class: props.class,
    style: props.class
      ? undefined
      : {
          width: SCREEN_W,
          height: SCREEN_H,
          overflow: ENUMS.Overflow.Hidden,
        },
    children: View({
      ref: (node) => {
        strip = node;
      },
      style: { width: SCREEN_W, height: SCREEN_H, translateX: -initialPage * SCREEN_W },
      children: cells,
    }),
  });
}
