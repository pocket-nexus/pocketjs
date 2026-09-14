import { createEffect, createMemo, createSignal, onCleanup, type Accessor, type JSX as SolidJSX } from "solid-js";
import { View, Text, type ViewProps } from "./primitives.ts";
import { insert, type NodeMirror } from "./renderer.ts";
import { createGesture, pushTouchBlock } from "./gesture.ts";
import { animate, cancelAnim, jump } from "./anim.ts";
import { after } from "./clock.ts";
import { onFrame } from "./frame.ts";
import { resolveTouchHit } from "./input.ts";
import type { SurfaceId } from "./display.ts";
import { VirtualList, type VirtualListHandle } from "./virtual-list.ts";

/** The classic surface colors app chrome, rows and the classic keyboard
 *  share: linen background, body ink, secondary ink, selection blue. */
export const CLASSIC = {
  background: "#d9dde3",
  ink: "#283444",
  dim: "#667485",
  blue: "#2676cb",
  rowLine: "#ccd0d6",
  selectedFrom: "#edf5ff",
  selectedTo: "#d4e6fd",
  selectedBar: "#397bd4",
} as const;

export type ClassicTone = "neutral" | "primary" | "danger" | "key";
const palettes = {
  neutral: ["#fafcfe", "#cbd6e4", "#8397b1", "#304f78"],
  primary: ["#69a5f2", "#2363c2", "#17478b", "#ffffff"],
  danger: ["#e7817b", "#b12c25", "#81261f", "#ffffff"],
  key: ["#ffffff", "#d1d8e2", "#8c99aa", "#263950"],
  pressed: ["#234c82", "#497aad", "#173654", "#ffffff"],
  dangerPressed: ["#7d201d", "#b4443d", "#661813", "#ffffff"],
} as const;

/** Shared colors for controls, selected rows and their labels. */
export function classicPalette(tone: ClassicTone = "neutral", pressed = false) {
  const [gradFrom, gradTo, borderColor, textColor] = palettes[pressed ? tone === "danger" ? "dangerPressed" : "pressed" : tone];
  return { gradFrom, gradTo, borderColor, textColor };
}

export interface ClassicSelectionProps {
  /** Renders nothing while false. */
  active: boolean;
  /** Row height the left bar spans (minus 8 px of inset). */
  height?: number;
  /** Draw the rounded rim as well as the tint and bar. */
  ring?: boolean;
}

/** The selected-row wash every classic list shares: a translucent blue tint
 *  over the row content, a blue bar at the left edge and, on request, a
 *  rounded rim. Three flat nodes on purpose — on the PSP GE a rounded,
 *  bordered node with a translucent fill paints its border colour as an
 *  opaque fill, so the tint and the rim never share a node. Render it as
 *  the LAST child of a `relative` row so it paints above the content. */
export function ClassicSelection(props: ClassicSelectionProps) {
  const tint = View({ get style() { return { posType: 1, insetL: 0, insetT: 0, insetR: 0, insetB: 0, bgColor: "#2676cb22",
    display: props.active ? 0 : 1 }; } });
  const bar = View({ get style() { return { posType: 1, insetL: 0, insetT: 4, width: 3, height: Math.max(8, (props.height ?? 64) - 8),
    bgColor: CLASSIC.selectedBar, display: props.active ? 0 : 1 }; } });
  const rim = View({ get style() { return { posType: 1, insetL: 0, insetT: 0, insetR: 0, insetB: 0, radius: 6, borderWidth: 1,
    borderColor: "#9cbce4", display: props.active && props.ring ? 0 : 1 }; } });
  return [tint, bar, rim] as unknown as ReturnType<typeof View>;
}

export interface ClassicFaceProps extends Omit<ViewProps, "onPress" | "focusable"> {
  tone?: ClassicTone;
  pressed?: boolean;
  selected?: boolean;
  disabled?: boolean;
  /** Square the joining edge of adjacent toolbar actions. */
  edge?: "left" | "right";
}

/** Bezel, vertical shading and a depressed state; input can be supplied separately. */
export function ClassicFace(props: ClassicFaceProps) {
  const palette = createMemo(() => classicPalette(props.selected ? "primary" : props.tone, props.pressed));
  const frame = View({
    get class() { return props.class; }, get debugName() { return props.debugName; }, ref: props.ref, nodeRef: props.nodeRef,
    get style() { return { radius: 4, borderWidth: 1, gradDir: 1, ...palette(), ...props.style, opacity: props.disabled ? 0.45 : 1 }; },
  });
  // Keep child construction outside the primitive's synchronous spread stack.
  if (props.edge) {
    const fill = View({ get style() { return { posType: 1, insetT: 1, insetB: 1, width: 5,
      ...(props.edge === "left" ? { insetR: 0 } : { insetL: 0 }), gradDir: 1, ...palette() }; } });
    const divider = View({ get style() { return { posType: 1, insetT: 0, insetB: 0, width: 1,
      ...(props.edge === "left" ? { insetR: 0 } : { insetL: 0 }), bgColor: palette().borderColor }; } });
    insert(frame as unknown as NodeMirror, [fill, divider]);
  }
  const lip = View({ get style() { return { posType: 1, insetL: 4, insetR: 4, insetT: 1, height: 1,
    bgColor: props.pressed ? "#132e5066" : "#ffffff88" }; } });
  insert(frame as unknown as NodeMirror, lip);
  insert(frame as unknown as NodeMirror, () => props.children);
  return frame;
}

export interface ClassicButtonProps extends Omit<ClassicFaceProps, "children" | "pressed" | "nodeRef"> {
  label: string;
  onPress?(): void;
  surface?: SurfaceId;
  allowWhenBlocked?: boolean;
}

/** Release-inside activation with press, slide-out, cancellation and disabled feedback. */
export function ClassicButton(props: ClassicButtonProps) {
  const [pressed, setPressed] = createSignal(false);
  let node: NodeMirror | undefined, contact: number | undefined;
  const clear = () => { contact = undefined; setPressed(false); };
  createEffect(() => { if (props.disabled) clear(); });
  createGesture({ surface: props.surface, allowWhenBlocked: props.allowWhenBlocked,
    region: { node: () => node },
    onDown(c) { if (!props.disabled && contact === undefined) { contact = c.id; setPressed(true); } },
    onMove(c) {
      if (c.id !== contact) return;
      let hit = resolveTouchHit(c.x, c.y, undefined, c.surface);
      while (hit && hit !== node) hit = hit.parent;
      setPressed(!props.disabled && !!hit);
    },
    onUp(c) { if (c.id !== contact) return; const fire = pressed() && !props.disabled; clear(); if (fire) props.onPress?.(); },
    onCancel: clear,
  });
  const label = Text({ class: "text-xs font-bold",
    get style() { return { posType: 1, insetL: 0, insetR: 0, insetT: Math.max(0, (Number(props.style?.height ?? 25) - 15) / 2),
      textAlign: 1, textColor: classicPalette(props.selected ? "primary" : props.tone, pressed()).textColor }; },
    get children() { return props.label; },
  });
  return ClassicFace({
    ref: props.ref, nodeRef: n => { node = n; }, get class() { return props.class; }, get debugName() { return props.debugName; },
    get style() { return props.style; }, get tone() { return props.tone; },
    get pressed() { return pressed(); }, get selected() { return props.selected; },
    get disabled() { return props.disabled; }, edge: props.edge, children: label,
  });
}

export interface ClassicPanelProps extends Omit<ViewProps, "onPress" | "focusable"> { active?: boolean; headerHeight?: number }

/** Inset paint layers preserve the rounded corners and the complete outer rim.
 * Rounded backgrounds do not imply rounded child clipping on small hosts. */
export function ClassicPanel(props: ClassicPanelProps) {
  const header = createMemo(() => classicPalette(props.active ? "primary" : "neutral"));
  const frame = View({ ref: props.ref, nodeRef: props.nodeRef, get debugName() { return props.debugName; },
    get class() { return props.class; },
    get style() { return { radius: 6, ...props.style, bgColor: header().borderColor }; } });
  const fill = View({ get style() { return { posType: 1, insetL: 1, insetT: 1, insetR: 1,
    height: (props.headerHeight ?? 27) + 4, radius: 5, gradDir: 1, ...header() }; } });
  const body = View({ get style() { return { posType: 1, insetL: 1, insetR: 1, insetT: props.headerHeight ?? 27,
    insetB: 1, radius: 5, gradDir: 1, gradFrom: "#f7f9fc", gradTo: "#e2e8f0" }; } });
  const squareTop = View({ get style() { return { posType: 1, insetL: 1, insetR: 1, insetT: props.headerHeight ?? 27,
    height: 5, bgColor: "#f7f9fc" }; } });
  insert(frame as unknown as NodeMirror, [fill, body, squareTop]);
  insert(frame as unknown as NodeMirror, () => props.children);
  return frame;
}

export interface ClassicSheetProps {
  open: boolean;
  title: string;
  message?: string;
  actions: readonly { label: string; tone?: ClassicTone; disabled?: boolean; onPress(): void }[];
  cancelLabel?: string;
  onCancel(): void;
  surface?: SurfaceId;
  /** Includes the closing transition, so callers can also gate hardware input. */
  onModalChange?(active: boolean): void;
  debugName?: string;
}

/** Native slide/fade transitions keep touch modal until the sheet leaves.
 * Fixed action children are retained through close/reopen; no frame JS writes. */
export function ClassicSheet(props: ClassicSheetProps) {
  if (props.actions.length > 4) throw new RangeError("ClassicSheet supports at most four actions");
  const height = 60 + (props.actions.length + 1) * 38;
  const [shown, setShown] = createSignal(false);
  const frame = View({ debugName: props.debugName ?? "ClassicSheet",
    get style() { return { posType: 1, insetL: 0, insetR: 0, insetT: 0, insetB: 0, display: shown() ? 0 : 1 }; } });
  const scrim = View({ style: { posType: 1, insetL: 0, insetR: 0, insetT: 0, insetB: 0, bgColor: "#10203866", opacity: 0 } });
  const body = View({ style: { posType: 1, insetL: 0, insetR: 0, insetB: 0, height, translateY: height,
    borderWidth: 1, borderColor: "#657489", gradDir: 1, gradFrom: "#b1bbc9", gradTo: "#657891" } });
  const title = Text({ class: "text-sm font-bold", get children() { return props.title; },
    style: { posType: 1, insetL: 8, insetR: 8, insetT: 11, textAlign: 1, textColor: "#243955" } });
  const message = Text({ class: "text-xs", get children() { return props.message ?? ""; },
    style: { posType: 1, insetL: 8, insetR: 8, insetT: 32, textAlign: 1, textColor: "#344d6c" } });
  const buttons = [...props.actions, { get label() { return props.cancelLabel ?? "Cancel"; }, onPress: props.onCancel }].map((action, index) =>
    ClassicButton({ get label() { return action.label; }, get tone() { return "tone" in action ? action.tone : "neutral"; },
      get disabled() { return !props.open || ("disabled" in action && action.disabled); },
      surface: props.surface, allowWhenBlocked: true, onPress: () => { if (props.open) action.onPress(); },
      style: { posType: 1, insetL: 16, insetR: 16, insetT: 60 + index * 38, height: 34 } }));
  insert(body as unknown as NodeMirror, [title, message, ...buttons]);
  insert(frame as unknown as NodeMirror, [scrim, body]);
  let unblock: (() => void) | undefined, deadline: (() => void) | undefined;
  let slide = 0, fade = 0;
  const release = () => { unblock?.(); unblock = undefined; props.onModalChange?.(false); };
  createEffect(() => {
    const open = props.open;
    deadline?.(); deadline = undefined;
    if (slide) cancelAnim(slide); if (fade) cancelAnim(fade);
    if (open) {
      if (!unblock) { unblock = pushTouchBlock(); props.onModalChange?.(true); }
      setShown(true);
      slide = animate(body as unknown as NodeMirror, "translateY", 0, { dur: 220, easing: "out" });
      fade = animate(scrim as unknown as NodeMirror, "opacity", 1, { dur: 220 });
    } else if (unblock) {
      slide = animate(body as unknown as NodeMirror, "translateY", height, { dur: 180, easing: "in" });
      fade = animate(scrim as unknown as NodeMirror, "opacity", 0, { dur: 180 });
      deadline = after(0.18, () => { setShown(false); release(); deadline = undefined; });
    } else { jump(body as unknown as NodeMirror, "translateY", height); }
  });
  onCleanup(() => { deadline?.(); if (slide) cancelAnim(slide); if (fade) cancelAnim(fade); release(); });
  return frame;
}

// ---------------------------------------------------------------------------
// Screen chrome (docs/HIG.md §2.4): one 36 px bar, one 24 px footer.
// ---------------------------------------------------------------------------

export interface ClassicBarProps {
  /** Logical width of the surface the bar spans. */
  width: number;
  /** Embossed title at the left with a 12 px margin. */
  title?: string;
  /** Small text at the right with a 12 px margin. */
  trailing?: string;
  /** Absolute children (a field, a button) placed inside the bar. */
  children?: SolidJSX.Element;
}

/** The glossy title bar: a three-stop gloss, a white top line, a dark bottom
 *  line, the title embossed in two passes. Height 36. */
export function ClassicBar(props: ClassicBarProps) {
  const frame = View({
    class: "relative h-[36] bg-gradient-to-b from-[#fafbfc] via-[#ccd1d9] to-[#b6beca]",
    get style() { return { width: props.width }; },
  });
  const lines = [
    View({ get style() { return { posType: 1, insetL: 0, insetT: 0, width: props.width, height: 1, bgColor: "#ffffff" }; } }),
    View({ get style() { return { posType: 1, insetL: 0, insetT: 35, width: props.width, height: 1, bgColor: "#7f8998" }; } }),
  ];
  const title = [
    View({ style: { posType: 1, insetL: 12, insetT: 11 }, get children() {
      return Text({ class: "text-sm font-bold", style: { textColor: "#ffffff" }, get children() { return props.title ?? ""; } });
    } }),
    View({ style: { posType: 1, insetL: 12, insetT: 10 }, get children() {
      return Text({ class: "text-sm font-bold", style: { textColor: "#46566c" }, get children() { return props.title ?? ""; } });
    } }),
  ];
  const trailing = View({ get style() { return { posType: 1, insetR: 12, insetT: 12, display: props.trailing ? 0 : 1 }; }, get children() {
    return Text({ class: "text-xs", style: { textColor: CLASSIC.dim }, get children() { return props.trailing ?? ""; } });
  } });
  insert(frame as unknown as NodeMirror, [...lines, ...title, trailing]);
  insert(frame as unknown as NodeMirror, () => props.children);
  return frame;
}

export interface ClassicFooterProps {
  width: number;
  /** The counter, status or legend (useActions().legend()). */
  text: string;
  /** Red text for an error. */
  alert?: boolean;
}

/** The 24 px footer strip: a gloss, a dark top line and one centred line of text. */
export function ClassicFooter(props: ClassicFooterProps) {
  const frame = View({
    class: "relative h-[24] items-center justify-center bg-gradient-to-b from-[#eef0f4] via-[#c6cdd6] to-[#bac2ce]",
    get style() { return { width: props.width }; },
  });
  insert(frame as unknown as NodeMirror, [
    View({ get style() { return { posType: 1, insetL: 0, insetT: 0, width: props.width, height: 1, bgColor: "#8b96a4" }; } }),
    View({ get style() { return { posType: 1, insetL: 0, insetT: 1, width: props.width, height: 1, bgColor: "#ffffff" }; } }),
    Text({ class: "text-xs", get style() { return { textColor: props.alert ? "#a63838" : CLASSIC.dim, lineHeight: 12 }; },
      get children() { return props.text; } }),
  ]);
  return frame;
}

// ---------------------------------------------------------------------------
// Activity: the eight-bar spinner, blue on every device.
// ---------------------------------------------------------------------------

export interface ClassicSpinnerProps {
  /** Diameter in logical px. Default 22. */
  size?: number;
  color?: string;
}

/** Eight bars on a circle; every four virtual frames the bright bar
 *  advances one step. One style write per bar per step, no textures. */
export function ClassicSpinner(props: ClassicSpinnerProps) {
  const size = props.size ?? 22;
  const barW = Math.max(2, Math.round(size * 0.12)), barH = Math.max(4, Math.round(size * 0.3));
  const radius = size / 2 - barH / 2;
  const [phase, setPhase] = createSignal(0);
  let frames = 0;
  onFrame(() => { if (++frames % 4 === 0) setPhase((p) => (p + 1) % 8); });
  const frame = View({ style: { width: size, height: size } });
  const bars = Array.from({ length: 8 }, (_, i) => {
    const angle = i * 45, rad = (angle * Math.PI) / 180;
    const x = size / 2 + radius * Math.sin(rad) - barW / 2, y = size / 2 - radius * Math.cos(rad) - barH / 2;
    return View({ get style() {
      const distance = (i - phase() + 8) % 8;
      return { posType: 1, insetL: x, insetT: y, width: barW, height: barH, radius: barW / 2, rotate: angle,
        bgColor: props.color ?? CLASSIC.blue, opacity: 1 - distance * 0.11 };
    } });
  });
  insert(frame as unknown as NodeMirror, bars);
  return frame;
}

/** Placeholder text lines for a row whose content is still loading. */
export function ClassicSkeleton(props: { widths: readonly number[]; gap?: number; height?: number }) {
  const frame = View({ class: "flex-col", get style() { return { gap: props.gap ?? 4 }; } });
  insert(frame as unknown as NodeMirror, props.widths.map((width) =>
    View({ style: { width, height: props.height ?? 6, radius: 3, bgColor: "#d0d7df" } })));
  return frame;
}

// ---------------------------------------------------------------------------
// ClassicList: the HIG list on top of VirtualList — flush rows, the
// selection wash on the focused row, a trailing loading row that requests
// the next page for the d-pad as well as for a scrolling finger, and a
// per-frame window report for demand-driven row resources.
// ---------------------------------------------------------------------------

export interface ClassicListProps {
  surface?: SurfaceId;
  count: number;
  rowHeight: number;
  height: number;
  /** Row content; `active` follows the focused index. */
  renderRow: (index: number, active: Accessor<boolean>) => SolidJSX.Element;
  onRowPress?: (index: number) => void;
  /** A stationary hold on a row (touch) — the HIG's `option` on that row. */
  onRowHold?: (index: number) => void;
  inputActive?: () => boolean;
  /** Paging: a trailing row appears while more rows exist; the list asks
   *  for them when the finger nears the end or the focus reaches the last
   *  two rows, and shows a spinner while `loadingMore` is true. */
  hasMore?: () => boolean;
  loadingMore?: () => boolean;
  onLoadMore?: () => void;
  /** Called once per frame with the first visible row, the visible row
   *  count and the scroll velocity — the hook for prefetching rows. */
  onWindow?: (first: number, visible: number, velocity: number) => void;
  /** Rows of the trailing loading row read this label; default "Loading…". */
  loadingLabel?: string;
  ref?: (handle: VirtualListHandle) => void;
}

export function ClassicList(props: ClassicListProps) {
  let handle: VirtualListHandle | undefined;
  const [focused, setFocused] = createSignal<number | null>(null);
  const hasMore = () => props.hasMore?.() ?? false;
  const loading = () => props.loadingMore?.() ?? false;
  const total = () => props.count + (hasMore() ? 1 : 0);
  const requestMore = () => { if (hasMore() && !loading()) props.onLoadMore?.(); };
  const visibleRows = () => Math.ceil(props.height / props.rowHeight);

  onFrame(() => {
    if (!handle) return;
    const index = handle.focusedIndex();
    if (index !== focused()) setFocused(index);
    const offset = handle.scroller.offset(), velocity = handle.scroller.velocity();
    const first = Math.max(0, Math.floor(offset / props.rowHeight));
    props.onWindow?.(first, visibleRows(), velocity);
    // The d-pad's way to the next page: focus within two rows of the end.
    if (index !== null && index >= props.count - 2) requestMore();
  });

  const loadingRow = () => View({ class: "relative items-center justify-center flex-row gap-2 bg-white",
    style: { width: -1, height: props.rowHeight },
    get children() {
      return [
        View({ get style() { return { display: loading() ? 0 : 1 }; }, get children() { return ClassicSpinner({ size: 18 }); } }),
        Text({ class: "text-sm font-bold", style: { textColor: CLASSIC.dim }, get children() { return loading() ? props.loadingLabel ?? "Loading…" : ""; } }),
        View({ style: { posType: 1, insetL: 0, insetB: 0, insetR: 0, height: 1, bgColor: CLASSIC.rowLine } }),
      ];
    } });

  return VirtualList({
    surface: props.surface,
    get count() { return total(); },
    rowHeight: props.rowHeight,
    get height() { return props.height; },
    overscan: props.rowHeight,
    inputActive: props.inputActive,
    onRowPress: (index) => { if (index < props.count) props.onRowPress?.(index); else requestMore(); },
    onRowLongPress: props.onRowHold ? (index) => { if (index < props.count) props.onRowHold!(index); } : undefined,
    onNearEnd: requestMore,
    ref: (h) => { handle = h; props.ref?.(h); },
    renderRow: (index) => {
      if (index >= props.count) return loadingRow();
      const active = () => focused() === index;
      const row = View({ class: "relative", style: { width: -1, height: props.rowHeight } });
      insert(row as unknown as NodeMirror, () => props.renderRow(index, active));
      insert(row as unknown as NodeMirror, ClassicSelection({ get active() { return active(); }, height: props.rowHeight }));
      return row;
    },
  });
}
