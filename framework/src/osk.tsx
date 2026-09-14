// System on-screen keyboard (@pocketjs/framework/osk).
//
// Text entry is a SYSTEM capability, not per-app furniture: every handheld
// PocketJS target needs one keyboard, driven by whatever the platform has.
// Apps get one seam:
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
// The keyboard reads its MODALITY off the surface it renders on
// (osk-session.ts): whether contacts land there and whether the device has
// buttons. That choice fixes the layout and the input adapters; the skin is
// a separate `theme` prop so one look serves every modality.
//
//   - focus (buttons, no contacts on this surface — the PSP): the "grid"
//     layout, where caret, hide and commit are keys a d-pad can reach. A
//     focus controller does spatial navigation with the SAME pixel math
//     that rendered the keys; CIRCLE presses via the focus system, so
//     `focus:`/`active:` styling is native and zero-JS. The device-wide
//     memory in osk-session.ts reopens the keyboard on the layer and key the
//     user left.
//   - contact (contacts on this surface — the Vita panel, the 3DS bottom
//     screen): the "staggered" phone layout at 30 px rows. Character keys
//     type on the down edge and never take focus; backspace repeats while
//     held; holding space turns the panel into a caret trackpad; a second
//     shift press within 0.35 s locks caps (keyboard-touch.ts owns the hold
//     rules). On a device that also has buttons the d-pad focus ring stays
//     hidden until the first d-pad press and hides again on the next touch.
//   - chords (buttons): □ backspace · △ space · × close · R shift · L layer
//     · START commit, on either layout. Holding □ auto-repeats backspace.
//   - cursor: keys are plain Focusables in a scope — hover-focus and click
//     already work, nothing to adapt.

import { createEffect, createMemo, createSignal, Index, onCleanup, Show, untrack, type Accessor, type JSX as SolidJSX } from "solid-js";
import { BTN, ENUMS, SCREEN_H, SCREEN_W } from "../../contracts/spec/spec.ts";
import { animate } from "./anim.ts";
import { simulationHz, virtualFrame, virtualNow } from "./clock.ts";
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
import { createKeyboardTouch } from "./keyboard-touch.ts";
import { onButtonPress, onFrame } from "./lifecycle.ts";
import { glyph, modality } from "./modality.ts";
import {
  clampPos,
  keyAtPoint,
  layoutRows,
  navigate,
  oskLayer,
  oskLayerToggle,
  oskMetrics,
  oskPanelHeight,
  oskRowsTop,
  OSK_LAYOUT_ROW_H,
  OSK_ROW_H,
  type OskKeyDef,
  type OskKeyRect,
  type OskLayerName,
  type OskLayoutKind,
  type OskMetrics,
  type OskPos,
} from "./osk-layout.ts";
import { recallPanel, rememberPanel, resolveOskModality, type OskModality } from "./osk-session.ts";
import type { NodeMirror } from "./renderer.ts";

export { createKeyboardTouch, KEY_HOLD } from "./keyboard-touch.ts";
export {
  OSK_H,
  OSK_LAYERS,
  OSK_LAYOUTS,
  OSK_LAYOUT_ROW_H,
  oskMetrics,
  oskPanelHeight,
  type OskKeyDef,
  type OskLayerName,
  type OskLayoutKind,
  type OskMetrics,
} from "./osk-layout.ts";
export { recallPanel, resetPanelMemory, resolveOskModality, type OskModality, type OskPanelMemory } from "./osk-session.ts";

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
// from source literals; composed strings would not compile). "classic" is
// the bezelled light skin the classic module shares with app chrome.
// ---------------------------------------------------------------------------

export type OskThemeName = "dark" | "light" | "classic";

const PANEL: Readonly<Record<OskThemeName, string>> = {
  dark: "relative bg-[#10151c] border-[#1d2634]",
  light: "relative bg-[#e7ebf0] border-[#d3d9e0]",
  classic: "relative bg-gradient-to-b from-[#d3d9e1] via-[#b9c0ca] to-[#8f99a7]",
};

const KEY: Readonly<Record<OskThemeName, { readonly key: string; readonly special: string }>> = {
  dark: {
    key: "absolute rounded-sm items-center justify-center transition-colors duration-100 bg-[#1c232e] border-[#252e3a] focus:bg-[#28425e] focus:border-[#7ab8ff] active:bg-[#345779]",
    special: "absolute rounded-sm items-center justify-center transition-colors duration-100 bg-[#151b24] border-[#202935] focus:bg-[#28425e] focus:border-[#7ab8ff] active:bg-[#345779]",
  },
  light: {
    key: "absolute rounded-sm items-center justify-center transition-colors duration-100 bg-[#ffffff] border-[#d8dde4] focus:bg-[#dceafe] focus:border-[#3d8bff] active:bg-[#c8dffc]",
    special: "absolute rounded-sm items-center justify-center transition-colors duration-100 bg-[#eef1f5] border-[#d8dde4] focus:bg-[#dceafe] focus:border-[#3d8bff] active:bg-[#c8dffc]",
  },
  classic: {
    key: "absolute rounded-[4] items-center justify-center transition-colors duration-100 border border-[#8c99aa] bg-gradient-to-b from-[#ffffff] to-[#d1d8e2] focus:border-[#2363c2] focus:from-[#e3effe] focus:to-[#b7d3f6] active:border-[#17478b] active:from-[#69a5f2] active:to-[#2363c2]",
    special: "absolute rounded-[4] items-center justify-center transition-colors duration-100 border border-[#8c99aa] bg-gradient-to-b from-[#eef1f5] to-[#bfc8d3] focus:border-[#2363c2] focus:from-[#e3effe] focus:to-[#b7d3f6] active:border-[#17478b] active:from-[#69a5f2] active:to-[#2363c2]",
  },
};

const INK: Readonly<Record<OskThemeName, string>> = { dark: "#dbe7ee", light: "#1c2430", classic: "#263950" };
const INK_DIM: Readonly<Record<OskThemeName, string>> = { dark: "#8fa3ad", light: "#5f6b78", classic: "#4f5d70" };
const HINT_INK = "#4f5d70";
/** The legend strip the classic staggered panel carries above its rows. */
const CLASSIC_HINT_H = 14;
/** The classic grid draws a bezel, which needs two more pixels than the flat skins. */
const CLASSIC_GRID_ROW_H = 20;
/** A second shift press inside this window locks caps (virtual seconds). */
const CAPS_LOCK_WINDOW = 0.35;
const DPAD = BTN.UP | BTN.DOWN | BTN.LEFT | BTN.RIGHT;

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
  /** Fix the layout; default follows the surface's contacts (osk-session.ts). */
  layout?: OskLayoutKind;
  /** Legend for the classic staggered panel; default names the close and
   *  commit chords with the device's own button glyphs. */
  hint?: string;
}

/** The docked keyboard panel. Render it at the bottom of the screen column;
 *  it takes its panel height while osk.isOpen() and nothing otherwise. */
export function Osk(props: OskProps): SolidJSX.Element {
  return (
    <Show when={props.osk.isOpen()}>
      <OskPanel
        osk={props.osk}
        theme={props.theme ?? "dark"}
        surface={props.surface ?? "primary"}
        keyHeight={props.keyHeight}
        layout={props.layout}
        hint={props.hint}
      />
    </Show>
  );
}

function keyboardViewport(surface: SurfaceId) {
  if (surface === "auxiliary") {
    const viewport = auxiliaryViewport();
    if (!viewport) throw new Error("Auxiliary keyboard requires display.auxiliary");
    return { w: viewport.width, h: viewport.height };
  }
  return hostViewport(getOps()) ?? { w: SCREEN_W, h: SCREEN_H };
}

/** The metrics a panel uses: the caller's key height, else the layout's
 *  default (a bezelled classic grid row is 20 px), plus the classic
 *  staggered legend strip. */
export function oskPanelMetrics(mode: OskModality, theme: OskThemeName, keyHeight?: number): OskMetrics {
  const classic = theme === "classic";
  const rowH = keyHeight ?? (classic && mode.layout === "grid" ? CLASSIC_GRID_ROW_H : OSK_LAYOUT_ROW_H[mode.layout]);
  return oskMetrics(mode.layout, rowH, classic && mode.layout === "staggered" ? CLASSIC_HINT_H : 0);
}

/** The docked panel height a surface's keyboard takes while open, so a
 *  column can shrink by that amount without mounting the panel. */
export function oskHeight(surface: SurfaceId = "primary", theme: OskThemeName = "dark", layout?: OskLayoutKind, keyHeight?: number): number {
  return oskPanelHeight(oskPanelMetrics(resolveOskModality(surface, modality.buttons, layout), theme, keyHeight));
}

function OskPanel(props: {
  osk: OskController;
  theme: OskThemeName;
  surface: SurfaceId;
  keyHeight?: number;
  layout?: OskLayoutKind;
  hint?: string;
}): SolidJSX.Element {
  const viewport = keyboardViewport(props.surface);
  const mode = resolveOskModality(props.surface, modality.buttons, props.layout);
  const kind = mode.layout;
  const metrics = oskPanelMetrics(mode, props.theme, props.keyHeight);
  const rowHeight = metrics.rowH;
  const innerWidth = viewport.w - 2 * metrics.pad;
  const panelHeight = oskPanelHeight(metrics);
  const rowsTop = oskRowsTop(metrics);
  if (!Number.isFinite(rowHeight) || rowHeight < OSK_ROW_H || panelHeight > viewport.h) {
    throw new Error("Keyboard key height does not fit its surface");
  }

  // -- state: the device-wide memory decides the opening layer and key ------
  const memory = recallPanel(kind, innerWidth);
  const [layer, setLayerRaw] = createSignal<OskLayerName>(memory.layer);
  const [locked, setLocked] = createSignal(false);
  const [tracking, setTracking] = createSignal(false);
  const rows = createMemo(() => layoutRows(oskLayer(kind, layer()), innerWidth, metrics.gap));
  let lastPos: OskPos = memory.pos;
  // A contact surface opens without a visible focus ring; the first d-pad
  // press reveals it at the remembered key, the next touch hides it again.
  const [focusShown, setFocusShown] = createSignal(!mode.contact);
  // The key a press is holding down: the finger's key, or the focused key
  // while CIRCLE is held. Its cap reads white-on-blue on every modality.
  const [pressedPos, setPressedPos] = createSignal<OskPos | null>(null);
  const isPressed = (rect: OskKeyRect): boolean => {
    const pos = pressedPos();
    return pos !== null && pos.row === rect.row && pos.col === rect.col;
  };
  let shiftAt = -Infinity;
  const remember = (): void => rememberPanel(kind, { layer: layer(), pos: lastPos });
  onCleanup(remember);

  // -- modality: mute app button handlers AND app gestures while the panel
  //    lives (the list under the keyboard sees onCancel the frame it opens).
  onCleanup(pushButtonHandlerBlock());
  onCleanup(pushTouchBlock());

  // -- key node bookkeeping (rebuilt whenever the layer re-renders) ---------
  let rootNode: NodeMirror | undefined;
  let nodesFor: OskKeyRect[][] | null = null;
  let keyNodes: (NodeMirror | undefined)[][] = [];
  const nodeInfo = new Map<NodeMirror, OskKeyRect>();

  const registerKey = (node: NodeMirror, rect: OskKeyRect): void => {
    if (nodesFor !== rows()) {
      nodesFor = rows();
      keyNodes = rows().map((r) => new Array(r.length));
      nodeInfo.clear();
    }
    keyNodes[rect.row][rect.col] = node;
    nodeInfo.set(node, rect);
  };

  // Slide the panel in once its node exists (translateY starts at the height).
  createEffect(() => {
    if (rootNode) animate(rootNode, "translateY", 0, { dur: 150, easing: "out" });
  });

  const focusPos = (pos: OskPos): void => {
    lastPos = clampPos(rows(), pos);
    remember();
    if (!mode.focus) return;
    const node = keyNodes[lastPos.row]?.[lastPos.col];
    if (node) focusNode(node);
  };

  const switchLayer = (next: OskLayerName): void => {
    setLayerRaw(next);
    remember();
  };

  // -- activation -------------------------------------------------------------
  const shift = (): void => {
    const now = virtualNow();
    if (layer() === "upper") {
      if (kind === "staggered" && now - shiftAt < CAPS_LOCK_WINDOW) setLocked(true);
      else {
        setLocked(false);
        switchLayer("lower");
      }
    } else {
      setLocked(false);
      switchLayer("upper");
    }
    shiftAt = now;
  };

  const activate = (key: OskKeyDef): void => {
    // The press that OPENED the keyboard must not also type on it.
    if (virtualFrame() === props.osk.openedFrame()) return;
    if (key.ch !== undefined) {
      props.osk.insert(key.ch);
      // The phone layout's shift is one-shot unless caps is locked.
      if (kind === "staggered" && layer() === "upper" && !locked() && key.ch !== " ") switchLayer("lower");
      return;
    }
    switch (key.action) {
      case "shift":
        shift();
        break;
      case "layer":
        setLocked(false);
        switchLayer(key.to ?? oskLayerToggle(kind, layer()));
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

  // -- focus adapter: spatial d-pad navigation with the render-side math ----
  let reveal = false;
  if (mode.focus) {
    createEffect(() => {
      if (!rootNode) return;
      const dispose = pushFocusController(rootNode, (direction: FocusDirection) => {
        if (reveal) {
          // The press that revealed the ring lands on the remembered key.
          reveal = false;
          return true;
        }
        const focused = getFocused();
        const from = focused ? nodeInfo.get(focused) ?? lastPos : lastPos;
        focusPos(navigate(rows(), { row: from.row, col: from.col }, direction));
        return true; // clamped edges are handled too — never fall through
      });
      onCleanup(dispose);
    });

    // -- chords (PSP tradition; latched — the panel mounts under a held key)
    const chord = { latched: true, allowWhenBlocked: true };
    onButtonPress(BTN.SQUARE, () => props.osk.backspace(), chord);
    onButtonPress(BTN.TRIANGLE, () => props.osk.insert(" "), chord);
    onButtonPress(BTN.CROSS, () => props.osk.cancel(), chord);
    onButtonPress(BTN.START, () => props.osk.commit(), chord);
    onButtonPress(BTN.RTRIGGER, shift, chord);
    onButtonPress(BTN.LTRIGGER, () => {
      setLocked(false);
      switchLayer(oskLayerToggle(kind, layer()));
    }, chord);

    // -- held □ auto-repeats backspace, in virtual frames; a d-pad press on a
    //    contact surface reveals the hidden ring first.
    let squareFrames = 0;
    let previous = 0;
    onFrame((buttons) => {
      const delay = Math.max(1, Math.round(0.4 * simulationHz()));
      const every = Math.max(1, Math.round(0.1 * simulationHz()));
      if (buttons & BTN.SQUARE) {
        squareFrames++;
        if (squareFrames >= delay && (squareFrames - delay) % every === 0) props.osk.backspace();
      } else {
        squareFrames = 0;
      }
      if (!untrack(focusShown) && buttons & DPAD && !(previous & DPAD)) {
        reveal = true;
        setFocusShown(true);
        focusPos(lastPos);
      }
      if ((buttons & BTN.CIRCLE) !== (previous & BTN.CIRCLE)) {
        setPressedPos(buttons & BTN.CIRCLE && untrack(focusShown) ? { row: lastPos.row, col: lastPos.col } : null);
      }
      previous = buttons;
    });
  }

  // -- contact adapter -------------------------------------------------------
  //    Installed on every surface: where no contacts arrive the recognizer
  //    is inert, and a host that injects contacts anyway (the sim) types.
  //    The staggered layout runs the phone press model (keyboard-touch.ts):
  //    characters type on the down edge, space and backspace are holds. The
  //    grid keeps the press model of a focus-first panel: a down highlights
  //    the key, dragging retargets, sliding off cancels and release-inside
  //    commits; backspace fires on the down and repeats while held.
  {
    const touch = createKeyboardTouch({
      space: () => props.osk.insert(" "),
      backspace: () => props.osk.backspace(),
      caret: (direction) => props.osk.moveCaret(direction),
      trackpad: setTracking,
    });
    onCleanup(() => touch.cancel());
    const armed = new Map<number, OskKeyRect | null>();
    let owner = -1;
    const keyRectPx = (rect: OskKeyRect) => ({
      x: metrics.pad + rect.x,
      y: viewport.h - panelHeight + rowsTop + rect.row * (rowHeight + metrics.gap),
      w: rect.w,
      h: rowHeight,
    });
    const highlight = (rect: OskKeyRect | null): void => {
      if (rect && untrack(focusShown)) focusPos({ row: rect.row, col: rect.col });
      setActiveNode(rect ? keyNodes[rect.row]?.[rect.col] ?? null : null);
      setPressedPos(rect ? { row: rect.row, col: rect.col } : null);
    };
    const release = (id: number, cancelled: boolean): void => {
      touch.release(id, cancelled);
      const rect = armed.get(id);
      armed.delete(id);
      if (owner === id) {
        owner = -1;
        setActiveNode(null);
        setPressedPos(null);
      }
      if (kind === "grid" && rect) {
        setActiveNode(null);
        setPressedPos(null);
        if (!cancelled && rect.key.action !== "backspace") activate(rect.key);
      }
    };
    createGesture({
      surface: props.surface,
      region: {
        node: () => rootNode,
        // Dock-at-the-bottom geometry for hosts without hitTest.
        rect: () => ({ x: 0, y: viewport.h - panelHeight, w: viewport.w, h: panelHeight }),
      },
      allowWhenBlocked: true, // exempt from the OSK's own touch block
      tapSlop: 9999, // the panel owns its press model — no tap/pan recognition
      onDown: (c) => {
        const rect = resolveTouch(c.x, c.y);
        if (kind === "grid") {
          armed.set(c.id, rect);
          highlight(rect);
          if (rect?.key.action === "backspace") touch.begin(c.id, c.x, c.y, "backspace", keyRectPx(rect), virtualNow());
          return;
        }
        if (!rect) return;
        const holdKind = rect.key.action === "backspace" ? "backspace" : rect.key.ch === " " ? "space" : "other";
        if (!touch.begin(c.id, c.x, c.y, holdKind, keyRectPx(rect), virtualNow())) return;
        owner = c.id;
        lastPos = { row: rect.row, col: rect.col };
        remember();
        if (untrack(focusShown)) {
          setFocusShown(false);
          focusNode(null);
        }
        setActiveNode(keyNodes[rect.row]?.[rect.col] ?? null);
        setPressedPos({ row: rect.row, col: rect.col });
        if (holdKind === "other") activate(rect.key);
      },
      onMove: (c) => {
        touch.move(c.id, c.x, c.y);
        if (kind !== "grid") return;
        const rect = resolveTouch(c.x, c.y);
        const previous = armed.get(c.id) ?? null;
        if (rect === previous) return;
        if (previous?.key.action === "backspace") touch.release(c.id, true);
        armed.set(c.id, rect);
        highlight(rect); // retarget — or cancel when the finger slid off
      },
      onUp: (c) => release(c.id, false),
      onCancel: (c) => release(c.id, true),
    });
    onFrame(() => touch.step(virtualNow()));
  }

  const resolveTouch = (x: number, y: number): OskKeyRect | null => {
    const node = hitFocusable(x, y, props.surface);
    if (node) return nodeInfo.get(node) ?? null;
    if (props.surface === "auxiliary" ? getOps().hitTestAuxiliary : getOps().hitTest) return null;
    // No hitTest op: assume the panel is docked at the bottom of the screen.
    const pos = keyAtPoint(rows(), x - metrics.pad, y - (viewport.h - panelHeight) - rowsTop, rowHeight, metrics.gap);
    return pos ? rows()[pos.row][pos.col] : null;
  };

  // -- panel ------------------------------------------------------------------
  const keyCls = (key: OskKeyDef): string => (key.ch === undefined ? KEY[props.theme].special : KEY[props.theme].key);
  const labelOf = (key: OskKeyDef): string => {
    if (key.action === "shift" && kind === "staggered") return locked() ? "⇪" : "⇧";
    return key.label ?? key.ch ?? "";
  };
  const legend = (): string =>
    tracking() ? "Slide to move the cursor" : props.hint ?? `${glyph("cross")} close · ${glyph("start")} confirm`;
  const letterCls = kind === "staggered" ? "text-sm" : "text-xs font-bold";

  const classic = props.theme === "classic";
  const lipStyle = { posType: ENUMS.PosType.Absolute, insetL: 3, insetR: 3, insetT: 1, height: 1, bgColor: "#ffffffaa" };

  // <Index>, not <For>: a layer switch rewrites labels and rects IN PLACE
  // on the existing key nodes instead of destroying and recreating ~40
  // Focusables (three nodes each on the classic theme), which stalled the
  // PSP for a visible beat on every shift. Only rows whose key count
  // changes create or drop a node.
  const panel = (
    <FocusScope
      restoreFocus={false}
      autoFocus={false}
      ref={(n: NodeMirror) => {
        rootNode = n;
      }}
      class={PANEL[props.theme]}
      style={{ height: panelHeight, width: viewport.w, translateY: panelHeight }}
    >
      {classic ? <View class="absolute" style={{ insetL: 0, insetT: 0, width: viewport.w, height: 1, bgColor: "#7f8a99" }} /> : null}
      {classic ? <View class="absolute" style={{ insetL: 0, insetT: 1, width: viewport.w, height: 1, bgColor: "#f5f7fa" }} /> : null}
      <Show when={metrics.hint > 0}>
        <View class="absolute items-center justify-center" style={{ insetL: 0, insetT: 2, width: viewport.w, height: metrics.hint }}>
          <Text class="text-xs" style={{ textColor: HINT_INK, lineHeight: 12 }}>
            {legend()}
          </Text>
        </View>
      </Show>
      <Index each={rows()}>
        {(row, r) => (
          <View
            class="absolute"
            style={{ insetT: rowsTop + r * (rowHeight + metrics.gap), insetL: metrics.pad, width: innerWidth, height: rowHeight }}
          >
            <Index each={row()}>
              {(rect) => {
                let node: NodeMirror | undefined;
                createEffect(() => {
                  if (node) registerKey(node, rect());
                });
                return (
                  <Focusable
                    nodeRef={(n) => {
                      node = n;
                    }}
                    class={keyCls(rect().key)}
                    style={{ insetL: rect().x, insetT: 0, width: rect().w, height: rowHeight }}
                    onPress={() => activate(rect().key)}
                  >
                    {classic ? <View style={lipStyle} /> : null}
                    <Text
                      class={rect().key.ch !== undefined && rect().key.ch !== " " ? letterCls : "text-xs font-bold"}
                      style={{
                        textColor: isPressed(rect()) ? "#ffffff" : rect().key.ch !== undefined ? INK[props.theme] : INK_DIM[props.theme],
                        lineHeight: kind === "staggered" ? 14 : 12,
                        opacity: tracking() ? 0.35 : 1,
                      }}
                    >
                      {labelOf(rect().key)}
                    </Text>
                  </Focusable>
                );
              }}
            </Index>
          </View>
        )}
      </Index>
    </FocusScope>
  );

  // Initial focus + refocus after every layer switch. Created after the
  // tree so it runs after the key registrations for the new rows. A hidden
  // ring stays hidden: the position is kept, the node is not focused.
  createEffect(() => {
    rows();
    if (untrack(focusShown)) focusPos(lastPos);
    else lastPos = clampPos(rows(), lastPos);
  });

  return panel;
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
  layout?: OskLayoutKind;
  hint?: string;
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

const FIELD_TEXT: Readonly<Record<OskThemeName, string>> = {
  dark: "text-sm text-slate-100",
  light: "text-sm text-slate-800",
  classic: "text-sm text-[#283444]",
};

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
          (props.theme === "classic"
            ? "rounded-lg bg-white border border-[#9aa5b2] px-3 py-1 focus:border-[#2676cb] active:bg-[#e3effe]"
            : "rounded-md bg-[#10161f] border-[#232e3c] px-2 py-1 focus:border-[#4a5a70] active:bg-[#1a2333]")
        );
      },
      get children() {
        return Text({
          get class() {
            return osk.isOpen() || props.value()
              ? FIELD_TEXT[props.theme ?? "dark"]
              : props.theme === "classic" ? "text-sm text-[#667485]" : "text-sm text-slate-500";
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
            return Osk({
              osk,
              surface,
              keyHeight: props.keyHeight,
              layout: props.layout,
              get theme() { return props.theme; },
              get hint() { return props.hint; },
            });
          },
        }),
    }),
  ] as unknown as SolidJSX.Element;
}
