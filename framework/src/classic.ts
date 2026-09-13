import { createEffect, createMemo, createSignal, onCleanup } from "solid-js";
import { View, Text, type ViewProps } from "./primitives.ts";
import { insert, type NodeMirror } from "./renderer.ts";
import { createGesture, pushTouchBlock } from "./gesture.ts";
import { animate, cancelAnim, jump } from "./anim.ts";
import { after } from "./clock.ts";
import { resolveTouchHit } from "./input.ts";
import type { SurfaceId } from "./display.ts";

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
