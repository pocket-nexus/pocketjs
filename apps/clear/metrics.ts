// Pocket Clear geometry, JSX-free so bun tests can import it directly.
// Distances follow the reference demo: 62px rows on a 320-wide screen, pull
// thresholds at one and two row heights of DISPLAYED overscroll, swipes
// committing at one row height of travel.

import { detectHost, hostViewport } from "@pocketjs/framework/host";
const viewport = (() => { try { return hostViewport(detectHost().ops); } catch { return null; } })();
export const SCREEN_W = viewport?.w ?? 320;
export const SCREEN_H = viewport?.h ?? 480;

/** Row height, todo and list rows alike. */
export const ROW_H = 62;

/** Displayed overscroll that commits create / go-back / clear-done. The
 *  scroller's rubber curve (asymptote = the 480px extent) maps these to
 *  ~130px and ~305px of finger travel — the same feel as the reference
 *  demo's linear 0.45 elasticity (138px / 276px). */
export const PULL_CREATE = ROW_H;
export const PULL_BACK = ROW_H * 2;
export const PULL_CLEAR = ROW_H * 2;
/** Rubber cap; must clear PULL_BACK with margin. */
export const OVERSCROLL = 160;

/** Horizontal travel that commits a complete (right) or delete (left). */
export const SWIPE_COMMIT = ROW_H;

/** Pinch gap that commits an insert. */
export const PINCH_COMMIT = 30;

/** Screen-switch transition length (ms). */
export const SWITCH_MS = 300;

/** Baked font-atlas slot for `text-xl font-bold` (20px bold) — the row title
 *  face; used with measureText to size the strike-through line. Pinned by
 *  framework/compiler/tailwind.ts FONT_PX (bold slots are 7 + size index,
 *  and 20px is index 4). */
export const TITLE_FONT_SLOT = 11;
