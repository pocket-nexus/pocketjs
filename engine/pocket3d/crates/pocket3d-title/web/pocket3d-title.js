// The Pocket3D title card for a game's browser reference.
//
//   import { playTitle } from ".../pocket3d-title/web/pocket3d-title.js";
//   const title = playTitle();   // starts at once, over the page
//   await loadTheGame();
//   await title;                 // the card has ended and removed itself
//
// It shows the same art for the same 144 ticks at 60 Hz as the consoles do:
// the frame is the art on the plum ground, multiplied by the light of
// `level(tick)`. The art is art.js, baked by tools/pocket3d-title.ts.

import { FULL } from "./art.js";

export const TICKS = 144;
export const FADE_IN = 20;
export const FADE_OUT = 28;

/** The card's light at a tick, from 0 (black) to 256 (full). */
export function level(tick) {
  const smooth = (n, d) => { const t = Math.floor((n * 256) / d); return (t * t * (768 - 2 * t)) >> 16; };
  if (tick >= TICKS) return 0;
  if (tick < FADE_IN) return smooth(tick + 1, FADE_IN);
  if (tick >= TICKS - FADE_OUT) return smooth(TICKS - 1 - tick, FADE_OUT);
  return 256;
}

/** Decode the baked art to RGBA: `{ width, height, rgba, ground }`. */
export function art(base64 = FULL) {
  const bytes = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
  const view = new DataView(bytes.buffer);
  const width = view.getUint16(4, true), height = view.getUint16(6, true), colours = view.getUint16(8, true);
  const rowsAt = 12 + colours * 3, dataAt = rowsAt + height * 4;
  const rgba = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y++) {
    let at = dataAt + view.getUint32(rowsAt + y * 4, true);
    for (let x = 0; x < width; at += 2) {
      for (let run = bytes[at] + 1; run > 0; run--, x++) {
        const to = (y * width + x) * 4, from = 12 + bytes[at + 1] * 3;
        rgba[to] = bytes[from]; rgba[to + 1] = bytes[from + 1]; rgba[to + 2] = bytes[from + 2]; rgba[to + 3] = 255;
      }
    }
  }
  return { width, height, rgba, ground: [bytes[12], bytes[13], bytes[14]] };
}

/**
 * Play the card over `parent` and resolve when it has ended. The card covers
 * the viewport, ignores input and removes itself.
 */
export function playTitle({ parent = document.body } = {}) {
  const picture = art();
  const cover = document.createElement("div");
  cover.setAttribute("role", "img");
  cover.setAttribute("aria-label", "Pocket3D");
  cover.style.cssText = "position:fixed;inset:0;z-index:2147483647;background:#000;pointer-events:none";
  const lit = document.createElement("div");
  lit.style.cssText = `position:absolute;inset:0;display:grid;place-items:center;opacity:0;background:rgb(${picture.ground.join(",")})`;
  const canvas = document.createElement("canvas");
  canvas.width = picture.width;
  canvas.height = picture.height;
  // 624 of 960 pixels on the PS Vita: the art takes 65% of the width
  canvas.style.cssText = "width:min(65vw,624px);height:auto";
  canvas.getContext("2d").putImageData(new ImageData(picture.rgba, picture.width, picture.height), 0, 0);
  lit.append(canvas);
  cover.append(lit);
  parent.append(cover);
  return new Promise((resolve) => {
    const start = performance.now();
    const frame = (now) => {
      const tick = Math.floor(((now - start) * 60) / 1000);
      if (tick >= TICKS) { cover.remove(); resolve(); return; }
      lit.style.opacity = String(level(tick) / 256);
      requestAnimationFrame(frame);
    };
    requestAnimationFrame(frame);
  });
}
