// Pocket Compact UI: the layout and colour tokens of a 320x170 panel read at
// arm's length. One place holds every size the kit draws with, so an
// application written with the kit keeps the same bars, rows and type.
//
// The panel is the CardputerZero's 1.9" 320x170 at 191 ppi: a 12 px glyph is
// 1.6 mm tall. The status bar and the hint bar are the two strips every
// screen keeps; the body between them is 136 px, and one scene fills it.

/** The panel in logical pixels. */
export const SCREEN = { w: 320, h: 170 } as const;
/** The strip above the body: title left, glance values right. */
export const STATUS_H = 18;
/** The strip below the body: the keys that act here. */
export const HINT_H = 16;
export const BODY_Y = STATUS_H;
export const BODY_H = SCREEN.h - STATUS_H - HINT_H;
/** Side gutter of a scene's content. */
export const GUTTER = 6;
export const CONTENT_W = SCREEN.w - 2 * GUTTER;
/** A list row; a focused row carries the wash and the left bar. */
export const ROW_H = 22;
export const ROW_GAP = 2;
/** The focus bar at a row's left edge. */
export const FOCUS_BAR_W = 2;
export const BUTTON_H = 18;
export const RADIUS = 4;

/** Line heights for the kit's text sizes (px classes of tailwind.ts). */
export const LINE = { tiny: 12, xs: 14, sm: 16, base: 18, lg: 20, xl: 22, xxl: 26, big: 38, huge: 56 } as const;

/** Baked font slots (framework/compiler/tailwind.ts fontSlotFor): regular
 *  slots 0..6 are 12, 14, 16, 18, 20, 24 and 36 px; bold adds 7; 54 px is
 *  14/15; 10 px is 19/20. */
export const SLOT = {
  tiny: 19, tinyBold: 20,
  xs: 0, xsBold: 7,
  sm: 1, smBold: 8,
  base: 2, baseBold: 9,
  lg: 3, lgBold: 10,
  xl: 4, xlBold: 11,
  xxl: 5, xxlBold: 12,
  big: 6, bigBold: 13,
  huge: 14, hugeBold: 15,
} as const;
export type Slot = (typeof SLOT)[keyof typeof SLOT];

/** The dark instrument palette: one background, two panel shades, ink and
 *  dim text, one accent for focus and the value under the hand, cyan for a
 *  good state, pink for a warning. State is named in text as well; colour
 *  alone never carries it. */
export const COLOR = {
  bg: "#171226",
  bar: "#1c1630",
  panel: "#231b3b",
  raised: "#2b2148",
  line: "#3a2d5c",
  grid: "#2f2550",
  ink: "#fcf6ff",
  text: "#cbbde2",
  dim: "#8e80ac",
  accent: "#ffd23f",
  accentInk: "#171226",
  ok: "#3fd0e8",
  warn: "#ff7fb4",
  rec: "#ff4d6d",
  veil: "#000000a0",
} as const;

export type Tone = "ink" | "text" | "dim" | "accent" | "ok" | "warn";

export const TONE_COLOR: Record<Tone, string> = {
  ink: COLOR.ink,
  text: COLOR.text,
  dim: COLOR.dim,
  accent: COLOR.accent,
  ok: COLOR.ok,
  warn: COLOR.warn,
};

/** Held direction keys repeat after half a second, then fifteen times a
 *  second (the CardputerZero launcher's cadence). */
export const REPEAT_DELAY_S = 0.5;
export const REPEAT_RATE_HZ = 15;
/** Escape held this long goes home. */
export const HOME_HOLD_S = 1.0;
/** A toast stays this long. */
export const TOAST_S = 1.6;
