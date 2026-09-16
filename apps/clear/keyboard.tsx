// The edit keyboard: the classic early-iOS portrait layout (apps/clear/
// kb-layout.ts) rendered as four static layer panels that slide on and off
// the paint axis — a layer flip costs four prop writes and zero re-renders.
// Pressing a character key raises the classic key-cap popup: a balloon above
// the key showing the glyph enlarged, visible while the finger is down.
//
// Shift is one-shot (typing a letter on the upper layer drops back to
// lower); the numbers layer's third-row-left key toggles "#+=" symbols in
// place while the bottom-left key stays "ABC" on both, like the original.

import { Image, Text, View, type NodeMirror } from "@pocketjs/framework/components";
import { animate, jump } from "@pocketjs/framework/animation";
import { virtualNow } from "@pocketjs/framework/clock";
import { onFrame } from "@pocketjs/framework/lifecycle";
import { createScroller } from "@pocketjs/framework/kinetics";
import { shallowRef, onScopeDispose } from "vue";
import { createKeyboardTouch } from "./keyboard-touch.ts";
import { remoteText, hasCompanion } from "./remote-text.tsx";
import type { ImeState, ImeCandidatePage } from "@pocketjs/framework/ime";
import { createCandidatePanel, candidateSlots, CANDIDATE_ROW_H, type CandidateCell } from "./candidate-panel.ts";
import { SCREEN_H } from "./metrics.ts";
import { IME_BAR_H, IME_LABEL_H, IME_LABEL_GAP, IME_INLINE_CANDIDATES } from "./keyboard-metrics.ts";
import { KB_GAP, KB_H, KB_PAD, KB_ROW_H, KB_W } from "./keyboard-metrics.ts";
import { KB_LAYERS, kbKeyAt, type KbKey, type KbLayerName } from "./kb-layout.ts";

export { KB_GAP, KB_H, KB_PAD, KB_ROW_H, KB_W } from "./keyboard-metrics.ts";

/** Key-cap gradients: an all-dark scheme (deliberately NOT the classic iOS
 *  chrome — same layout, own look). Character caps are a lighter graphite
 *  than the action caps; the engaged shift flips to a light cap. */
const CAP_FROM = "#3a3f46";
const CAP_TO = "#2d3138";
const CAP_PRESS_FROM = "#5c626b";
const CAP_PRESS_TO = "#4b515a";
const ACTION_FROM = "#24272c";
const ACTION_TO = "#1a1d21";
const ACTION_PRESS_FROM = "#3d4249";
const ACTION_PRESS_TO = "#31363c";
const ENGAGED_FROM = "#dfe2e6";
const ENGAGED_TO = "#c9cdd3";
const ENGAGED_PRESS_FROM = "#b7bcc3";
const ENGAGED_PRESS_TO = "#a8adb5";

const POPUP_W = 44;
const POPUP_H = 46;

export interface KeyboardHandlers {
  onInsert(ch: string): void;
  onBackspace(): void;
  onEnter(): void;
  onMode?(): void;
  onCandidate?(index: number): void;
  onBrowse?(offset: number, complete: (page: ImeCandidatePage | null) => void): number;
  onCandidateAbsolute?(index: number): void;
  onCaret?(direction: number): void;
  onCancelComposition?(): void;
}

const LAYER_NAMES: readonly KbLayerName[] = ["lower", "upper", "numbers", "symbols"];

export interface Keyboard {
  view: JSX.Element;
  height(): number;
  setIme(state: ImeState, chinese: boolean): void;
  /** Dock/undock the panel (animated). */
  setOpen(open: boolean): void;
  isOpen(): boolean;
  /** The docked panel's screen rect, for the gesture region. */
  rect(): { x: number; y: number; w: number; h: number } | null;
  /** Route a contact's down edge (screen coordinates) into a key press. */
  pressAt(x: number, y: number, screenH: number, id?: number): void;
  moveAt(x: number, y: number, id?: number): void;
  /** The contact lifted (or was cancelled): dismiss the key-cap popup. */
  release(id?: number, cancelled?: boolean): void;
}

type CapKind = "char" | "action" | "engaged";

/** Character caps are graphite, action caps darker; the shift key on the
 *  upper layer renders as the light "engaged" cap. */
function capKind(key: KbKey, layer: KbLayerName): CapKind {
  if (key.action === "shift" && layer === "upper") return "engaged";
  return key.ch !== undefined ? "char" : "action";
}

const CAP_COLORS: Record<CapKind, [string, string, string, string]> = {
  char: [CAP_FROM, CAP_TO, CAP_PRESS_FROM, CAP_PRESS_TO],
  action: [ACTION_FROM, ACTION_TO, ACTION_PRESS_FROM, ACTION_PRESS_TO],
  engaged: [ENGAGED_FROM, ENGAGED_TO, ENGAGED_PRESS_FROM, ENGAGED_PRESS_TO],
};

export function makeKeyboard(handlers: KeyboardHandlers): Keyboard {
  const imeHeight = hasCompanion() ? IME_BAR_H : 0;
  const imeStatus = shallowRef("EN");
  const modeWidth = shallowRef(28), preeditWidth = shallowRef(28);
  const preedit = shallowRef("");
  const candidatePending = shallowRef(false), preeditPending = shallowRef(false);
  const composing = shallowRef(false), expanded = shallowRef(false);
  const candidates = Array.from({ length: IME_INLINE_CANDIDATES }, () => shallowRef(""));
  const inlineWidth = (KB_W - 88) / IME_INLINE_CANDIDATES;
  let inlineClipped = false;
  const candidateHeight = KB_H;
  const labelOverhang = () => composing.value ? IME_LABEL_H + IME_LABEL_GAP : 0;
  let candidatePanel: ReturnType<typeof createCandidatePanel>;
  const candidateScroll = createScroller({ max: () => candidatePanel?.max() ?? 0, extent: () => candidateHeight, overscroll: 20 });
  candidatePanel = createCandidatePanel({ width: KB_W, height: candidateHeight, scroller: candidateScroll,
    // Long phrases need the full-width panel even when they are among the first three.
    firstIndex: () => inlineClipped ? 0 : IME_INLINE_CANDIDATES,
    browse: (offset, complete) => handlers.onBrowse?.(offset, complete) ?? 0,
    select: index => handlers.onCandidateAbsolute?.(index) });
  const panelCells = Array.from({ length: Math.ceil(KB_W / 64) * (Math.ceil(candidateHeight / CANDIDATE_ROW_H) + 2) },
    () => shallowRef<CandidateCell | null>(null));
  const panelOffset = shallowRef(0), panelMax = shallowRef(0);
  let lastVisible: readonly CandidateCell[] | undefined;
  const layerNodes = new Map<KbLayerName, NodeMirror>();
  const keyNodes = new Map<string, NodeMirror>();
  const spaceNodes = new Set<NodeMirror>();
  let spacePressed = false;
  let panel: NodeMirror | null = null;
  let popupNode: NodeMirror | null = null;
  const popupText = shallowRef("");
  const tracking = shallowRef(false);
  let popupOwner = -1, popupAt = 0, popupHideAt = Infinity;
  let open = false;
  let layer: KbLayerName = "lower";
  const touch = createKeyboardTouch({
    space: () => handlers.onInsert(" "), backspace: () => handlers.onBackspace(),
    caret: direction => handlers.onCaret?.(direction),
    trackpad(active) {
      tracking.value = active;
      if (active && popupNode) { jump(popupNode, "opacity", 0); popupOwner = -1; popupHideAt = Infinity; }
    },
  });
  onFrame(() => {
    const now = virtualNow();
    candidatePanel.step(); expanded.value = candidatePanel.isOpen();
    panelOffset.value = candidatePanel.offset(); panelMax.value = candidatePanel.max();
    const visible = candidatePanel.visible();
    if (visible !== lastVisible) {
      lastVisible = visible;
      const slots = candidateSlots(panelCells.map(cell => cell.value), visible);
      for (let i = 0; i < panelCells.length; i++) if (panelCells[i].value !== slots[i]) panelCells[i].value = slots[i];
    }
    touch.step(now);
    syncSpacePress();
    if (now >= popupHideAt) {
      popupHideAt = Infinity;
      if (popupNode) animate(popupNode, "opacity", 0, { dur: 120, easing: "out" });
    }
  });
  onScopeDispose(() => { touch.cancel(); candidatePanel.close(); });

  function applyLayer(next: KbLayerName): void {
    layer = next;
    for (const name of LAYER_NAMES) {
      const node = layerNodes.get(name);
      if (node) {
        jump(node, "translateX", name === layer ? 0 : KB_W + 40);
        jump(node, "opacity", name === layer ? 1 : 0);
      }
    }
  }

  function syncSpacePress(fade = true): void {
    const pressed = touch.holdingSpace();
    if (pressed === spacePressed) return;
    spacePressed = pressed;
    for (const node of spaceNodes) {
      if (pressed || !fade) {
        jump(node, "gradFrom", pressed ? CAP_PRESS_FROM : CAP_FROM);
        jump(node, "gradTo", pressed ? CAP_PRESS_TO : CAP_TO);
      } else {
        animate(node, "gradFrom", CAP_FROM, { dur: 180, easing: "out" });
        animate(node, "gradTo", CAP_TO, { dur: 180, easing: "out" });
      }
    }
  }

  function flashKey(name: KbLayerName, row: number, col: number): void {
    const node = keyNodes.get(`${name}:${row}:${col}`);
    if (!node) return;
    const key = KB_LAYERS[name][row][col];
    const [from, to, pressFrom, pressTo] = CAP_COLORS[capKind(key, name)];
    jump(node, "gradFrom", pressFrom);
    jump(node, "gradTo", pressTo);
    animate(node, "gradFrom", from, { dur: 180, easing: "out" });
    animate(node, "gradTo", to, { dur: 180, easing: "out" });
  }

  function showPopup(key: KbKey, row: number, id: number): void {
    if (!popupNode || key.ch === undefined || key.ch === " ") return;
    popupText.value = key.ch;
    popupOwner = id; popupAt = virtualNow(); popupHideAt = Infinity;
    const x = Math.max(2, Math.min(KB_W - POPUP_W - 2, key.x + key.w / 2 - POPUP_W / 2));
    const y = KB_PAD + row * (KB_ROW_H + KB_GAP) - POPUP_H - 6;
    jump(popupNode, "translateX", x);
    jump(popupNode, "translateY", y);
    jump(popupNode, "opacity", 1);
  }

  function press(row: number, col: number, id: number, x: number, y: number, screenH: number): void {
    const key = KB_LAYERS[layer][row][col];
    if (!touch.begin(id, x, y, key.ch === " " ? "space" : key.action === "backspace" ? "backspace" : "other",
      { x: key.x, y: screenH - KB_H + KB_PAD + row * (KB_ROW_H + KB_GAP), w: key.w, h: KB_ROW_H }, virtualNow())) return;
    if (key.ch === " ") syncSpacePress();
    else flashKey(layer, row, col);
    showPopup(key, row, id);
    if (key.ch === " " || key.action === "backspace") return;
    if (key.ch !== undefined) {
      handlers.onInsert(key.ch);
      if (layer === "upper") applyLayer("lower"); // one-shot shift
      return;
    }
    switch (key.action) {
      case "shift":
        applyLayer(layer === "lower" ? "upper" : "lower");
        break;
      case "num":
        applyLayer("numbers");
        break;
      case "sym":
        applyLayer("symbols");
        break;
      case "abc":
        applyLayer("lower");
        break;
      case "return":
        handlers.onEnter();
        break;
      case "globe":
        handlers.onMode?.();
        break;
    }
  }

  /** Baked filled contours keep thin meridians antialiased at native density. */
  function globeIcon() {
    return (
      <Image src="icon-globe.svg" style={{ width: 24, height: 24, opacity: tracking.value ? 0.25 : 1 }} />
    );
  }

  function renderKey(name: KbLayerName, key: KbKey, r: number, c: number) {
    const kind = capKind(key, name);
    const label = key.label ?? key.ch ?? "";
    const small = label.length > 1;
    // Keep the text resource/painter alive across the trackpad branch. Frame
    // hooks belong to the layer's scope, not a conditional child factory.
    const modeLabel = key.ch === " " && imeHeight > 0
      ? remoteText(() => imeStatus.value, key.w - 12, 14, undefined, false, undefined, () => open, 0,
        width => { modeWidth.value = width; })
      : null;
    return (
      <View
        nodeRef={(node) => {
          if (node) {
            keyNodes.set(`${name}:${r}:${c}`, node);
            if (key.ch === " ") spaceNodes.add(node);
          }
        }}
        class={
          kind === "char"
            ? "absolute rounded-md justify-center items-center bg-gradient-to-b from-[#3a3f46] to-[#2d3138]"
            : kind === "action"
              ? "absolute rounded-md justify-center items-center bg-gradient-to-b from-[#24272c] to-[#1a1d21]"
              : "absolute rounded-md justify-center items-center bg-gradient-to-b from-[#dfe2e6] to-[#c9cdd3]"
        }
        style={{
          insetL: key.x,
          insetT: KB_PAD + r * (KB_ROW_H + KB_GAP),
          width: key.w,
          height: KB_ROW_H,
          shadow: 1,
        }}
      >
        {key.action === "globe" ? (
          globeIcon()
        ) : key.action === "backspace" ? (
          <Image src="icon-backspace.svg" style={{ width: 26, height: 24, opacity: tracking.value ? 0.25 : 1 }} />
        ) : key.ch === " " && tracking.value ? (
          <View class="absolute inset-0 items-center justify-center">
            <Image src="icon-trackpad.svg" style={{ width: 96, height: 24 }} />
          </View>
        ) : modeLabel ? null : (
          <Text
            style={{ opacity: tracking.value ? 0.25 : 1 }}
            class={
              kind === "engaged"
                ? "text-lg text-[#16181c]"
                : small
                  ? "text-sm text-[#d3d7dc]"
                  : "text-lg text-white"
            }
          >
            {label}
          </Text>
        )}
        {modeLabel ? <View class="absolute" style={{ insetL: (key.w - modeWidth.value) / 2, insetT: (KB_ROW_H - 22) / 2,
          width: key.w - 12, height: 22, opacity: tracking.value ? 0 : 1 }}>{modeLabel}</View> : null}
      </View>
    );
  }

  function renderLayer(name: KbLayerName) {
    return (
      <View
        nodeRef={(node) => {
          if (node) layerNodes.set(name, node);
        }}
        class="absolute inset-0"
        style={{ translateX: name === "lower" ? 0 : KB_W + 40, opacity: name === "lower" ? 1 : 0 }}
      >
        {KB_LAYERS[name].map((row, r) => row.map((key, c) => renderKey(name, key, r, c)))}
      </View>
    );
  }

  const view = (
    <View
      nodeRef={(node) => {
        if (node) panel = node;
      }}
      class="absolute left-0 right-0 bottom-0 z-40 bg-gradient-to-b from-[#17191d] to-[#0d0f12]"
      style={{ height: KB_H, translateY: KB_H + POPUP_H + IME_BAR_H + 8 }}
    >
      <View class="absolute left-0 right-0 top-0 bg-[#000000]" style={{ height: 1 }} />
      {imeHeight > 0 ? <View class="absolute left-0 right-0 bg-[#1a1d21]" style={{ insetT: -imeHeight, height: imeHeight }}>
        <View class="absolute left-[6] rounded-sm overflow-hidden bg-[#252a30]" style={{ insetT: -IME_LABEL_H - IME_LABEL_GAP,
          width: preeditWidth.value + 12, height: IME_LABEL_H, opacity: composing.value ? 1 : 0 }}>
          <View class="absolute left-[6] top-0">
            {remoteText(() => preedit.value, KB_W - 24, 12, undefined, false, () => preeditPending.value,
              () => composing.value, 0, width => { preeditWidth.value = Math.max(16, Math.ceil(width)); })}
          </View>
        </View>
        <View class="absolute right-[44] top-0 w-[44] h-[44] items-center justify-center" style={{ opacity: composing.value ? 1 : 0 }}><Image src="icon-cancel.svg" class="w-[24] h-[24]" /></View>
        <View class="absolute right-0 top-0 w-[44] h-[44] items-center justify-center" style={{ opacity: composing.value ? 1 : 0 }}><Image src="icon-expand.svg" class="w-[24] h-[24]" style={{ rotate: expanded.value ? 180 : 0 }} /></View>
        {candidates.map((candidate, i) => <View class="absolute overflow-hidden" style={{ insetL: 8 + i * inlineWidth, insetT: 10, width: inlineWidth - 12, height: 28 }}>
          {remoteText(() => candidate.value, inlineWidth - 12, 16, undefined, false, () => candidatePending.value, () => open, 0)}
        </View>)}
      </View> : null}
      {/* The opaque candidate panel owns this area while expanded. Keep key
          state mounted, but cull its covered draw subtree on every host. */}
      <View class="absolute inset-0" style={{ opacity: expanded.value ? 0 : 1 }}>
        {LAYER_NAMES.map((name) => renderLayer(name))}
      </View>
      {imeHeight > 0 ? <View class="absolute left-0 right-0 overflow-hidden bg-[#1a1d21]" style={{ insetT: 0, height: candidateHeight, translateX: expanded.value ? 0 : KB_W + 40 }}>
        <View class="absolute inset-0" style={{ translateY: -panelOffset.value }}>
        {panelCells.map(cell => <View class="absolute overflow-hidden" style={{ insetL: cell.value?.x ?? 0,
          insetT: cell.value?.y ?? -100, width: cell.value?.w ?? 64, height: CANDIDATE_ROW_H }}>
          <View class="absolute left-[10] top-[10]">
            {remoteText(() => cell.value?.text ?? "", KB_W - 20, 16, undefined, false,
              () => expanded.value && !!cell.value?.pending, () => expanded.value && !!cell.value, 0)}
          </View>
          <View class="absolute left-[8] right-[8] bottom-0 bg-[#34383f]" style={{ height: 1, opacity: cell.value?.divider ? 0.5 : 0 }} />
        </View>)}
        </View>
        <View class="absolute right-[2] rounded-sm bg-[#6c7785]" style={{ width: 2,
          height: Math.max(16, candidateHeight * candidateHeight / (candidateHeight + panelMax.value)),
          insetT: 0, translateY: Math.max(0, panelOffset.value) * candidateHeight / (candidateHeight + panelMax.value), opacity: panelMax.value > 0 ? 0.7 : 0 }} />
      </View> : null}
      <View
        nodeRef={(node) => {
          if (node) popupNode = node;
        }}
        class="absolute rounded-lg justify-center items-center bg-gradient-to-b from-[#454b53] to-[#34383f]"
        style={{
          insetL: 0,
          insetT: 0,
          width: POPUP_W,
          height: POPUP_H,
          opacity: 0,
          shadow: 2,
          borderColor: "#101215",
          borderWidth: 1,
        }}
      >
        <Text class="text-2xl text-white">{popupText.value}</Text>
      </View>
    </View>
  );

  return {
    view,
    height: () => KB_H + imeHeight + labelOverhang(),
    setIme(state, chinese) {
      imeStatus.value = chinese ? "拼音" : "EN";
      composing.value = chinese && state.composing;
      if (!state.pending) inlineClipped = state.candidates.slice(0, IME_INLINE_CANDIDATES)
        .some(text => Array.from(text).length * 16 > inlineWidth - 12);
      candidatePanel.setState(state, chinese);
      candidatePending.value = chinese && state.pending;
      preeditPending.value = chinese && state.connected && state.pending && !state.preedit;
      preedit.value = !chinese ? "" :
        state.preedit ? `${state.preedit.slice(0, state.caret)}|${state.preedit.slice(state.caret)}` : !state.connected ? "Offline" : "";
      for (let i = 0; i < candidates.length; i++) candidates[i].value = chinese && !state.pending ? state.candidates[i] ?? "" : "";
    },
    setOpen(next: boolean): void {
      if (next === open) return;
      open = next;
      if (!next) candidatePanel.close();
      touch.cancel(); syncSpacePress(false); popupOwner = -1; popupHideAt = Infinity;
      if (open) applyLayer("lower");
      if (popupNode) jump(popupNode, "opacity", 0);
      if (panel) {
        animate(panel, "translateY", open ? 0 : KB_H + POPUP_H + IME_BAR_H + 8, { dur: 200, easing: "out" });
      }
    },
    isOpen: () => open,
    rect() {
      const height = KB_H + imeHeight + labelOverhang();
      return open ? { x: 0, y: SCREEN_H - height, w: KB_W, h: height } : null;
    },
    pressAt(x: number, y: number, screenH: number, id = 0): void {
      if (touch.tracking()) return;
      const barY = y - (screenH - KB_H - imeHeight);
      if (composing.value && barY < 0 && barY >= -labelOverhang()) {
        if (x >= 6 && x < preeditWidth.value + 18) handlers.onCaret?.(x < preeditWidth.value / 2 + 12 ? -1 : 1);
        return;
      }
      if (candidatePanel.isOpen() && barY >= IME_BAR_H) {
        candidatePanel.press(id, x, y - (screenH - candidateHeight), virtualNow()); return;
      }
      if (imeHeight && barY >= 0 && barY < imeHeight) {
        if (composing.value && x >= KB_W - 44) { touch.cancel(); candidatePanel.toggle(); }
        else if (composing.value && x >= KB_W - 88) handlers.onCancelComposition?.();
        else if (composing.value && x < KB_W - 88) handlers.onCandidate?.(Math.max(0, Math.min(IME_INLINE_CANDIDATES - 1, Math.floor(x / inlineWidth))));
        return;
      }
      const pos = kbKeyAt(KB_LAYERS[layer], x, y - (screenH - KB_H));
      if (pos) press(pos.row, pos.col, id, x, y, screenH);
    },
    moveAt(x: number, y: number, id = 0) {
      if (candidatePanel.isOpen()) { candidatePanel.move(id, x, y - (SCREEN_H - candidateHeight), virtualNow()); return; }
      touch.move(id, x, y); syncSpacePress();
    },
    release(id = 0, cancelled = false): void {
      if (candidatePanel.release(id, cancelled)) return;
      touch.release(id, cancelled);
      syncSpacePress();
      if (id === popupOwner) {
        popupOwner = -1;
        popupHideAt = cancelled ? virtualNow() : Math.max(popupAt + 0.24, virtualNow() + 0.14);
      }
    },
  };
}
