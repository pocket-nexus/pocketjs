// apps/nexus-touch/art/draw-touch.js — the art the touch scene adds to
// apps/nexus/art/draw.js, ported from site/nexus/public/index.html.
//
// Evaluated in headless Chrome by apps/nexus-touch/gen-art.ts after draw.js,
// in the homepage's own document. The O's face and the pocket's eyes come
// apart into layers here because the app moves the pupils every frame; the
// glow, rays and floor are the homepage's drawGlow and drawFloor at rest.
(() => {
"use strict";
const TAU = Math.PI * 2;
const OUT = "#0e091a", LOUT = "#221338";
const INK = "#fcf6ff";
const PAL_DARK = { yellow: "#eaa912", pink: "#dc3479", cyan: "#1a9fc0", lilac: "#7a5ae0", orange: "#e8862a" };

function canvas(w, h) { const c = document.createElement("canvas"); c.width = w; c.height = h; return c; }
function dot(ctx, x, y, r, fill) { ctx.beginPath(); ctx.arc(x, y, Math.max(0, r), 0, TAU); ctx.fillStyle = fill; ctx.fill(); }

// ---- the O ------------------------------------------------------------------------
// The face drawn over the plain O sticker, in the homepage's glyph units
// (100 px font), scaled by fs/100 about the sprite centre. `state`:
//   look  — blush and a closed mouth; the eyes are separate nodes
//   talk  — blush and an open mouth; the eyes are separate nodes
//   happy — arcs for eyes, mouth open
//   wince — the squint (><), mouth open
//   shut  — closed-eye arcs, mouth closed
function oFace(state, fs, size) {
  const c = canvas(size, size), ctx = c.getContext("2d");
  const g = NX.glyph("O", true), s = fs / 100;
  ctx.setTransform(s, 0, 0, s, size / 2, size / 2);
  const rx = g.w / 2, ry = g.ih / 2, ex = rx * 0.36, ey = -ry * 0.2;
  ctx.fillStyle = "rgba(255,95,158,.55)";
  for (const k of [-1, 1]) { ctx.beginPath(); ctx.ellipse(k * rx * 0.62, ry * 0.1, 6.4, 3.6, 0, 0, TAU); ctx.fill(); }
  const mo = state === "talk" || state === "happy" || state === "wince" ? 1 : 0;
  const my = ry * (0.32 - 0.02 * mo), mrx = rx * (0.17 + 0.08 * mo), mry = ry * (0.25 + 0.09 * mo);
  ctx.beginPath(); ctx.ellipse(2.4, my + 3.4, mrx + 0.6, mry + 0.6, 0, 0, TAU); ctx.fillStyle = "rgba(255,255,255,.5)"; ctx.fill();
  ctx.beginPath(); ctx.ellipse(-2, my - 2.8, mrx + 0.4, mry + 0.4, 0, 0, TAU); ctx.fillStyle = PAL_DARK.yellow; ctx.fill();
  ctx.beginPath(); ctx.ellipse(0, my, mrx, mry, 0, 0, TAU); ctx.fillStyle = LOUT; ctx.fill();
  if (mo) {
    ctx.save(); ctx.clip();
    ctx.beginPath(); ctx.ellipse(1, my + mry * 0.78, mrx * 0.82, mry * 0.5, 0, 0, TAU); ctx.fillStyle = "#ff6fa6"; ctx.fill();
    ctx.restore();
  }
  ctx.lineCap = "round"; ctx.lineJoin = "round"; ctx.strokeStyle = LOUT; ctx.lineWidth = 3;
  for (const k of [-1, 1]) {
    const x = k * ex;
    if (state === "happy") {
      ctx.beginPath(); ctx.moveTo(x - 5, ey + 1.5); ctx.quadraticCurveTo(x, ey - 5, x + 5, ey + 1.5); ctx.stroke();
    } else if (state === "wince") {
      const d = -k;
      ctx.beginPath(); ctx.moveTo(x - 4 * d, ey - 4.5); ctx.lineTo(x + 3.5 * d, ey); ctx.lineTo(x - 4 * d, ey + 4.5); ctx.stroke();
    } else if (state === "shut") {
      ctx.beginPath(); ctx.moveTo(x - 5, ey - 0.5); ctx.quadraticCurveTo(x, ey + 4.5, x + 5, ey - 0.5); ctx.stroke();
    }
  }
  return c;
}
/** Where the O's eye centres sit, in px from the sprite centre at `fs`. */
function oEyes(fs) {
  const g = NX.glyph("O", true), s = fs / 100;
  return { ex: (g.w / 2) * 0.36 * s, ey: -(g.ih / 2) * 0.2 * s };
}
/** One open eye with its two catch-lights, centred in a `size` square. */
function oEye(fs, size) {
  const c = canvas(size, size), ctx = c.getContext("2d");
  const s = fs / 100;
  ctx.setTransform(s, 0, 0, s, size / 2, size / 2);
  ctx.beginPath(); ctx.ellipse(0, 0, 4.5, 5.6, 0, 0, TAU); ctx.fillStyle = LOUT; ctx.fill();
  dot(ctx, -1.5, -2.1, 1.7, "#fff");
  ctx.globalAlpha = 0.8; dot(ctx, 1.5, 2, 0.8, "#fff");
  return c;
}

// ---- the pocket's eyes --------------------------------------------------------------
// `part`: whites (both eyeballs), pupils (both pupils, looking ahead), happy.
function pocketEyePart(k, part, w, h) {
  const c = canvas(w, h), ctx = c.getContext("2d");
  ctx.translate(w / 2, h / 2);
  const ex = 2.55 * k, erx = 1.2 * k, ery = 1.5 * k;
  for (const side of [-1, 1]) {
    const x = side * ex;
    if (part === "happy") {
      ctx.beginPath(); ctx.arc(x, ery * 0.45, erx * 0.85, 1.12 * Math.PI, 1.88 * Math.PI);
      ctx.lineCap = "round"; ctx.lineWidth = 0.62 * k; ctx.strokeStyle = OUT; ctx.stroke();
      ctx.lineWidth = 0.34 * k; ctx.strokeStyle = INK; ctx.stroke();
    } else if (part === "whites") {
      ctx.beginPath(); ctx.ellipse(x, 0, erx, ery, 0, 0, TAU);
      ctx.fillStyle = INK; ctx.fill(); ctx.lineWidth = 0.3 * k; ctx.strokeStyle = OUT; ctx.stroke();
    } else {
      dot(ctx, x, 0, 0.62 * k, OUT);
      dot(ctx, x - 0.22 * k, -0.24 * k, 0.2 * k, "#fff");
    }
  }
  return c;
}

// ---- the stage ------------------------------------------------------------------------
// The homepage's drawGlow (without the haze) and drawFloor (without the toy
// shadows) at rest: T = 0, no pop glow, every letter landed.
function glowFloor(ctx, o) {
  const { cx, topY: y, pw, floorY, W, H, wm } = o;
  ctx.save();
  ctx.globalCompositeOperation = "lighter";
  ctx.translate(cx, y);
  ctx.save(); ctx.scale(1, 1.25);
  const g = ctx.createRadialGradient(0, 0, 0, 0, 0, pw * 1.35);
  g.addColorStop(0, "rgba(255,95,158,0.2)"); g.addColorStop(0.45, "rgba(169,139,255,0.07)"); g.addColorStop(1, "rgba(169,139,255,0)");
  ctx.fillStyle = g; ctx.beginPath(); ctx.arc(0, 0, pw * 1.35, 0, TAU); ctx.fill();
  ctx.restore();
  const cols = ["255,210,63", "255,95,158", "63,208,232", "255,95,158", "255,210,63"];
  const len = Math.max(pw * 0.9, y - wm.cy + wm.h * 0.15);
  const spread = Math.min(0.3, Math.max(0.12, Math.atan2(wm.w * 0.36, len) / 2));
  const ra = 0.075 + 0.035;
  for (let i = 0; i < 5; i++) {
    const a = -Math.PI / 2 + (i - 2) * spread;
    const half = 0.05 + (i % 2) * 0.018;
    const rg = ctx.createLinearGradient(0, 0, Math.cos(a) * len, Math.sin(a) * len);
    rg.addColorStop(0, `rgba(${cols[i]},${ra})`); rg.addColorStop(0.7, `rgba(${cols[i]},${ra * 0.35})`); rg.addColorStop(1, `rgba(${cols[i]},0)`);
    ctx.fillStyle = rg; ctx.beginPath();
    ctx.moveTo(Math.cos(a) * pw * 0.12, 0);
    ctx.lineTo(Math.cos(a - half) * len, Math.sin(a - half) * len);
    ctx.lineTo(Math.cos(a + half) * len, Math.sin(a + half) * len);
    ctx.closePath(); ctx.fill();
  }
  const yg = ctx.createRadialGradient(0, 0, 0, 0, 0, pw * 0.55);
  yg.addColorStop(0, "rgba(255,210,63,0.14)"); yg.addColorStop(1, "rgba(255,210,63,0)");
  ctx.fillStyle = yg; ctx.beginPath(); ctx.arc(0, 0, pw * 0.55, 0, TAU); ctx.fill();
  ctx.restore();
  const fg = ctx.createLinearGradient(0, floorY, 0, H);
  fg.addColorStop(0, "rgba(14,9,26,.55)"); fg.addColorStop(1, "rgba(14,9,26,.25)");
  ctx.fillStyle = fg; ctx.fillRect(0, floorY + 2, W, H - floorY);
  ctx.save();
  ctx.setLineDash([8, 8]); ctx.lineCap = "round";
  ctx.beginPath(); ctx.moveTo(0, floorY + 3); ctx.lineTo(W, floorY + 3);
  ctx.lineWidth = 2; ctx.strokeStyle = "rgba(169,139,255,.3)"; ctx.stroke();
  ctx.restore();
  ctx.beginPath(); ctx.ellipse(cx, floorY + 2, pw * 0.3, 5, 0, 0, TAU); ctx.fillStyle = "rgba(6,3,12,.55)"; ctx.fill();
}
/** The warm haze behind the wordmark at full strength, drawn into a
 *  texW x texH canvas that stands for the box (bx, by, bw, bh). */
function haze(o) {
  const c = canvas(o.texW, o.texH), ctx = c.getContext("2d");
  ctx.scale(o.texW / o.bw, o.texH / o.bh);
  ctx.translate(-o.bx, -o.by);
  const wm = o.wm;
  const hz = [["255,210,63", 0.28, 0.46, 0.3], ["255,95,158", 0.52, 0.56, 0.28], ["63,208,232", 0.76, 0.44, 0.26]];
  const rad = Math.max(wm.w * 0.44, wm.h * 0.8);
  for (const [col, px, py, a] of hz) {
    const x = wm.l + wm.w * px, y = wm.t + wm.h * py;
    const g = ctx.createRadialGradient(x, y, 0, x, y, rad);
    g.addColorStop(0, `rgba(${col},${a * 0.6})`); g.addColorStop(1, `rgba(${col},0)`);
    ctx.fillStyle = g; ctx.beginPath(); ctx.arc(x, y, rad, 0, TAU); ctx.fill();
  }
  return c;
}

window.NXT = { oFace, oEyes, oEye, pocketEyePart, glowFloor, haze };
})();
