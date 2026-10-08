// Device shapes for the playground: body, screen position and controls. Coordinates are in design units; DeviceFrame scales them uniformly to fit.
// Control mappings follow the pocketjs device hosts:
//   GBA      hosts/gba/src/main.rs           A → CIRCLE, B → CROSS
//   3DS      hosts/3ds/src/input.c           A → CIRCLE, B → CROSS, X → TRIANGLE, Y → SQUARE
//   iPod nano apps/ipod-nano/app.tsx         wheel UP/DOWN, center CIRCLE, MENU TRIANGLE, ⏮⏭ LEFT/RIGHT, ⏯ START
//   BlackBerry docs/BLACKBERRY_CLASSIC.md    trackpad move → direction pulses, press → CIRCLE, Menu → TRIANGLE, Space → START
//   iPhone / iPod touch / Meizu M8           touch screen only; Home belongs to the system
// ui: PSP button names a UI app receives (contracts/spec/spec.ts BTN); retro: Pocket Retro GBA button names.
import type { Viewport } from "./screens";

export type UiButton = "UP" | "DOWN" | "LEFT" | "RIGHT" | "CIRCLE" | "CROSS" | "SQUARE" | "TRIANGLE" | "START" | "SELECT" | "L" | "R";
export type RetroButton = "UP" | "DOWN" | "LEFT" | "RIGHT" | "A" | "B" | "START" | "SELECT" | "L" | "R";

export interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

export type Control =
  /** D-pad; (x, y) is the center */
  | { kind: "dpad"; x: number; y: number; size: number }
  /** Button; round: (x, y) is the center and w the diameter; other shapes: (x, y) is the top-left corner */
  | {
      kind: "button";
      x: number;
      y: number;
      w: number;
      h?: number;
      shape: "round" | "pill" | "shoulder";
      label: string;
      /** Glyph color on the keycap (PSP △○×□) */
      tint?: string;
      /** Label printed next to the keycap */
      caption?: { text: string; dx: number; dy: number };
      ui?: UiButton;
      retro?: RetroButton;
    }
  /** iPod click wheel; (x, y) is the center */
  | { kind: "wheel"; x: number; y: number; d: number }
  /** BlackBerry trackpad */
  | ({ kind: "trackpad" } & Box)
  /** BlackBerry QWERTY keyboard; only space and enter map to button codes */
  | ({ kind: "keyboard"; rows: string[][] } & Box)
  /** Parts that produce no input: earpiece, LED, Home key, speaker grill, analog nub */
  | ({ kind: "deco"; shape: "slot" | "led" | "home" | "grill" | "nub" | "screen-off" | "phone"; color?: string; title?: string; text?: string } & Box);

export interface BodyPart extends Box {
  radius: number | string;
  background: string;
  /** Color of the body's bottom lip (hard drop shadow) */
  lip: string;
}

export interface DeviceSpec {
  id: string;
  name: string;
  /** Bounding box size */
  w: number;
  h: number;
  bodies: BodyPart[];
  /** Screen glass (the dark border around the screen) */
  bezel?: Box & { radius: number };
  screen: Box & { radius: number };
  touch: boolean;
  controls: Control[];
  /** Keyboard mapping legend, shown below the device */
  keys: string;
}

const KEY = "#2b2148";

const SHOULDERS = (lx: number, rx: number, y: number, w: number): Control[] => [
  { kind: "button", shape: "shoulder", x: lx, y, w, h: 26, label: "L", ui: "L", retro: "L" },
  { kind: "button", shape: "shoulder", x: rx, y, w, h: 26, label: "R", ui: "R", retro: "R" },
];

/** Game Boy Advance: landscape; D-pad left of the screen, A/B on the right, L/R on the shoulders */
export const GBA: DeviceSpec = {
  id: "gba",
  name: "Game Boy Advance",
  w: 580,
  h: 350,
  bodies: [
    {
      x: 0,
      y: 20,
      w: 580,
      h: 330,
      radius: "70px 70px 150px 150px / 70px 70px 120px 120px",
      background: "linear-gradient(180deg, #8f72f2 0%, #7457dc 55%, #6247c4 100%)",
      lip: "#4a33a3",
    },
  ],
  bezel: { x: 140, y: 46, w: 300, h: 216, radius: 20 },
  screen: { x: 170, y: 74, w: 240, h: 160, radius: 3 },
  touch: false,
  controls: [
    ...SHOULDERS(34, 416, 8, 130),
    { kind: "dpad", x: 80, y: 168, size: 96 },
    { kind: "button", shape: "round", x: 528, y: 148, w: 54, label: "A", ui: "CIRCLE", retro: "A" },
    { kind: "button", shape: "round", x: 472, y: 188, w: 54, label: "B", ui: "CROSS", retro: "B" },
    { kind: "button", shape: "pill", x: 56, y: 266, w: 46, h: 15, label: "", caption: { text: "SELECT", dx: 54, dy: 1 }, ui: "SELECT", retro: "SELECT" },
    { kind: "button", shape: "pill", x: 56, y: 298, w: 46, h: 15, label: "", caption: { text: "START", dx: 54, dy: 1 }, ui: "START", retro: "START" },
    { kind: "deco", shape: "led", x: 152, y: 150, w: 8, h: 8, color: "#3fd0e8", title: "Power" },
    { kind: "deco", shape: "grill", x: 470, y: 262, w: 66, h: 52, title: "Speaker" },
  ],
  keys: "Arrows ✚ · Z A · X B · Q / E L R · Space START · Shift SELECT",
};

/** Pocket Retro games run on the GBA: same shape, buttons map straight to GBA buttons */
export const GBA_RETRO: DeviceSpec = {
  ...GBA,
  id: "gba-retro",
  keys: "Arrows ✚ · Z A · X B · Q / E L R · Enter START · Shift SELECT",
};

/** PSP-1000: landscape; D-pad and analog nub on the left, △○×□ on the right, SELECT / START below the screen on the right */
export const PSP: DeviceSpec = {
  id: "psp",
  name: "PSP",
  w: 700,
  h: 312,
  bodies: [{ x: 0, y: 14, w: 700, h: 298, radius: 149, background: "linear-gradient(180deg, #34295c 0%, #241c42 60%, #1c1633 100%)", lip: "#0e091a" }],
  bezel: { x: 146, y: 34, w: 408, h: 240, radius: 12 },
  screen: { x: 158, y: 45, w: 384, h: 217.6, radius: 2 },
  touch: false,
  controls: [
    ...SHOULDERS(40, 510, 2, 150),
    { kind: "dpad", x: 84, y: 120, size: 94 },
    { kind: "deco", shape: "nub", x: 54, y: 196, w: 46, h: 46, title: "Analog nub" },
    { kind: "button", shape: "round", x: 618, y: 82, w: 40, label: "△", tint: "#4fd1a5", ui: "TRIANGLE" },
    { kind: "button", shape: "round", x: 660, y: 124, w: 40, label: "○", tint: "#ff6b81", ui: "CIRCLE" },
    { kind: "button", shape: "round", x: 618, y: 166, w: 40, label: "×", tint: "#7aa7ff", ui: "CROSS" },
    { kind: "button", shape: "round", x: 576, y: 124, w: 40, label: "□", tint: "#ff8fd0", ui: "SQUARE" },
    { kind: "button", shape: "pill", x: 488, y: 284, w: 38, h: 12, label: "", caption: { text: "SELECT", dx: -4, dy: -11 }, ui: "SELECT" },
    { kind: "button", shape: "pill", x: 538, y: 284, w: 38, h: 12, label: "", caption: { text: "START", dx: 2, dy: -11 }, ui: "START" },
    { kind: "deco", shape: "home", x: 152, y: 284, w: 44, h: 12, title: "HOME belongs to the system", text: "HOME" },
  ],
  keys: "Arrows ✚ · Z ○ · X × · A □ · S △ · Q / E L R · Space START · Shift SELECT",
};

/** 3DS: clamshell; the top screen is the app's primary screen, the lower half holds the touch screen and buttons */
export const N3DS: DeviceSpec = {
  id: "3ds",
  name: "3DS",
  w: 560,
  h: 680,
  bodies: [
    { x: 0, y: 0, w: 560, h: 320, radius: 26, background: "linear-gradient(180deg, #2fb4cc 0%, #1b93a8 100%)", lip: "#11697b" },
    { x: 0, y: 356, w: 560, h: 324, radius: 26, background: "linear-gradient(180deg, #2fb4cc 0%, #1b93a8 100%)", lip: "#11697b" },
  ],
  bezel: { x: 66, y: 28, w: 428, h: 266, radius: 12 },
  screen: { x: 80, y: 40, w: 400, h: 240, radius: 2 },
  touch: false,
  controls: [
    { kind: "deco", shape: "slot", x: 112, y: 322, w: 336, h: 30, color: "#147c90", title: "Hinge" },
    { kind: "deco", shape: "led", x: 276, y: 14, w: 8, h: 8, color: "#0e091a", title: "Camera" },
    { kind: "button", shape: "shoulder", x: 14, y: 340, w: 90, h: 26, label: "L", ui: "L" },
    { kind: "button", shape: "shoulder", x: 456, y: 340, w: 90, h: 26, label: "R", ui: "R" },
    {
      kind: "deco",
      shape: "screen-off",
      x: 120,
      y: 378,
      w: 320,
      h: 240,
      title: "The bottom touch screen is an auxiliary surface; this preview shows the primary one",
      text: "touch screen",
    },
    { kind: "deco", shape: "nub", x: 30, y: 384, w: 64, h: 64, title: "Circle pad" },
    { kind: "dpad", x: 62, y: 528, size: 80 },
    { kind: "button", shape: "round", x: 498, y: 420, w: 36, label: "X", ui: "TRIANGLE" },
    { kind: "button", shape: "round", x: 536, y: 458, w: 36, label: "A", ui: "CIRCLE" },
    { kind: "button", shape: "round", x: 498, y: 496, w: 36, label: "B", ui: "CROSS" },
    { kind: "button", shape: "round", x: 460, y: 458, w: 36, label: "Y", ui: "SQUARE" },
    { kind: "button", shape: "pill", x: 176, y: 640, w: 44, h: 14, label: "", caption: { text: "SELECT", dx: -3, dy: 17 }, ui: "SELECT" },
    { kind: "deco", shape: "home", x: 258, y: 640, w: 44, h: 14, title: "HOME belongs to the system", text: "HOME" },
    { kind: "button", shape: "pill", x: 340, y: 640, w: 44, h: 14, label: "", caption: { text: "START", dx: 3, dy: 17 }, ui: "START" },
  ],
  keys: "Arrows ✚ · Z A · X B · S X · A Y · Q / E L R · Space START · Shift SELECT",
};

const PHONE_BODY = (w: number, h: number, radius: number): BodyPart => ({
  x: 0,
  y: 0,
  w,
  h,
  radius,
  background: "linear-gradient(180deg, #2a2440 0%, #15111f 100%)",
  lip: "#0a0614",
});

const TOUCH_KEYS = "Click or drag on the screen to touch · the Home key belongs to the system";

/** iPhone 2G / 4S: 320 × 480 touch screen, Home key only */
export const IPHONE: DeviceSpec = {
  id: "iphone",
  name: "iPhone 2G / 4S",
  w: 300,
  h: 560,
  bodies: [{ ...PHONE_BODY(300, 560, 46), background: "linear-gradient(180deg, #2a2440 0%, #15111f 100%)" }],
  screen: { x: 30, y: 84, w: 240, h: 360, radius: 3 },
  touch: true,
  controls: [
    { kind: "deco", shape: "slot", x: 124, y: 40, w: 52, h: 7, title: "Earpiece" },
    { kind: "deco", shape: "home", x: 124, y: 474, w: 52, h: 52, title: "Home belongs to the system; apps do not receive it" },
  ],
  keys: TOUCH_KEYS,
};

/** iPod touch: 320 × 568 touch screen, Home key only */
export const IPOD_TOUCH: DeviceSpec = {
  id: "ipod-touch",
  name: "iPod touch",
  w: 280,
  h: 590,
  bodies: [PHONE_BODY(280, 590, 42)],
  screen: { x: 25, y: 74, w: 230, h: 408.25, radius: 3 },
  touch: true,
  controls: [
    { kind: "deco", shape: "led", x: 136, y: 34, w: 8, h: 8, color: "#0a0614", title: "Camera" },
    { kind: "deco", shape: "slot", x: 116, y: 52, w: 48, h: 6, title: "Earpiece" },
    { kind: "deco", shape: "home", x: 116, y: 510, w: 48, h: 48, title: "Home belongs to the system; apps do not receive it" },
  ],
  keys: TOUCH_KEYS,
};

/** Meizu M8: 480 × 720 touch screen, a single Home key */
export const MEIZU_M8: DeviceSpec = {
  id: "meizu-m8",
  name: "Meizu M8",
  w: 310,
  h: 560,
  bodies: [PHONE_BODY(310, 560, 34)],
  screen: { x: 35, y: 66, w: 240, h: 360, radius: 2 },
  touch: true,
  controls: [
    { kind: "deco", shape: "slot", x: 130, y: 32, w: 50, h: 6, title: "Earpiece" },
    { kind: "deco", shape: "home", x: 129, y: 466, w: 52, h: 52, title: "Home closes the app and belongs to the system" },
  ],
  keys: TOUCH_KEYS,
};

/** BlackBerry Classic: square touch screen + navigation keys + trackpad + QWERTY keyboard */
export const BLACKBERRY: DeviceSpec = {
  id: "bb-classic",
  name: "BlackBerry Classic",
  w: 300,
  h: 610,
  bodies: [{ ...PHONE_BODY(300, 610, 38), background: "linear-gradient(180deg, #24203a 0%, #121019 100%)" }],
  screen: { x: 30, y: 44, w: 240, h: 240, radius: 2 },
  touch: true,
  controls: [
    { kind: "deco", shape: "slot", x: 124, y: 20, w: 52, h: 6, title: "Earpiece" },
    { kind: "deco", shape: "phone", x: 20, y: 302, w: 46, h: 40, color: "#34d399", title: "Send belongs to the system" },
    { kind: "button", shape: "pill", x: 74, y: 302, w: 46, h: 40, label: "☰", ui: "TRIANGLE" },
    { kind: "trackpad", x: 128, y: 300, w: 44, h: 44 },
    { kind: "deco", shape: "phone", x: 180, y: 302, w: 46, h: 40, text: "↩", title: "Back belongs to the system" },
    { kind: "deco", shape: "phone", x: 234, y: 302, w: 46, h: 40, color: "#f87171", title: "End belongs to the system" },
    {
      kind: "keyboard",
      x: 16,
      y: 360,
      w: 268,
      h: 226,
      rows: [
        ["Q", "W", "E", "R", "T", "Y", "U", "I", "O", "P"],
        ["A", "S", "D", "F", "G", "H", "J", "K", "L", "⌫"],
        ["⇧", "Z", "X", "C", "V", "B", "N", "M", "$", "↵"],
        ["alt", "0", "space", "sym", "⇧"],
      ],
    },
  ],
  keys: "Click the screen to touch · drag the trackpad to move focus, click it to press · ☰ Menu △ · space START",
};

/** iPod nano (2nd generation): 176 × 132, click wheel */
export const IPOD_NANO: DeviceSpec = {
  id: "ipod-nano",
  name: "iPod nano",
  w: 200,
  h: 440,
  bodies: [{ x: 0, y: 0, w: 200, h: 440, radius: 28, background: "linear-gradient(180deg, #ff7fb4 0%, #ff5f9e 55%, #e04a88 100%)", lip: "#c23a73" }],
  bezel: { x: 16, y: 22, w: 168, h: 132, radius: 8 },
  screen: { x: 24, y: 30, w: 152, h: 114, radius: 2 },
  touch: false,
  controls: [{ kind: "wheel", x: 100, y: 298, d: 168 }],
  keys: "Drag around the wheel to scroll · center selects · MENU goes back · ⏮ ⏭ skip · ⏯ plays · arrows and Z work too",
};

const DEVICES: Record<string, DeviceSpec> = {
  psp: PSP,
  gba: GBA,
  "3ds": N3DS,
  iphone: IPHONE,
  "ipod-touch": IPOD_TOUCH,
  "bb-classic": BLACKBERRY,
  "ipod-nano": IPOD_NANO,
  "meizu-m8": MEIZU_M8,
};

export function deviceFor(screenId: string | undefined): DeviceSpec | undefined {
  return screenId ? DEVICES[screenId] : undefined;
}

/** Custom size: no matching device, so draw only a border around the screen; the screen accepts touch */
export function neutralDevice(v: Viewport): DeviceSpec {
  const k = 360 / Math.max(v.width, v.height);
  const sw = Math.round(v.width * k);
  const sh = Math.round(v.height * k);
  const m = 22;
  return {
    id: "custom",
    name: `${v.width} × ${v.height}`,
    w: sw + m * 2,
    h: sh + m * 2,
    bodies: [{ x: 0, y: 0, w: sw + m * 2, h: sh + m * 2, radius: 24, background: "linear-gradient(180deg, #2b2148 0%, #1c1630 100%)", lip: "#0a0614" }],
    screen: { x: m, y: m, w: sw, h: sh, radius: 3 },
    touch: true,
    controls: [],
    keys: "Click or drag on the screen to touch · Arrows move focus · Z or Enter presses · X cancels",
  };
}
