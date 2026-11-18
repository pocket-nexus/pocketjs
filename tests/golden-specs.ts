import { BTN, SCREEN_H, SCREEN_W } from "../contracts/spec/spec.ts";
import {
  layoutRows,
  OSK_GAP,
  OSK_H,
  OSK_LAYERS,
  OSK_PAD,
  OSK_ROW_H,
} from "../framework/src/osk-layout.ts";

export interface TouchPoint {
  id: number;
  x: number;
  y: number;
}

export interface GoldenSpec {
  name: string;
  /** App bundle to build/run — defaults to `name`. Set it when several specs
   *  exercise one app (golden files keep the spec's own name). */
  app?: string;
  frames: number;
  capture: number[];
  input?: (frame: number) => number;
  /** Scripted front-panel contacts for the frame, logical px. Undefined or
   *  [] = no contacts. Runs on hosts that deliver touch (vita, wasm oracle). */
  touch?: (frame: number) => readonly TouchPoint[];
}

/** Center of an OSK key on the given layer, in screen px (panel docked at
 *  the bottom of the screen — the system convention). */
function oskKeyCenter(ch: string, layer: keyof typeof OSK_LAYERS = "lower"): { x: number; y: number } {
  const rows = layoutRows(OSK_LAYERS[layer], SCREEN_W - 2 * OSK_PAD);
  for (const row of rows) {
    for (const k of row) {
      if (k.key.ch === ch) {
        return {
          x: Math.round(OSK_PAD + k.x + k.w / 2),
          y: Math.round(SCREEN_H - OSK_H + OSK_PAD + k.row * (OSK_ROW_H + OSK_GAP) + OSK_ROW_H / 2),
        };
      }
    }
  }
  throw new Error(`golden-specs: no ${JSON.stringify(ch)} key on layer ${String(layer)}`);
}

// Shared by the headless WASM oracle and Vita3K E2E so inputs/frame indices
// cannot drift between hosts.
export const GOLDEN_SPECS: GoldenSpec[] = [
  {
    name: "hero-main",
    frames: 90,
    capture: [2, 10, 80],
    input: (f) =>
      f === 5 ? BTN.DOWN : f >= 20 && f <= 36 && (f - 20) % 4 === 0 ? BTN.CIRCLE : 0,
  },
  {
    name: "cards-main",
    frames: 90,
    capture: [2, 12, 24, 78],
    input: (f) => (f === 4 || f === 8 ? BTN.RIGHT : f === 18 ? BTN.CIRCLE : 0),
  },
  {
    name: "stats-main",
    frames: 95,
    capture: [2, 20, 85],
    input: (f) => (f === 50 ? BTN.RIGHT : 0),
  },
  {
    name: "library-main",
    frames: 170,
    capture: [2, 30, 105, 150],
    input: (f) =>
      f === 4 || f === 8 ? BTN.RIGHT : f === 20 ? BTN.CIRCLE : f === 120 ? BTN.TRIANGLE : 0,
  },
  {
    name: "settings-main",
    frames: 100,
    capture: [2, 26, 90],
    input: (f) =>
      f === 4
        ? BTN.DOWN
        : f === 10
          ? BTN.CIRCLE
          : f === 16
            ? BTN.DOWN
            : f === 22
              ? BTN.CIRCLE
              : f === 28
                ? BTN.DOWN
                : f === 34
                  ? BTN.CIRCLE
                  : f === 40 || f === 44 || f === 48
                    ? BTN.DOWN
                    : f === 54
                      ? BTN.CIRCLE
                      : 0,
  },
  {
    name: "notifications-main",
    frames: 70,
    capture: [2, 34, 60],
    input: (f) => (f === 10 || f === 16 ? BTN.DOWN : f === 24 ? BTN.CIRCLE : 0),
  },
  {
    name: "music-main",
    frames: 100,
    capture: [2, 20, 60, 90],
    input: (f) =>
      f === 4
        ? BTN.DOWN
        : f === 10
          ? BTN.CIRCLE
          : f === 30 || f === 36
            ? BTN.DOWN
            : f === 42
              ? BTN.CIRCLE
              : f === 70
                ? BTN.RTRIGGER
                : 0,
  },
  {
    name: "gallery-main",
    frames: 236,
    capture: [42, 82, 132, 178, 200, 226],
    input: (f) =>
      f === 22
        ? BTN.RIGHT
        : f === 30
          ? BTN.CIRCLE
          : f === 50 || f === 100 || f === 150
            ? BTN.RTRIGGER
            : f === 190
              ? BTN.LTRIGGER
              : 0,
  },
  {
    name: "motions-main",
    frames: 240,
    capture: [8, 60, 120, 170, 236],
    input: (f) => (f === 200 ? BTN.RIGHT : 0),
  },
  {
    // chrome: bevel border rings (Win98 window mock, apps/chrome). f2 =
    // initial layout: raised window frame, sunken text well, thin status
    // cells, navy caption gradient. DOWN@4 focuses OK, RIGHT@8 moves to
    // CANCEL — f12 shows the focus face tint; CIRCLE held f16..22 — f18 is
    // the active: bevel INVERSION; f26 is released and back to raised.
    name: "chrome-main",
    frames: 30,
    capture: [2, 12, 18, 26],
    input: (f) =>
      f === 4 ? BTN.DOWN : f === 8 ? BTN.RIGHT : f >= 16 && f <= 22 ? BTN.CIRCLE : 0,
  },
  {
    // cursor: the virtual pointer (input.cursor, apps/cursor). Steered by
    // d-pad at 1 px/frame (enableCursor dpadSpeed: 60) so the tape stays
    // button-only. Boot centers the arrow at (240,136) in the gap between
    // rows — f2 shows the sprite over nothing. UP 4..13 lands on row 2 —
    // f16 shows hover (= focus: tint). CIRCLE held 18..25 — f22 is the
    // active: bevel inversion under the pointer. Release clicks: DOWN
    // 30..61 rides down to row 3 — f64 shows the moved hover + the status
    // line recording the row-2 click. A second press 66..73 clicks row 3 —
    // f80 shows its status.
    name: "cursor-main",
    frames: 90,
    capture: [2, 16, 22, 64, 80],
    input: (f) =>
      f >= 4 && f < 14
        ? BTN.UP
        : f >= 18 && f < 26
          ? BTN.CIRCLE
          : f >= 30 && f < 62
            ? BTN.DOWN
            : f >= 66 && f < 74
              ? BTN.CIRCLE
              : 0,
  },
  {
    // im (Pocket Talk): bootstrap lands at f30 — f40 is the conversation
    // list (presence, unread badges, previews). CIRCLE@60 opens MAYA CHEN —
    // f80 is the thread bottom (wrapped bubbles, read ticks). UP held
    // 90..150 scrolls the virtual window — f160 shows mid-history with a
    // day chip. SELECT@170 jumps back, TRIANGLE@200 opens the OSK, DOWN@230
    // walks focus to 'q', CIRCLE@260 types it — f280 is the OSK with a live
    // draft. START@300 sends; f370 has the ack + delivery receipt (gray ✓✓).
    name: "im-main",
    frames: 380,
    capture: [40, 80, 160, 280, 370],
    input: (f) =>
      f === 60
        ? BTN.CIRCLE
        : f >= 90 && f < 150
          ? BTN.UP
          : f === 170
            ? BTN.SELECT
            : f === 200
              ? BTN.TRIANGLE
              : f === 230
                ? BTN.DOWN
                : f === 260
                  ? BTN.CIRCLE
                  : f === 300
                    ? BTN.START
                    : 0,
  },
  {
    // im, driven by TOUCH — the first touch golden. CIRCLE@60 opens MAYA
    // CHEN, TRIANGLE@90 opens the OSK. A finger lands on 'h' at f120 and
    // HOLDS — f124 captures the pressed key (the native active: variant, a
    // state no button tape can show under touch). Release at f128 commits
    // (the modern press model); a tap types 'i' at f150..152. f180 shows
    // the live "hi" draft. START@210 sends; f300 has the delivered bubble.
    name: "im-touch",
    app: "im-main",
    frames: 310,
    capture: [124, 180, 300],
    input: (f) => (f === 60 ? BTN.CIRCLE : f === 90 ? BTN.TRIANGLE : f === 210 ? BTN.START : 0),
    touch: (f) => {
      if (f >= 120 && f < 128) return [{ id: 0, ...oskKeyCenter("h") }];
      if (f >= 150 && f < 152) return [{ id: 0, ...oskKeyCenter("i") }];
      return [];
    },
  },
  {
    // App-layer touch through the whole host stack: a tap on a conversation
    // row must open the thread via the default activation recognizer — the
    // coverage that was missing when every hardware touch resolved to the
    // TextField's portal host (fix/portal-hit-pass). f40 = the list; f90 =
    // after the tap resolved.
    name: "im-rowtap",
    app: "im-main",
    frames: 100,
    capture: [40, 90],
    input: () => 0,
    touch: (f) => {
      if (f >= 60 && f < 64) return [{ id: 0, x: 240, y: 90 }];
      return [];
    },
  },
];

export function encodeThresholdInput(spec: GoldenSpec): string {
  const lastFrame = Math.max(...spec.capture);
  const entries: string[] = [];
  let previous = -1;
  for (let frame = 0; frame <= lastFrame; frame++) {
    const buttons = spec.input?.(frame) ?? 0;
    if (frame === 0 || buttons !== previous) {
      entries.push(`${frame}:0x${buttons.toString(16)}`);
      previous = buttons;
    }
  }
  return entries.join(",");
}

/** Level-triggered touch script for the capture hosts: `frame:id,x,y[+…]`
 *  entries joined by `;`, `frame:-` releases. Touch-free specs encode to ""
 *  so button-only builds stay byte-identical. */
export function encodeTouchInput(spec: GoldenSpec): string {
  if (!spec.touch) return "";
  const lastFrame = Math.max(...spec.capture);
  const entries: string[] = [];
  let previous = "";
  for (let frame = 0; frame <= lastFrame; frame++) {
    const contacts = spec.touch(frame);
    const encoded =
      contacts.length === 0 ? "-" : contacts.map((c) => `${c.id},${c.x},${c.y}`).join("+");
    if (frame === 0 || encoded !== previous) {
      entries.push(`${frame}:${encoded}`);
      previous = encoded;
    }
  }
  return entries.length === 1 && entries[0] === "0:-" ? "" : entries.join(";");
}

/** Packed contacts (touch.ts wire words) for one frame, or undefined. */
export function packedTouchFor(spec: GoldenSpec, frame: number): number[] | undefined {
  const contacts = spec.touch?.(frame);
  if (!contacts || contacts.length === 0) return undefined;
  return contacts.map(
    (c) => (((c.id & 0xff) << 18) | ((c.y & 0x1ff) << 9) | (c.x & 0x1ff)) >>> 0,
  );
}
