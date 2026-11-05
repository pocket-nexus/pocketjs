// programs/sim/shot.ts — the frozen-frame downscale (docs/LAUNCHER.md, spec op 41).
//
// One transform, shared by the cover cooker (tools/launcher.ts) and the
// sim launcher runner (programs/sim/launcher.ts): bilinear-downscale the FULL
// 480×272 framebuffer into the pow2 256×128 texture. The texture stores
// the frame slightly squeezed (2:1 vs the screen's 1.76:1); every consumer
// draws it at screen aspect (480×272 fullscreen, or a 192×109 card), which
// undoes the squeeze exactly — nothing is cropped, nothing nets a stretch.
// (The first cut center-cropped to 2:1: covers lost their top/bottom 16 px
// and the veil's "dimming screen" visibly deformed — real-hardware find.)
//
// Pure IEEE-double arithmetic, no wall clock: byte-stable across runs and
// machines, so cover-bearing goldens hold. programs/psp/src/switch.rs implements
// the same full-frame filter for the on-device capture; the two need only
// be visually equivalent (their outputs never meet in one golden),
// determinism WITHIN each host is what matters.

export const SHOT_W = 256;
export const SHOT_H = 128;

/** Downscale a 480×272 RGBA framebuffer to the 256×128 shot texture. */
export function downscaleShot(rgba: Uint8Array, srcW = 480, srcH = 272): Uint8Array {
  if (rgba.length < srcW * srcH * 4) {
    throw new Error(`shot: framebuffer too small (${rgba.length} < ${srcW * srcH * 4})`);
  }
  const out = new Uint8Array(SHOT_W * SHOT_H * 4);
  const scaleX = srcW / SHOT_W;
  const scaleY = srcH / SHOT_H;
  for (let dy = 0; dy < SHOT_H; dy++) {
    const sy = (dy + 0.5) * scaleY - 0.5;
    const y0 = Math.min(srcH - 1, Math.max(0, Math.floor(sy)));
    const y1 = Math.min(srcH - 1, y0 + 1);
    const fy = Math.min(1, Math.max(0, sy - y0));
    for (let dx = 0; dx < SHOT_W; dx++) {
      const sx = (dx + 0.5) * scaleX - 0.5;
      const x0 = Math.min(srcW - 1, Math.max(0, Math.floor(sx)));
      const x1 = Math.min(srcW - 1, x0 + 1);
      const fx = Math.min(1, Math.max(0, sx - x0));
      const r00 = (y0 * srcW + x0) * 4;
      const r01 = (y0 * srcW + x1) * 4;
      const r10 = (y1 * srcW + x0) * 4;
      const r11 = (y1 * srcW + x1) * 4;
      const o = (dy * SHOT_W + dx) * 4;
      for (let c = 0; c < 3; c++) {
        const top = rgba[r00 + c] + (rgba[r01 + c] - rgba[r00 + c]) * fx;
        const bot = rgba[r10 + c] + (rgba[r11 + c] - rgba[r10 + c]) * fx;
        out[o + c] = Math.round(top + (bot - top) * fy);
      }
      // Opaque by definition — the native GE leaves framebuffer alpha 0 and
      // switch.rs forces it too; the two paths must agree.
      out[o + 3] = 255;
    }
  }
  return out;
}
