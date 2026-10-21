// programs/web/dev/hud.js — the web host's built-in on-canvas diagnostics overlay.
//
// FPS + live memory are drawn DIRECTLY onto the 480x272 framebuffer canvas
// (not into external page UI), so the readout travels with the screen wherever
// the host is embedded. The values are sampled once per second by the host loop
// and drawn every blit. This is a first-class part of the Web host (both
// programs/web/dev/engine.js and site/playground/host.js draw it, on by default).

/** Total wasm linear memory in bytes — the running app's RAM (core arena +
 *  uploaded textures + heap; grows in 64 KiB pages as the app allocates). */
export function wasmMemoryBytes(wasm) {
  const mem = wasm && wasm.exports && wasm.exports.memory;
  return mem ? mem.buffer.byteLength : 0;
}

function fmtMem(bytes) {
  if (bytes >= 1024 * 1024) return (bytes / (1024 * 1024)).toFixed(1) + " MB";
  return Math.round(bytes / 1024) + " KB";
}

/** Draw one pill (translucent plate + colored label) anchored at a corner. */
function pill(ctx, x, y, text, color, alignRight) {
  const w = Math.ceil(ctx.measureText(text).width);
  const px = alignRight ? x - w - 8 : x;
  ctx.fillStyle = "rgba(8, 11, 20, 0.68)";
  ctx.fillRect(px, y, w + 8, 16);
  ctx.fillStyle = color;
  ctx.fillText(text, px + 4, y + 2);
}

/**
 * Draw the FPS + memory HUD onto the framebuffer canvas. Call from the host's
 * blit, AFTER putImageData (so it sits on top of the rendered frame).
 *   fps      — frames/second (host-sampled once per second)
 *   memBytes — wasmMemoryBytes(wasm) (host-sampled once per second)
 */
export function drawHud(ctx, w, _h, fps, memBytes) {
  ctx.save();
  ctx.font = "700 11px ui-monospace, SFMono-Regular, Menlo, monospace";
  ctx.textBaseline = "top";
  pill(ctx, 3, 3, "FPS " + (fps | 0), "#34d399", false); // top-left
  pill(ctx, w - 3, 3, "MEM " + fmtMem(memBytes), "#60a5fa", true); // top-right
  ctx.restore();
}
