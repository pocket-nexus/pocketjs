// The playground's devices: a picture of each from the front with where its screen and keys are (microts:shells,
// rendered by tools/handheld-shells.ts), and what each key is to an app. Control mappings follow the pocketjs
// device hosts:
//   GBA        hosts/gba/src/main.rs           A → CIRCLE, B → CROSS
//   3DS        hosts/3ds/src/input.c           A → CIRCLE, B → CROSS, X → TRIANGLE, Y → SQUARE
//   iPod nano  apps/ipod-nano/app.tsx          wheel UP/DOWN, center CIRCLE, MENU TRIANGLE, ⏮⏭ LEFT/RIGHT, ⏯ START
//   BlackBerry docs/BLACKBERRY_CLASSIC.md      trackpad move → direction pulses, press → CIRCLE, Menu → TRIANGLE, Space → START
//   iPhone / iPod touch                        touch screen only; Home belongs to the system
// ui: PSP button names a UI app receives (contracts/spec/spec.ts BTN); retro: Pocket Retro GBA button names.
import { SHELLS, type Shell } from "microts:shells";
import type { Viewport } from "./screens";

export type UiButton = "UP" | "DOWN" | "LEFT" | "RIGHT" | "CIRCLE" | "CROSS" | "SQUARE" | "TRIANGLE" | "START" | "SELECT" | "L" | "R";
export type RetroButton = "UP" | "DOWN" | "LEFT" | "RIGHT" | "A" | "B" | "START" | "SELECT" | "L" | "R";

/** What a shell's control is to a UI app (`ui`) and to a Pocket Retro game (`retro`); a control with neither does not respond */
export interface KeyMap {
  ui?: UiButton;
  retro?: RetroButton;
  /** What the control is called, for a screen reader; the profile's name in capitals when absent */
  label?: string;
  /** Words drawn where a finger takes a key that is out of sight from the front (the 3DS's L and R, behind the hinge) */
  caption?: string;
}

export interface DeviceSpec {
  id: string;
  name: string;
  /** The device from the front; null for a custom size, which gets a plain bezel about its screen */
  shell: Shell | null;
  /** The screen in logical pixels: the preview fills the largest box of this shape in the shell's screen */
  screen: Viewport;
  touch: boolean;
  /** The shell's controls (`button` in its profile) → buttons. The iPod's "wheel" and the BlackBerry's "trackpad" are read by gesture */
  keys: Record<string, KeyMap>;
  /** Why each key the device keeps for itself (`system` in its profile) does nothing, shown on hover */
  system?: Record<string, string>;
  /** Why the second screen (the 3DS's lower one) is dark, shown on hover */
  lower?: string;
  /** Keyboard mapping legend, shown below the device */
  legend: string;
}

const PSP_KEYS: Record<string, KeyMap> = Object.fromEntries(
  ["up", "down", "left", "right", "triangle", "circle", "cross", "square", "l", "r", "start", "select"].map((b) => [b, { ui: b.toUpperCase() as UiButton }]),
);

export const PSP: DeviceSpec = {
  id: "psp",
  name: "PSP",
  shell: SHELLS.psp!,
  screen: { width: 480, height: 272 },
  touch: false,
  keys: PSP_KEYS,
  legend: "Arrows ✚ · Z ○ · X × · A □ · S △ · Q / E L R · Space START · Shift SELECT",
};

/** The GBA's keys are a UI app's PSP buttons (A → ○, B → ×) and a retro game's GBA buttons */
export const GBA: DeviceSpec = {
  id: "gba",
  name: "Game Boy Advance",
  shell: SHELLS.gba!,
  screen: { width: 240, height: 160 },
  touch: false,
  keys: {
    up: { ui: "UP", retro: "UP" },
    down: { ui: "DOWN", retro: "DOWN" },
    left: { ui: "LEFT", retro: "LEFT" },
    right: { ui: "RIGHT", retro: "RIGHT" },
    a: { ui: "CIRCLE", retro: "A" },
    b: { ui: "CROSS", retro: "B" },
    l: { ui: "L", retro: "L" },
    r: { ui: "R", retro: "R" },
    start: { ui: "START", retro: "START" },
    select: { ui: "SELECT", retro: "SELECT" },
  },
  legend: "Arrows ✚ · Z A · X B · Q / E L R · Space START · Shift SELECT",
};

/** Pocket Retro games run on the GBA: same device, keys map straight to GBA buttons */
export const GBA_RETRO: DeviceSpec = {
  ...GBA,
  id: "gba-retro",
  legend: "Arrows ✚ · Z A · X B · Q / E L R · Enter START · Shift SELECT",
};

/** 3DS: the top screen is the app's primary screen; the shell names ABXY by their PSP places (A → ○, B → ×, X → △, Y → □) */
export const N3DS: DeviceSpec = {
  id: "3ds",
  name: "3DS",
  shell: SHELLS["3ds"]!,
  screen: { width: 400, height: 240 },
  touch: false,
  keys: { ...PSP_KEYS, l: { ui: "L", caption: "L" }, r: { ui: "R", caption: "R" } },
  lower: "The bottom touch screen is an auxiliary surface; this preview shows the primary one",
  legend: "Arrows ✚ · Z A · X B · S X · A Y · Q / E L R · Space START · Shift SELECT",
};

const HOME = { home: "Home belongs to the system; apps do not receive it" };
const TOUCH_LEGEND = "Click or drag on the screen to touch · the Home button belongs to the system";

export const IPHONE: DeviceSpec = {
  id: "iphone",
  name: "iPhone 2G / 4S",
  shell: SHELLS["iphone-4s"]!,
  screen: { width: 320, height: 480 },
  touch: true,
  keys: {},
  system: HOME,
  legend: TOUCH_LEGEND,
};

export const IPOD_TOUCH: DeviceSpec = {
  id: "ipod-touch",
  name: "iPod touch",
  shell: SHELLS["ipod-touch-5"]!,
  screen: { width: 320, height: 568 },
  touch: true,
  keys: {},
  system: HOME,
  legend: TOUCH_LEGEND,
};

/** BlackBerry Classic: square touch screen, a row of keys about the trackpad, and a keyboard of which space and enter are read */
export const BLACKBERRY: DeviceSpec = {
  id: "bb-classic",
  name: "BlackBerry Classic",
  shell: SHELLS["bb-classic"]!,
  screen: { width: 360, height: 360 },
  touch: true,
  keys: { menu: { ui: "TRIANGLE", label: "Menu" }, trackpad: { ui: "CIRCLE" }, space: { ui: "START", label: "Space" }, enter: { ui: "CIRCLE", label: "Enter" } },
  system: { call: "Send belongs to the system", back: "Back belongs to the system", end: "End belongs to the system" },
  legend: "Click the screen to touch · drag the trackpad to move focus, click it to press · ☰ Menu △ · space START · enter ○",
};

/** iPod nano (2nd generation): click wheel and center button */
export const IPOD_NANO: DeviceSpec = {
  id: "ipod-nano",
  name: "iPod nano",
  shell: SHELLS["ipod-nano"]!,
  screen: { width: 176, height: 132 },
  touch: false,
  keys: { select: { ui: "CIRCLE", label: "Center button" }, wheel: {} },
  legend: "Drag around the wheel to scroll · center selects · MENU goes back · ⏮ ⏭ skip · ⏯ plays · arrows and Z work too",
};

const DEVICES: Record<string, DeviceSpec> = {
  psp: PSP,
  gba: GBA,
  "3ds": N3DS,
  iphone: IPHONE,
  "ipod-touch": IPOD_TOUCH,
  "bb-classic": BLACKBERRY,
  "ipod-nano": IPOD_NANO,
};

export function deviceFor(screenId: string | undefined): DeviceSpec | undefined {
  return screenId ? DEVICES[screenId] : undefined;
}

/** Custom size: no matching device, so a plain bezel about the screen; the screen accepts touch */
export function neutralDevice(v: Viewport): DeviceSpec {
  return {
    id: "custom",
    name: `${v.width} × ${v.height}`,
    shell: null,
    screen: v,
    touch: true,
    keys: {},
    legend: "Click or drag on the screen to touch · Arrows move focus · Z or Enter presses · X cancels",
  };
}
