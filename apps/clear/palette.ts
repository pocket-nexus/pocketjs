// Row colors, matching the reference demo's HSL ramps exactly.
//
// Todo rows sweep hue 354 → +7/row (red toward orange) with lightness 46 → +2,
// saturation 100 on row 0 and 90 below; when the stack exceeds 7 rows the
// steps compress so the full sweep always spans the stack. List rows sweep
// hue 212 → -2.5/row (blue, brightening), compressing past 5 rows. Every row
// paints a vertical gradient one lightness step either side of its ramp color
// so the fill reads slightly lit from above.

const TODO_H = 354;
const TODO_S = 100;
const TODO_L = 46;
const TODO_STEP_H = 7;
const TODO_STEP_L = 2;
const TODO_SPAN = 7;

const LIST_H = 212;
const LIST_S = 93;
const LIST_L = 53;
const LIST_STEP_H = -2.5;
const LIST_STEP_S = 1;
const LIST_STEP_L = 2.5;
const LIST_SPAN = 5;

/** Inner-gradient half-spread, in lightness points. */
const GRAD_L = 2;

export const DONE_FROM = "#0c0c0c";
export const DONE_TO = "#000000";
export const DONE_TEXT = "#666666";
/** Swipe-right armed slider fill (#0A3 in the reference). */
export const GREEN_FROM = "#00b236";
export const GREEN_TO = "#009e30";
// The flap/preview/cross red literals in app.tsx class strings are
// todoRowColors(0, 1): #f50018 / #e00016 around the row-0 base #eb0017.

function hex2(value: number): string {
  const v = Math.max(0, Math.min(255, Math.round(value)));
  return (v < 16 ? "0" : "") + v.toString(16);
}

/** hsl (deg, %, %) → '#rrggbb'. */
export function hsl(h: number, s: number, l: number): string {
  const hue = ((h % 360) + 360) % 360;
  const sat = Math.max(0, Math.min(100, s)) / 100;
  const lig = Math.max(0, Math.min(100, l)) / 100;
  const c = (1 - Math.abs(2 * lig - 1)) * sat;
  const x = c * (1 - Math.abs(((hue / 60) % 2) - 1));
  const m = lig - c / 2;
  let r = 0;
  let g = 0;
  let b = 0;
  if (hue < 60) [r, g, b] = [c, x, 0];
  else if (hue < 120) [r, g, b] = [x, c, 0];
  else if (hue < 180) [r, g, b] = [0, c, x];
  else if (hue < 240) [r, g, b] = [0, x, c];
  else if (hue < 300) [r, g, b] = [x, 0, c];
  else [r, g, b] = [c, 0, x];
  return `#${hex2((r + m) * 255)}${hex2((g + m) * 255)}${hex2((b + m) * 255)}`;
}

/** Gradient endpoints for the PENDING todo row at `order` in a stack of
 *  `pendingRows`. */
export function todoRowColors(order: number, pendingRows: number): readonly [string, string] {
  let stepH = TODO_STEP_H;
  let stepL = TODO_STEP_L;
  if (pendingRows > TODO_SPAN) {
    stepH = (TODO_STEP_H * TODO_SPAN) / pendingRows;
    stepL = (TODO_STEP_L * TODO_SPAN) / pendingRows;
  }
  const h = TODO_H + order * stepH;
  const s = order ? TODO_S - 10 : TODO_S;
  const l = TODO_L + order * stepL;
  return [hsl(h, s, l + GRAD_L), hsl(h, s, l - GRAD_L)];
}

/** Gradient endpoints for the list row at `order` among `rows` lists. */
export function listRowColors(order: number, rows: number): readonly [string, string] {
  let stepH = LIST_STEP_H;
  let stepS = LIST_STEP_S;
  let stepL = LIST_STEP_L;
  if (rows > LIST_SPAN) {
    stepH = (LIST_STEP_H * LIST_SPAN) / rows;
    stepS = (LIST_STEP_S * LIST_SPAN) / rows;
    stepL = (LIST_STEP_L * LIST_SPAN) / rows;
  }
  const h = LIST_H + order * stepH;
  const s = Math.min(100, LIST_S + order * stepS);
  const l = Math.min(100, LIST_L + order * stepL);
  return [hsl(h, s, l + GRAD_L), hsl(h, s, l - GRAD_L)];
}

