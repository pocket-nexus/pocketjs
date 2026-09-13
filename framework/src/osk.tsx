// System on-screen keyboard (@pocketjs/framework/osk).
//
// Text entry is a SYSTEM capability, not per-app furniture: every handheld
// PocketJS target needs one keyboard, driven by whatever the platform has —
// d-pad spatial navigation on a PSP, front-panel touch on a Vita, the
// virtual cursor wherever it's enabled. Apps get one seam:
//
//   const osk = createOsk({ value: query, setValue: setQuery,
//                           onCommit: () => search() });
//   onButtonPress(BTN.TRIANGLE, () => osk.open());
//   ... <Osk osk={osk} /> docked at the bottom of the screen column.
//
// While open the OSK is MODAL: it pushes a FocusScope (d-pad + press stay
// inside) AND a button-handler block (every app onButtonPress is muted, no
// per-handler `active:` gating — the exact bug class where an app freezes
// because its handlers were gated on a keyboard nobody could see). Raw
// button reads inside onFrame are NOT blocked; gate those on osk.isOpen().
//
// The layout is the LVGL-style variable-width grid in osk-layout.ts, the
// caret lives in the controller (‹ › move it), and the panel ships two
// themes — "dark" (default) and "light". Input adapters:
//   - d-pad: a focus controller (input.ts) doing spatial navigation with
//     the SAME pixel math that rendered the keys; CIRCLE presses via the
//     focus system, so `focus:`/`active:` styling is native and zero-JS.
//   - chords (PSP tradition): □ backspace · △ space · × close · R shift ·
//     L symbols · START commit. Holding □ auto-repeats backspace.
//   - touch: the modern press model through the gesture layer — a down
//     press-highlights the key (native focus:/active: variants), dragging
//     retargets across keys, sliding off the panel cancels, and the key
//     commits on release-inside. Backspace fires on the down and repeats
//     while held. Contacts resolve through input.hitFocusable (exact, any
//     placement); hosts without hitTest fall back to dock-at-the-bottom
//     geometry. While the panel is up a touch block mutes app gestures
//     underneath (the OSK's own recognizer is exempt).
//   - cursor: keys are plain Focusables in a scope — hover-focus and click
//     already work, nothing to adapt.

import { createEffect, createMemo, createSignal, For, onCleanup, Show, type Accessor, type JSX as SolidJSX } from "solid-js";
import { BTN, ENUMS, SCREEN_H, SCREEN_W } from "../../contracts/spec/spec.ts";
import { animate } from "./anim.ts";
import { simulationHz, virtualFrame } from "./clock.ts";
import { AuxiliaryPortal, Focusable, FocusScope, Portal, Text, View } from "./components.ts";
import { auxiliaryViewport, type SurfaceId } from "./display.ts";
import { pushButtonHandlerBlock } from "./frame.ts";
import { createGesture, pushTouchBlock } from "./gesture.ts";
import { getOps, hostViewport } from "./host.ts";
import {
  focusNode,
  getFocused,
  hitFocusable,
  pushFocusController,
  setActiveNode,
  type FocusDirection,
} from "./input.ts";
import { onButtonPress, onFrame } from "./lifecycle.ts";
import {
  clampPos,
  keyAtPoint,
  layoutRows,
  navigate,
  OSK_GAP,
  OSK_H,
  OSK_LAYERS,
  OSK_PAD,
  OSK_ROW_H,
  type OskKeyDef,
  type OskKeyRect,
  type OskLayerName,
  type OskPos,
} from "./osk-layout.ts";
import type { NodeMirror } from "./renderer.ts";

export { createKeyboardTouch, KEY_HOLD } from "./keyboard-touch.ts";
export { OSK_H, OSK_LAYERS, type OskKeyDef, type OskLayerName } from "./osk-layout.ts";

// ---------------------------------------------------------------------------
// Controller — the text-editing session (buffer via the app's signal, caret
// and open-state here). The keyboard VIEW is just one input method driving
// it; a host with a real keyboard could call insert()/backspace() directly.
// ---------------------------------------------------------------------------

export {
  createOsk,
  type CreateOskOptions,
  type OskController,
} from "./osk-controller.ts";
import { createOsk, type OskController } from "./osk-controller.ts";

// ---------------------------------------------------------------------------
// Themes — whole class literals (the build harvests classes and codepoints
// from source literals; composed strings would not compile).
// ---------------------------------------------------------------------------

export type OskThemeName = "dark" | "light";

const PANEL_DARK = "relative bg-[#10151c] border-[#1d2634]";
const PANEL_LIGHT = "relative bg-[#e7ebf0] border-[#d3d9e0]";

const KEY_DARK =
  "absolute rounded-sm items-center justify-center transition-colors duration-100 bg-[#1c232e] border-[#252e3a] focus:bg-[#28425e] focus:border-[#7ab8ff] active:bg-[#345779]";
const KEY_DARK_SPECIAL =
  "absolute rounded-sm items-center justify-center transition-colors duration-100 bg-[#151b24] border-[#202935] focus:bg-[#28425e] focus:border-[#7ab8ff] active:bg-[#345779]";
const KEY_LIGHT =
  "absolute rounded-sm items-center justify-center transition-colors duration-100 bg-[#ffffff] border-[#d8dde4] focus:bg-[#dceafe] focus:border-[#3d8bff] active:bg-[#c8dffc]";
const KEY_LIGHT_SPECIAL =
  "absolute rounded-sm items-center justify-center transition-colors duration-100 bg-[#eef1f5] border-[#d8dde4] focus:bg-[#dceafe] focus:border-[#3d8bff] active:bg-[#c8dffc]";

const INK = { dark: "#dbe7ee", light: "#1c2430" } as const;
const INK_DIM = { dark: "#8fa3ad", light: "#5f6b78" } as const;

// ---------------------------------------------------------------------------
// View
// ---------------------------------------------------------------------------

export interface OskProps {
  osk: OskController;
  surface?: SurfaceId;
  /** Key height in logical pixels; width follows the chosen surface. */
  keyHeight?: number;
  /** Default "dark". */
  theme?: OskThemeName;
}

/** The docked keyboard panel. Render it at the bottom of the screen column;
 *  it takes OSK_H of height while osk.isOpen() and nothing otherwise. */
export function Osk(props: OskProps): SolidJSX.Element {
  return (
    <Show when={props.osk.isOpen()}>
      <OskPanel osk={props.osk} theme={props.theme ?? "dark"} surface={props.surface ?? "primary"} keyHeight={props.keyHeight} />
    </Show>
  );
}

function keyboardViewport(surface: SurfaceId) {
  if(surface === "auxiliary") {
    const viewport = auxiliaryViewport();
    if(!viewport) throw new Error("Auxiliary keyboard requires display.auxiliary");
    return { w: viewport.width, h: viewport.height };
  }
  return hostViewport(getOps()) ?? { w: SCREEN_W, h: SCREEN_H };
}

function OskPanel(props: { osk: OskController; theme: OskThemeName; surface: SurfaceId; keyHeight?: number }): SolidJSX.Element {
  const viewport = keyboardViewport(props.surface), innerWidth = viewport.w - 2 * OSK_PAD;
  const rowHeight = props.keyHeight ?? OSK_ROW_H;
  const panelHeight = 4 * rowHeight + 3 * OSK_GAP + 2 * OSK_PAD;
  if (!Number.isFinite(rowHeight) || rowHeight < OSK_ROW_H || panelHeight > viewport.h)
    throw new Error("Keyboard key height does not fit its surface");
  const [layer, setLayer] = createSignal<OskLayerName>("lower");
  const rows = createMemo(() => layoutRows(OSK_LAYERS[layer()], innerWidth));

  // -- modality: mute app button handlers AND app gestures while the panel
  //    lives (the list under the keyboard sees onCancel the frame it opens).
  onCleanup(pushButtonHandlerBlock());
  onCleanup(pushTouchBlock());

  // -- key node bookkeeping (rebuilt whenever the layer re-renders) ---------
  let rootNode: NodeMirror | undefined;
  let nodesFor: OskKeyRect[][] | null = null;
  let keyNodes: (NodeMirror | undefined)[][] = [];
  const nodeInfo = new Map<NodeMirror, OskKeyRect>();
  let lastPos: OskPos = { row: 0, col: 1 }; // 'q' — friendlier than the corner

  const registerKey = (node: NodeMirror, rect: OskKeyRect): void => {
    if (nodesFor !== rows()) {
      nodesFor = rows();
      keyNodes = rows().map((r) => new Array(r.length));
      nodeInfo.clear();
    }
    keyNodes[rect.row][rect.col] = node;
    nodeInfo.set(node, rect);
  };

  const focusPos = (pos: OskPos): void => {
    lastPos = clampPos(rows(), pos);
    const node = keyNodes[lastPos.row]?.[lastPos.col];
    if (node) focusNode(node);
  };

  // Initial focus + refocus after every layer switch (the switch rebuilds
  // the key subtree, which would otherwise dump focus via removal repair).
  createEffect(() => {
    rows();
    focusPos(lastPos);
  });

  // -- activation -------------------------------------------------------------
  const activate = (key: OskKeyDef): void => {
    // The press that OPENED the keyboard must not also type on it.
    if (virtualFrame() === props.osk.openedFrame()) return;
    if (key.ch !== undefined) {
      props.osk.insert(key.ch);
      return;
    }
    switch (key.action) {
      case "shift":
        setLayer((l) => (l === "upper" ? "lower" : "upper"));
        break;
      case "layer":
        setLayer((l) => (l === "symbols" ? "lower" : "symbols"));
        break;
      case "backspace":
        props.osk.backspace();
        break;
      case "enter":
        props.osk.commit();
        break;
      case "left":
        props.osk.moveCaret(-1);
        break;
      case "right":
        props.osk.moveCaret(1);
        break;
      case "hide":
        props.osk.cancel();
        break;
    }
  };

  // -- d-pad: spatial navigation with the render-side pixel math ------------
  createEffect(() => {
    if (!rootNode) return;
    animate(rootNode, "translateY", 0, { dur: 150, easing: "out" }); // slide in
    const dispose = pushFocusController(rootNode, (direction: FocusDirection) => {
      const focused = getFocused();
      const from = focused ? nodeInfo.get(focused) ?? lastPos : lastPos;
      focusPos(navigate(rows(), { row: from.row, col: from.col }, direction));
      return true; // clamped edges are handled too — never fall through
    });
    onCleanup(dispose);
  });

  // -- chords (PSP tradition; latched — the panel mounts under a held key) --
  const chord = { latched: true, allowWhenBlocked: true };
  onButtonPress(BTN.SQUARE, () => props.osk.backspace(), chord);
  onButtonPress(BTN.TRIANGLE, () => props.osk.insert(" "), chord);
  onButtonPress(BTN.CROSS, () => props.osk.cancel(), chord);
  onButtonPress(BTN.START, () => props.osk.commit(), chord);
  onButtonPress(BTN.RTRIGGER, () => setLayer((l) => (l === "upper" ? "lower" : "upper")), chord);
  onButtonPress(BTN.LTRIGGER, () => setLayer((l) => (l === "symbols" ? "lower" : "symbols")), chord);

  // -- touch: the modern press model ----------------------------------------
  // Down press-highlights (focus + active:), dragging retargets across keys,
  // sliding off the panel cancels, release-inside commits. Backspace is the
  // exception: it fires on the DOWN and auto-repeats while held (below).
  // Multi-contact: each finger arms its own key (two-thumb typing); the
  // highlight follows the most recent contact event.
  const armed = new Map<number, OskKeyRect | null>();
  const highlight = (rect: OskKeyRect | null): void => {
    if (rect) {
      focusPos({ row: rect.row, col: rect.col });
      setActiveNode(keyNodes[rect.row]?.[rect.col] ?? null);
    } else {
      setActiveNode(null);
    }
  };
  createGesture({
    surface: props.surface,
    region: {
      node: () => rootNode,
      rect: () => {
        // Dock-at-the-bottom geometry for hosts without hitTest.
        return { x: 0, y: viewport.h - panelHeight, w: viewport.w, h: panelHeight };
      },
    },
    allowWhenBlocked: true, // exempt from the OSK's own touch block
    tapSlop: 9999, // the panel owns its press model — no tap/pan recognition
    onDown: (c) => {
      const rect = resolveTouch(c.x, c.y);
      armed.set(c.id, rect);
      highlight(rect);
      if (rect?.key.action === "backspace") activate(rect.key);
    },
    onMove: (c) => {
      const rect = resolveTouch(c.x, c.y);
      const prev = armed.get(c.id) ?? null;
      if (rect === prev) return;
      armed.set(c.id, rect);
      highlight(rect); // retarget — or cancel when the finger slid off
    },
    onUp: (c) => {
      const rect = armed.get(c.id) ?? null;
      armed.delete(c.id);
      setActiveNode(null);
      if (rect && rect.key.action !== "backspace") activate(rect.key);
    },
    onCancel: (c) => {
      armed.delete(c.id);
      setActiveNode(null);
    },
  });

  // -- backspace auto-repeat (touch hold + held □ chord), in virtual frames --
  let touchBsFrames = 0;
  let squareFrames = 0;
  onFrame((buttons) => {
    const delay = Math.max(1, Math.round(0.4 * simulationHz()));
    const every = Math.max(1, Math.round(0.1 * simulationHz()));
    let heldOnBackspace = false;
    for (const rect of armed.values()) {
      if (rect?.key.action === "backspace") {
        heldOnBackspace = true;
        break;
      }
    }
    if (heldOnBackspace) {
      touchBsFrames++;
      if (touchBsFrames >= delay && (touchBsFrames - delay) % every === 0) props.osk.backspace();
    } else {
      touchBsFrames = 0;
    }
    if (buttons & BTN.SQUARE) {
      squareFrames++;
      if (squareFrames >= delay && (squareFrames - delay) % every === 0) props.osk.backspace();
    } else {
      squareFrames = 0;
    }
  });

  const resolveTouch = (x: number, y: number): OskKeyRect | null => {
    const node = hitFocusable(x, y, props.surface);
    if (node) return nodeInfo.get(node) ?? null;
    if (props.surface === "auxiliary" ? getOps().hitTestAuxiliary : getOps().hitTest) return null;
    // No hitTest op: assume the panel is docked at the bottom of the screen.
    const pos = keyAtPoint(rows(), x - OSK_PAD, y - (viewport.h - panelHeight) - OSK_PAD, rowHeight);
    return pos ? rows()[pos.row][pos.col] : null;
  };

  // -- panel ------------------------------------------------------------------
  const keyCls = (key: OskKeyDef): string => {
    const special = key.ch === undefined;
    if (props.theme === "light") return special ? KEY_LIGHT_SPECIAL : KEY_LIGHT;
    return special ? KEY_DARK_SPECIAL : KEY_DARK;
  };

  return (
    <FocusScope
      restoreFocus={false}
      ref={(n: NodeMirror) => {
        rootNode = n;
      }}
      class={props.theme === "light" ? PANEL_LIGHT : PANEL_DARK}
      style={{ height: panelHeight, width: viewport.w, translateY: panelHeight }}
    >
      {/* Structural reactivity must ride <For> — a bare `{rows().map(…)}`
          child compiles to a static insert and never re-renders on a layer
          switch (each layer is a fresh array, so <For> swaps everything). */}
      <For each={rows()}>
        {(row, r) => (
          <View
            class="absolute"
            style={{ insetT: OSK_PAD + r() * (rowHeight + OSK_GAP), insetL: OSK_PAD, width: innerWidth, height: rowHeight }}
          >
            <For each={row}>
              {(rect) => (
                <Focusable
                  nodeRef={(n) => registerKey(n, rect)}
                  class={keyCls(rect.key)}
                  style={{ insetL: rect.x, insetT: 0, width: rect.w, height: rowHeight }}
                  onPress={() => activate(rect.key)}
                >
                  <Text
                    class="text-xs font-bold"
                    style={{
                      textColor: rect.key.ch !== undefined ? INK[props.theme] : INK_DIM[props.theme],
                      lineHeight: 12,
                    }}
                  >
                    {rect.key.label ?? rect.key.ch ?? ""}
                  </Text>
                </Focusable>
              )}
            </For>
          </View>
        )}
      </For>
    </FocusScope>
  );
}

// ---------------------------------------------------------------------------
// TextField — the editable field (docs/TOUCH.md §1). The field and its
// keyboard are one vertical: ACTIVATION of the field — touch tap, d-pad
// CIRCLE, cursor click, one pressNode pipeline — summons the system OSK
// bound to the field's signal. No app osk plumbing.
// ---------------------------------------------------------------------------

export interface TextFieldProps {
  surface?: SurfaceId;
  keyHeight?: number;
  /** The bound text (application state stays the only authority). */
  value: Accessor<string>;
  onInput: (next: string) => void;
  /** Commit (the OSK's START/✓): receives the final value; the panel closes. */
  onSubmit?: (value: string) => void;
  placeholder?: string;
  /** Replaces the default field box classes (whole literals only). */
  class?: string;
  theme?: OskThemeName;
  /** Controller escape hatch — shortcut buttons (△) call `ref.open()`. */
  ref?: (osk: OskController) => void;
}

export function TextField(props: TextFieldProps): SolidJSX.Element {
  const surface = props.surface ?? "primary", viewport = keyboardViewport(surface);
  const Overlay = surface === "auxiliary" ? AuxiliaryPortal : Portal;
  const osk = createOsk({
    value: props.value,
    setValue: (next) => props.onInput(next),
    onCommit: (text) => props.onSubmit?.(text),
    closeOnCommit: true,
  });
  props.ref?.(osk);
  return [
    Focusable({
      onPress: () => osk.open(),
      get class() {
        return (
          props.class ??
          "rounded-md bg-[#10161f] border-[#232e3c] px-2 py-1 focus:border-[#4a5a70] active:bg-[#1a2333]"
        );
      },
      get children() {
        return Text({
          get class() {
            return osk.isOpen() || props.value()
              ? props.theme === "light" ? "text-sm text-slate-800" : "text-sm text-slate-100"
              : "text-sm text-slate-500";
          },
          get children() {
            return osk.isOpen() ? osk.display() : props.value() || props.placeholder || " ";
          },
        });
      },
    }),
    // The keyboard docks over the overlay layer (hitPass keeps the empty
    // layer hit-transparent; the panel itself claims normally) and blocks
    // buttons + gestures beneath while it lives — the OSK's own modality.
    Overlay({
      children: () =>
        View({
          style: { posType: ENUMS.PosType.Absolute, insetB: 0, insetL: 0, width: viewport.w, hitPass: 1 },
          get children() {
            return Osk({ osk, surface, keyHeight: props.keyHeight, get theme() { return props.theme; } });
          },
        }),
    }),
  ] as unknown as SolidJSX.Element;
}
