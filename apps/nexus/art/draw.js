// apps/nexus/art/draw.js — the homepage's canvas art, at 3DS scale.
//
// Evaluated in headless Chrome by apps/nexus/gen-art.ts. The sticker, toy,
// pocket and particle drawing is ported from site/nexus/public/index.html so
// the 3DS scene wears the same art; every function returns a canvas of the
// exact power-of-two size the app lays out. Animation lives in the engine,
// so each moving part is drawn once at rest.
(() => {
"use strict";
const TAU = Math.PI * 2;
const OUT = "#0e091a", LOUT = "#221338", DROP = "#0a0614";
const C = { y: "#ffd23f", p: "#ff5f9e", c: "#3fd0e8", l: "#a98bff", o: "#ffb45c", ink: "#fcf6ff", ink2: "#cbbde2" };
const PAL = {
  yellow: ["#fff1a6", "#ffd23f", "#eaa912"],
  pink: ["#ffb0cf", "#ff5f9e", "#dc3479"],
  cyan: ["#b4f3fb", "#3fd0e8", "#1a9fc0"],
  lilac: ["#ddd0ff", "#a98bff", "#7a5ae0"],
  orange: ["#ffdcae", "#ffb45c", "#e8862a"],
};
const FONT = '100px "Titan One"';

function canvas(w, h) { const c = document.createElement("canvas"); c.width = w; c.height = h; return c; }
let ctx = null;

// ---- helpers (homepage) ------------------------------------------------------
function rr(x, y, w, h, r) {
  ctx.moveTo(x + r, y); ctx.arcTo(x + w, y, x + w, y + h, r); ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r); ctx.arcTo(x, y, x + w, y, r); ctx.closePath();
}
function poly(pts) { ctx.beginPath(); ctx.moveTo(pts[0], pts[1]); for (let i = 2; i < pts.length; i += 2) ctx.lineTo(pts[i], pts[i + 1]); ctx.closePath(); }
function sticker(path, base, shade, o, rule) {
  rule = rule || "nonzero";
  path(); ctx.fillStyle = shade; ctx.fill(rule);
  ctx.save(); path(); ctx.clip(rule);
  ctx.translate(o.lx, o.ly); path(); ctx.fillStyle = base; ctx.fill(rule);
  ctx.restore();
}
function outline(path, lw) { path(); ctx.lineWidth = lw; ctx.strokeStyle = OUT; ctx.stroke(); }
function gloss(x, y, rx, ry, rot, a) { ctx.beginPath(); ctx.ellipse(x, y, rx, ry, rot, 0, TAU); ctx.fillStyle = "rgba(255,255,255," + (a || 0.78) + ")"; ctx.fill(); }
function dot(x, y, r, fill, lw, stroke) {
  ctx.beginPath(); ctx.arc(x, y, Math.max(0, r), 0, TAU); ctx.fillStyle = fill; ctx.fill();
  if (lw) { ctx.lineWidth = lw; ctx.strokeStyle = stroke || OUT; ctx.stroke(); }
}
function spark4(x, y, s) {
  ctx.moveTo(x, y - s);
  ctx.quadraticCurveTo(x + s * 0.14, y - s * 0.14, x + s, y);
  ctx.quadraticCurveTo(x + s * 0.14, y + s * 0.14, x, y + s);
  ctx.quadraticCurveTo(x - s * 0.14, y + s * 0.14, x - s, y);
  ctx.quadraticCurveTo(x - s * 0.14, y - s * 0.14, x, y - s);
  ctx.closePath();
}
function pixels(grid, pal, cell, lw) {
  const rows = grid.length, cols = grid[0].length, ox = -cols * cell / 2, oy = -rows * cell / 2;
  ctx.beginPath();
  for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) if (grid[r][c] !== ".") ctx.rect(ox + c * cell - lw, oy + r * cell - lw, cell + 2 * lw, cell + 2 * lw);
  ctx.fillStyle = OUT; ctx.fill();
  for (const key in pal) {
    ctx.beginPath(); let hit = false;
    for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) if (grid[r][c] === key) { ctx.rect(ox + c * cell, oy + r * cell, cell + 0.004, cell + 0.004); hit = true; }
    if (hit) { ctx.fillStyle = pal[key]; ctx.fill(); }
  }
}
function eyes(o, sp, y, rx, ry, look) {
  const bl = o.blink;
  for (const s of [-1, 1]) {
    ctx.beginPath(); ctx.ellipse(s * sp + o.lookX * look, y + o.lookY * look, rx, Math.max(0.01, ry * (1 - bl * 0.88)), 0, 0, TAU);
    ctx.fillStyle = OUT; ctx.fill();
    if (bl < 0.4) dot(s * sp + o.lookX * look - rx * 0.3, y + o.lookY * look - ry * 0.38, rx * 0.36, "#fff");
  }
}

// ---- toys (unit radius) --------------------------------------------------------
const starPath = () => {
  ctx.beginPath();
  for (let i = 0; i < 10; i++) {
    const a = -Math.PI / 2 + i * Math.PI / 5, r = i % 2 ? 0.5 : 1.03;
    const x = Math.cos(a) * r, y = Math.sin(a) * r + 0.05;
    i ? ctx.lineTo(x, y) : ctx.moveTo(x, y);
  }
  ctx.closePath();
};
function dStar(o) {
  sticker(starPath, C.y, "#e59a0e", o); gloss(-0.13, -0.5, 0.06, 0.16, 0.45); outline(starPath, o.lw);
  eyes(o, 0.19, 0.06, 0.068, 0.095, 0.035);
  ctx.fillStyle = "rgba(255,95,158,.8)";
  for (const s of [-1, 1]) { ctx.beginPath(); ctx.ellipse(s * 0.35, 0.2, 0.085, 0.05, 0, 0, TAU); ctx.fill(); }
  ctx.lineWidth = 0.05; ctx.strokeStyle = OUT; ctx.beginPath(); ctx.arc(0, 0.15, 0.075, 0.18 * Math.PI, 0.82 * Math.PI); ctx.stroke();
}
const sparkPath = () => { ctx.beginPath(); spark4(-0.08, 0.06, 0.94); };
function dSpark(o) {
  sticker(sparkPath, C.p, "#d8397a", o); gloss(-0.17, -0.28, 0.045, 0.15, 0.25); outline(sparkPath, o.lw);
  dot(0.62, -0.62, 0.17, C.c, o.lw * 0.8); gloss(0.575, -0.665, 0.045, 0.045, 0, 0.9);
}
const HEART = [".XX.XX.", "XWXXXXX", "XXXXXXD", ".XXXXD.", "..XXD..", "...D..."];
function dHeart(o) { pixels(HEART, { X: C.p, D: "#d23a78", W: "#ffd0e2" }, 0.28, o.lw * 0.9); }
const GHOST = ["..XXXX..", ".XLXXXX.", "XLXXXXXX", "XWWXXWWX", "XWPXXWPX", "XXXXXXXD", "XXXXXXXD", "DD.DD.DD"];
function dGhost(o) { pixels(GHOST, { X: C.l, L: "#cdb8ff", D: "#7a5de0", W: C.ink, P: OUT }, 0.235, o.lw * 0.9); }
const cursorPath = () => poly([-0.46, -0.98, -0.46, 0.56, -0.1, 0.24, 0.14, 0.8, 0.38, 0.7, 0.14, 0.15, 0.6, 0.15]);
function dCursor(o) {
  sticker(cursorPath, C.ink, "#c3b2e6", o);
  ctx.beginPath(); ctx.moveTo(-0.3, -0.58); ctx.lineTo(-0.3, -0.14); ctx.lineWidth = 0.08; ctx.strokeStyle = "rgba(255,255,255,.95)"; ctx.stroke();
  outline(cursorPath, o.lw);
}
const gearPath = () => {
  ctx.beginPath();
  const N = 8, st = TAU / N, ro = 1, rr0 = 0.74;
  for (let i = 0; i < N; i++) {
    const a = i * st;
    ctx.arc(0, 0, rr0, a, a + st * 0.44);
    ctx.lineTo(Math.cos(a + st * 0.54) * ro, Math.sin(a + st * 0.54) * ro);
    ctx.lineTo(Math.cos(a + st * 0.9) * ro, Math.sin(a + st * 0.9) * ro);
  }
  ctx.closePath();
  ctx.moveTo(0.28, 0); ctx.arc(0, 0, 0.28, 0, TAU, true); ctx.closePath();
};
function dGear(o) {
  sticker(gearPath, C.c, "#1c98b3", o, "evenodd");
  ctx.beginPath(); ctx.arc(0, 0, 0.52, 0, TAU); ctx.lineWidth = 0.06; ctx.strokeStyle = "rgba(14,9,26,.28)"; ctx.stroke();
  gloss(-0.44, -0.4, 0.06, 0.15, -0.78); outline(gearPath, o.lw);
}
const boltPath = () => poly([0.16, -1, -0.52, 0.14, -0.04, 0.14, -0.26, 1, 0.56, -0.2, 0.08, -0.2, 0.44, -1]);
function dBolt(o) {
  sticker(boltPath, C.y, "#e0920c", o);
  ctx.beginPath(); ctx.moveTo(0.14, -0.84); ctx.lineTo(-0.2, -0.24); ctx.lineWidth = 0.08; ctx.strokeStyle = "rgba(255,255,255,.85)"; ctx.stroke();
  outline(boltPath, o.lw);
}
const cartPath = () => {
  const w = 0.8, h = 0.96, r = 0.14;
  ctx.beginPath(); ctx.moveTo(-w + r, -h); ctx.lineTo(w - 0.3, -h); ctx.lineTo(w, -h + 0.3);
  ctx.arcTo(w, h, -w, h, r); ctx.arcTo(-w, h, -w, -h, r); ctx.arcTo(-w, -h, w, -h, r); ctx.closePath();
};
function dCart(o) {
  sticker(cartPath, C.o, "#dd8a2b", o);
  ctx.lineWidth = 0.055; ctx.strokeStyle = "rgba(14,9,26,.35)";
  for (let i = 0; i < 3; i++) { ctx.beginPath(); ctx.moveTo(-0.52, -0.84 + i * 0.1); ctx.lineTo(0.16, -0.84 + i * 0.1); ctx.stroke(); }
  const g = ctx.createLinearGradient(-0.56, 0, 0.56, 0);
  g.addColorStop(0, C.y); g.addColorStop(0.52, C.p); g.addColorStop(1, C.c);
  ctx.beginPath(); rr(-0.56, -0.5, 1.12, 0.86, 0.1); ctx.fillStyle = g; ctx.fill(); ctx.lineWidth = o.lw * 0.6; ctx.strokeStyle = OUT; ctx.stroke();
  ctx.fillStyle = "#fff"; ctx.beginPath(); spark4(0, -0.07, 0.24); ctx.fill();
  ctx.beginPath(); rr(-0.44, 0.54, 0.88, 0.24, 0.06); ctx.fillStyle = "rgba(14,9,26,.55)"; ctx.fill();
  ctx.fillStyle = C.y; for (let i = 0; i < 5; i++) ctx.fillRect(-0.34 + i * 0.16, 0.6, 0.06, 0.12);
  outline(cartPath, o.lw);
}
function dPlanet(o) {
  const ring = (a0, a1) => {
    ctx.save(); ctx.rotate(-0.36);
    ctx.beginPath(); ctx.ellipse(0, 0, 1.12, 0.34, 0, a0, a1);
    ctx.lineWidth = 0.16 + o.lw * 2; ctx.strokeStyle = OUT; ctx.lineCap = "round"; ctx.stroke();
    ctx.lineWidth = 0.16; ctx.strokeStyle = C.c; ctx.stroke();
    ctx.restore();
  };
  ring(Math.PI, TAU);
  const body = () => { ctx.beginPath(); ctx.arc(0, 0, 0.66, 0, TAU); };
  sticker(body, C.o, "#dc842a", o);
  ctx.save(); body(); ctx.clip();
  ctx.beginPath(); ctx.ellipse(0, -0.12, 0.9, 0.12, -0.36, 0, TAU); ctx.fillStyle = "rgba(255,238,200,.55)"; ctx.fill();
  dot(0.24, 0.3, 0.09, "rgba(170,90,20,.45)"); dot(-0.3, 0.14, 0.06, "rgba(170,90,20,.45)");
  ctx.restore();
  gloss(-0.28, -0.34, 0.07, 0.13, 0.7); outline(body, o.lw); ring(0, Math.PI);
}
const bubblePath = () => {
  const w = 0.96, t = -0.78, b = 0.36, r = 0.32;
  ctx.beginPath(); ctx.moveTo(-w + r, t); ctx.arcTo(w, t, w, b, r); ctx.arcTo(w, b, -w, b, r);
  ctx.lineTo(-0.2, b); ctx.lineTo(-0.6, 0.8); ctx.lineTo(-0.52, b);
  ctx.arcTo(-w, b, -w, t, r); ctx.arcTo(-w, t, w, t, r); ctx.closePath();
};
function dBubble(o) {
  sticker(bubblePath, C.ink, "#c7b8e6", o); gloss(-0.66, -0.52, 0.05, 0.1, 0.9); outline(bubblePath, o.lw);
  const cols = [C.y, C.p, C.c];
  for (let i = 0; i < 3; i++) dot(-0.42 + i * 0.42, -0.2, 0.13, cols[i], o.lw * 0.55);
}
const dpadPath = () => { const a = 0.35, l = 0.98; poly([-a, -l, a, -l, a, -a, l, -a, l, a, a, a, a, l, -a, l, -a, a, -l, a, -l, -a, -a, -a]); };
function dDpad(o) {
  sticker(dpadPath, C.l, "#7a5ddf", o);
  dot(0, 0, 0.17, "rgba(14,9,26,.35)");
  ctx.fillStyle = "rgba(14,9,26,.42)";
  for (let i = 0; i < 4; i++) { ctx.save(); ctx.rotate(i * Math.PI / 2); poly([0, -0.84, 0.13, -0.64, -0.13, -0.64]); ctx.fill(); ctx.restore(); }
  gloss(-0.16, -0.72, 0.04, 0.12, 0, 0.7); outline(dpadPath, o.lw);
}
function dBall(o) {
  const body = () => { ctx.beginPath(); ctx.arc(0, 0, 1, 0, TAU); };
  sticker(body, C.c, "#1c98b3", o);
  ctx.save(); body(); ctx.clip();
  ctx.beginPath(); ctx.arc(0, -1.9, 2.05, 0.3 * Math.PI, 0.7 * Math.PI); ctx.lineWidth = 0.26; ctx.strokeStyle = C.p; ctx.stroke();
  ctx.restore();
  gloss(-0.38, -0.44, 0.13, 0.2, 0.7); outline(body, o.lw);
}
function dPjs(o) {
  const w = 1, h = 0.714, r = 0.43, sw = 0.186;
  ctx.beginPath(); rr(-w, -h, 2 * w, 2 * h, r);
  ctx.lineWidth = sw + o.lw * 1.6; ctx.strokeStyle = OUT; ctx.stroke();
  ctx.fillStyle = "#171226"; ctx.fill();
  ctx.lineWidth = sw; ctx.strokeStyle = C.y; ctx.stroke();
  ctx.beginPath(); ctx.arc(-w + r, -h + r, r - 0.02, 1.08 * Math.PI, 1.42 * Math.PI); ctx.lineWidth = 0.05; ctx.strokeStyle = "rgba(255,255,255,.85)"; ctx.stroke();
  dot(-0.43, 0, 0.221, C.p);
  ctx.beginPath(); rr(0, -0.243, 0.714, 0.157, 0.0785); ctx.fillStyle = C.c; ctx.fill();
  ctx.beginPath(); rr(0, 0.086, 0.464, 0.157, 0.0785); ctx.fillStyle = C.p; ctx.fill();
  for (const s of [-1, 1]) { const ex = s * 0.3, ey = -0.76; dot(ex, ey, 0.2, "#fff", o.lw * 0.9); dot(ex, ey, 0.095, OUT); }
}
const QMARK = [".XXX.", "X...X", "....X", "...X.", "..X..", ".....", "..X.."];
function dMystery(o) {
  const s = 0.86;
  const body = () => { ctx.beginPath(); rr(-s, -s, 2 * s, 2 * s, 0.2); };
  sticker(body, C.y, "#f0a126", o);
  ctx.beginPath(); rr(-s + 0.15, -s + 0.15, 2 * s - 0.3, 2 * s - 0.3, 0.1); ctx.lineWidth = 0.05; ctx.strokeStyle = "rgba(120,60,0,.28)"; ctx.stroke();
  for (const [x, y] of [[-0.62, -0.62], [0.62, -0.62], [0.62, 0.62], [-0.62, 0.62]]) dot(x, y, 0.065, "rgba(14,9,26,.6)");
  ctx.save(); ctx.translate(-0.04, -0.04); pixels(QMARK, { X: "#fff6cf" }, 0.17, 0); ctx.restore();
  ctx.save(); ctx.translate(0.02, 0.02); pixels(QMARK, { X: "#2b1d44" }, 0.17, 0); ctx.restore();
  gloss(-0.58, -0.3, 0.04, 0.14, 0, 0.8); outline(body, o.lw);
}
const TOYS = {
  star: dStar, spark: dSpark, heart: dHeart, cursor: dCursor, gear: dGear, bolt: dBolt, cart: dCart,
  planet: dPlanet, bubble: dBubble, dpad: dDpad, ghost: dGhost, ball: dBall, pjs: dPjs, mystery: dMystery,
};

function toy(type, r, size) {
  const c = canvas(size, size); ctx = c.getContext("2d");
  ctx.translate(size / 2, size / 2); ctx.scale(r, r);
  const o = { lx: -0.08, ly: -0.11, lw: Math.max(2.4 / r, 0.13), blink: 0, lookX: 0, lookY: 0 };
  ctx.lineJoin = "round"; ctx.lineCap = "round";
  TOYS[type](o);
  return c;
}

// ---- letters ------------------------------------------------------------------
const mctx = canvas(8, 8).getContext("2d");
function glyph(ch, face) {
  mctx.font = FONT;
  const mm = mctx.measureText(ch);
  const m = { l: -mm.actualBoundingBoxLeft, r: mm.actualBoundingBoxRight, t: -mm.actualBoundingBoxAscent, b: mm.actualBoundingBoxDescent };
  const w = m.r - m.l, ih = m.b - m.t;
  return { m, w, ih, face, rcK: face ? 0.96 : /[CSU]/.test(ch) ? 0.5 : 0.26 };
}
function oPath(rx, ry) {
  const k = 0.6, p = new Path2D();
  p.moveTo(-rx, 0);
  p.bezierCurveTo(-rx, -k * ry, -k * rx, -ry, 0, -ry);
  p.bezierCurveTo(k * rx, -ry, rx, -k * ry, rx, 0);
  p.bezierCurveTo(rx, k * ry, k * rx, ry, 0, ry);
  p.bezierCurveTo(-k * rx, ry, -rx, k * ry, -rx, 0);
  p.closePath();
  return p;
}
// The O's face: `state` = open | shut | left | right | blink | happy | wince.
function face(g, col, state) {
  const rx = g.w / 2, ry = g.ih / 2, ex = rx * 0.36, ey = -ry * 0.2, dk = PAL[col][2];
  ctx.fillStyle = "rgba(255,95,158,.55)";
  for (const s of [-1, 1]) { ctx.beginPath(); ctx.ellipse(s * rx * 0.62, ry * 0.1, 6.4, 3.6, 0, 0, TAU); ctx.fill(); }
  const mo = state === "happy" || state === "wince" ? 1 : 0;
  const my = ry * (0.32 - 0.02 * mo), mrx = rx * (0.17 + 0.08 * mo), mry = ry * (0.25 + 0.09 * mo);
  ctx.beginPath(); ctx.ellipse(2.4, my + 3.4, mrx + 0.6, mry + 0.6, 0, 0, TAU); ctx.fillStyle = "rgba(255,255,255,.5)"; ctx.fill();
  ctx.beginPath(); ctx.ellipse(-2, my - 2.8, mrx + 0.4, mry + 0.4, 0, 0, TAU); ctx.fillStyle = dk; ctx.fill();
  ctx.beginPath(); ctx.ellipse(0, my, mrx, mry, 0, 0, TAU); ctx.fillStyle = LOUT; ctx.fill();
  if (mo) {
    ctx.save(); ctx.clip();
    ctx.beginPath(); ctx.ellipse(1, my + mry * 0.78, mrx * 0.82, mry * 0.5, 0, 0, TAU); ctx.fillStyle = "#ff6fa6"; ctx.fill();
    ctx.restore();
  }
  const look = { left: [-3.2, -0.9], right: [3.2, -0.6] }[state] || [0, 0];
  ctx.lineCap = "round"; ctx.lineJoin = "round"; ctx.strokeStyle = LOUT; ctx.lineWidth = 3;
  for (const s of [-1, 1]) {
    const x = s * ex;
    if (state === "happy") {
      ctx.beginPath(); ctx.moveTo(x - 5, ey + 1.5); ctx.quadraticCurveTo(x, ey - 5, x + 5, ey + 1.5); ctx.stroke();
    } else if (state === "wince") {
      const d = -s;
      ctx.beginPath(); ctx.moveTo(x - 4 * d, ey - 4.5); ctx.lineTo(x + 3.5 * d, ey); ctx.lineTo(x - 4 * d, ey + 4.5); ctx.stroke();
    } else if (state === "shut") {
      ctx.beginPath(); ctx.moveTo(x - 5, ey - 0.5); ctx.quadraticCurveTo(x, ey + 4.5, x + 5, ey - 0.5); ctx.stroke();
    } else {
      const sy = state === "blink" ? 0.12 : 1, px = x + look[0], py = ey + look[1];
      ctx.beginPath(); ctx.ellipse(px, py, 4.5, 5.6 * sy, 0, 0, TAU); ctx.fillStyle = LOUT; ctx.fill();
      if (sy > 0.5) {
        dot(px - 1.5, py - 2.1, 1.7, "#fff");
        ctx.globalAlpha = 0.8; dot(px + 1.5, py + 2, 0.8, "#fff"); ctx.globalAlpha = 1;
      }
    }
  }
}
// D's jelly sticker: keyline, light-to-base fill, shade crescent, rim light.
function letter(ch, col, isFace, faceState, fs, size) {
  const g = glyph(ch, isFace), s = fs / 100;
  const spr = canvas(size, size), tmp = canvas(size, size);
  const gs = spr.getContext("2d"), ga = tmp.getContext("2d");
  const setT = (x) => x.setTransform(s, 0, 0, s, size / 2, size / 2);
  const tx = -(g.m.l + g.m.r) / 2, ty = -(g.m.t + g.m.b) / 2;
  const path = isFace ? oPath(g.w / 2, g.ih / 2) : null;
  const fill = (x) => { if (path) x.fill(path); else x.fillText(ch, tx, ty); };
  const stroke = (x) => { if (path) x.stroke(path); else x.strokeText(ch, tx, ty); };
  for (const x of [gs, ga]) { setT(x); x.font = FONT; x.lineJoin = "round"; x.lineCap = "round"; x.textBaseline = "alphabetic"; }
  const [lt, base, dk] = PAL[col];
  gs.fillStyle = LOUT; gs.strokeStyle = LOUT; gs.lineWidth = 17; stroke(gs); fill(gs);
  const gr = gs.createLinearGradient(0, -g.ih / 2, 0, g.ih / 2);
  gr.addColorStop(0, lt); gr.addColorStop(0.42, base); gr.addColorStop(1, base);
  gs.fillStyle = gr; fill(gs);
  ga.fillStyle = dk; fill(ga);
  ga.globalCompositeOperation = "destination-out"; ga.save(); ga.translate(-3.4, -4.6); fill(ga); ga.restore();
  ga.globalCompositeOperation = "source-over";
  gs.save(); gs.setTransform(1, 0, 0, 1, 0, 0); gs.drawImage(tmp, 0, 0); gs.restore();
  ga.save(); ga.setTransform(1, 0, 0, 1, 0, 0); ga.clearRect(0, 0, size, size); ga.restore();
  ga.fillStyle = "#fff"; fill(ga);
  ga.globalCompositeOperation = "destination-out";
  ga.lineWidth = 8; ga.strokeStyle = "#000"; stroke(ga);
  ga.save(); ga.translate(4.4, 6.6); fill(ga); ga.restore();
  ga.globalCompositeOperation = "source-over";
  gs.save(); gs.setTransform(1, 0, 0, 1, 0, 0); gs.globalAlpha = 0.58; gs.drawImage(tmp, 0, 0); gs.restore();
  if (isFace && faceState) { ctx = gs; face(g, col, faceState); }
  return spr;
}
function shadow(ch, col, isFace, fs, size) {
  const spr = letter(ch, col, isFace, null, fs, size);
  const c = canvas(size, size), g = c.getContext("2d");
  g.drawImage(spr, 0, 0); g.globalCompositeOperation = "source-in"; g.fillStyle = DROP; g.fillRect(0, 0, size, size);
  return c;
}

// ---- particles ----------------------------------------------------------------
function particle(kind, color, size) {
  const c = canvas(size, size); ctx = c.getContext("2d");
  const h = size / 2; ctx.translate(h, h);
  ctx.lineJoin = "round";
  if (kind === "burst") { ctx.beginPath(); spark4(0, 0, h * 0.72); ctx.lineWidth = Math.max(1.5, h * 0.72 * 0.32); ctx.strokeStyle = LOUT; ctx.stroke(); ctx.fillStyle = color; ctx.fill(); }
  else if (kind === "bdot") { ctx.beginPath(); ctx.arc(0, 0, h * 0.42, 0, TAU); ctx.lineWidth = 1.6; ctx.strokeStyle = LOUT; ctx.stroke(); ctx.fillStyle = color; ctx.fill(); }
  else if (kind === "star") { ctx.beginPath(); spark4(0, 0, h * 0.9); ctx.fillStyle = color; ctx.fill(); }
  else if (kind === "dot") { ctx.beginPath(); ctx.arc(0, 0, h * 0.5, 0, TAU); ctx.fillStyle = color; ctx.fill(); }
  return c;
}

// ---- the pocket ---------------------------------------------------------------
// Sprites share one frame: the tip of the pocket at (size/2, tipY).
function frontPath(k, sag) {
  const X = (x) => (x - 16) * k, Y = (y) => (y - 28) * k;
  ctx.beginPath();
  ctx.moveTo(X(5), Y(13));
  ctx.quadraticCurveTo(0, Y(13) + 2 * sag, X(27), Y(13));
  ctx.lineTo(X(27), Y(20.4));
  ctx.bezierCurveTo(X(27), Y(21.4), X(26.7), Y(22.3), X(26.1), Y(23));
  ctx.bezierCurveTo(X(23.6), Y(26), X(20), Y(27.8), 0, Y(27.8));
  ctx.bezierCurveTo(X(12), Y(27.8), X(8.4), Y(26), X(5.9), Y(23));
  ctx.bezierCurveTo(X(5.3), Y(22.3), X(5), Y(21.4), X(5), Y(20.4));
  ctx.closePath();
}
function pocketFront(k, lw, size, tipY) {
  const c = canvas(size, size); ctx = c.getContext("2d");
  ctx.translate(size / 2, tipY);
  const X = (x) => (x - 16) * k, Y = (y) => (y - 28) * k, sag = 1;
  ctx.lineJoin = "round"; ctx.lineCap = "round";
  frontPath(k, sag);
  const g = ctx.createLinearGradient(0, Y(13), 0, 0);
  g.addColorStop(0, "#30255a"); g.addColorStop(1, "#1f1838");
  ctx.fillStyle = g; ctx.fill();
  ctx.save(); frontPath(k, sag); ctx.clip();
  ctx.lineWidth = Math.max(1, 0.1 * k); ctx.strokeStyle = "rgba(203,189,226,.05)";
  ctx.beginPath();
  for (let x = X(5) - 16 * k; x < X(27); x += 0.62 * k) { ctx.moveTo(x, Y(13) - 1 * k); ctx.lineTo(x + 16 * k, Y(29)); }
  ctx.stroke();
  ctx.fillStyle = "rgba(255,255,255,.045)"; ctx.fillRect(X(4), Y(13) - k, 24 * k, 3.3 * k + sag);
  ctx.beginPath(); ctx.moveTo(X(4), Y(16.1) + sag * 0.3); ctx.lineTo(X(28), Y(16.1) + sag * 0.3);
  ctx.lineWidth = Math.max(1.5, 0.16 * k); ctx.strokeStyle = "rgba(14,9,26,.55)"; ctx.stroke();
  const ig = ctx.createLinearGradient(0, Y(13) + sag, 0, Y(13) + sag + 2 * k);
  ig.addColorStop(0, "rgba(10,6,20,.6)"); ig.addColorStop(1, "rgba(10,6,20,0)");
  ctx.fillStyle = ig; ctx.fillRect(X(4), Y(13) - k, 24 * k, 3 * k + sag);
  ctx.fillStyle = "rgba(255,255,255,.035)"; ctx.fillRect(X(5), Y(16.2), 2.1 * k, 9 * k);
  ctx.restore();
  const sw = Math.max(2.2, 0.28 * k);
  ctx.setLineDash([0.95 * k, 0.72 * k]);
  ctx.lineWidth = sw; ctx.strokeStyle = C.y;
  ctx.beginPath(); ctx.moveTo(X(8.6), Y(17.4) + sag * 0.25); ctx.lineTo(X(23.4), Y(17.4) + sag * 0.25); ctx.stroke();
  ctx.lineWidth = sw * 0.8; ctx.strokeStyle = "rgba(255,210,63,.42)";
  ctx.beginPath(); ctx.moveTo(X(7.2), Y(19.3)); ctx.lineTo(X(7.2), Y(20.6));
  ctx.bezierCurveTo(X(7.2), Y(23.3), X(11.2), Y(25.6), 0, Y(25.6)); ctx.bezierCurveTo(X(20.8), Y(25.6), X(24.8), Y(23.3), X(24.8), Y(20.6));
  ctx.lineTo(X(24.8), Y(19.3)); ctx.stroke();
  ctx.lineWidth = sw * 0.85;
  ctx.strokeStyle = "rgba(255,95,158,.85)";
  ctx.beginPath(); ctx.moveTo(X(10), Y(22.2)); ctx.quadraticCurveTo(X(13), Y(19.9), 0, Y(22.3)); ctx.stroke();
  ctx.strokeStyle = "rgba(63,208,232,.85)";
  ctx.beginPath(); ctx.moveTo(0, Y(22.3)); ctx.quadraticCurveTo(X(19), Y(19.9), X(22), Y(22.2)); ctx.stroke();
  ctx.setLineDash([]);
  frontPath(k, sag); ctx.lineWidth = lw + 6; ctx.strokeStyle = OUT; ctx.stroke();
  frontPath(k, sag); ctx.lineWidth = lw; ctx.strokeStyle = C.y; ctx.stroke();
  ctx.beginPath(); ctx.moveTo(X(5), Y(14.6)); ctx.lineTo(X(5), Y(18.4));
  ctx.lineWidth = Math.max(2, lw * 0.28); ctx.strokeStyle = "rgba(255,255,255,.75)"; ctx.stroke();
  for (const x of [X(5), X(27)]) {
    dot(x, Y(13), 0.72 * k, C.o, Math.max(2, 0.2 * k));
    dot(x - 0.2 * k, Y(13) - 0.22 * k, 0.22 * k, "rgba(255,255,255,.85)");
  }
  return c;
}
// The mouth drawn open (the flash size); the app squashes it shut with scaleY.
function pocketMouth(k, lw, w, h) {
  const c = canvas(w, h); ctx = c.getContext("2d");
  ctx.translate(w / 2, h / 2);
  const rx = 10.2 * k, ry = h / 2 - 3;
  ctx.beginPath(); ctx.ellipse(0, 0, rx, ry, 0, 0, TAU);
  ctx.fillStyle = "#0b0716"; ctx.fill();
  const g = ctx.createRadialGradient(0, ry * 0.3, 0, 0, 0, rx);
  g.addColorStop(0, "rgba(255,200,90,.95)"); g.addColorStop(0.3, "rgba(255,95,158,.68)");
  g.addColorStop(0.7, "rgba(90,60,170,.38)"); g.addColorStop(1, "rgba(11,7,22,0)");
  ctx.fillStyle = g; ctx.fill();
  ctx.beginPath(); ctx.ellipse(0, 0, rx, ry, 0, Math.PI, TAU);
  ctx.lineWidth = Math.max(3, lw * 0.55); ctx.strokeStyle = "#caa03a"; ctx.stroke();
  return c;
}
function pocketEyes(k, mode, w, h) {
  const c = canvas(w, h); ctx = c.getContext("2d");
  ctx.translate(w / 2, h / 2);
  const ex = 2.55 * k, erx = 1.2 * k, ery = 1.5 * k;
  for (const s of [-1, 1]) {
    const x = s * ex;
    if (mode === "happy") {
      ctx.beginPath(); ctx.arc(x, ery * 0.45, erx * 0.85, 1.12 * Math.PI, 1.88 * Math.PI);
      ctx.lineCap = "round"; ctx.lineWidth = 0.62 * k; ctx.strokeStyle = OUT; ctx.stroke();
      ctx.lineWidth = 0.34 * k; ctx.strokeStyle = C.ink; ctx.stroke();
    } else {
      ctx.beginPath(); ctx.ellipse(x, 0, erx, ery, 0, 0, TAU);
      ctx.fillStyle = C.ink; ctx.fill(); ctx.lineWidth = 0.3 * k; ctx.strokeStyle = OUT; ctx.stroke();
      const px = x, py = -0.4 * 0.55 * k;
      dot(px, py, 0.62 * k, OUT);
      dot(px - 0.22 * k, py - 0.24 * k, 0.2 * k, "#fff");
    }
  }
  return c;
}

// ---- backdrops ------------------------------------------------------------------
function dots(w, h, off) {
  ctx.fillStyle = "rgba(203,189,226,.085)";
  for (let y = (off || 0) % 24; y < h; y += 24) for (let x = 0; x < w; x += 24) { ctx.beginPath(); ctx.arc(x, y, 1.25, 0, TAU); ctx.fill(); }
}
function confetti(w, h, seed) {
  // the .sky layer's scattered bits, a sparse deterministic scatter
  let s = seed;
  const rnd = () => { s = (s * 16807) % 2147483647; return s / 2147483647; };
  const cols = [C.y, C.c, C.p, C.o, C.l];
  ctx.globalAlpha = 0.27;
  for (let i = 0; i < 14; i++) {
    const x = rnd() * w, y = rnd() * h, col = cols[i % cols.length], kind = i % 3;
    ctx.fillStyle = col; ctx.strokeStyle = col;
    if (kind === 0) { ctx.beginPath(); ctx.arc(x, y, 2.2, 0, TAU); ctx.fill(); }
    else if (kind === 1) { ctx.save(); ctx.translate(x, y); ctx.rotate(rnd() * 3); ctx.beginPath(); rr(-5.5, -2.5, 11, 5, 2.5); ctx.fill(); ctx.restore(); }
    else { ctx.beginPath(); ctx.moveTo(x, y); ctx.quadraticCurveTo(x + 5, y - 6, x + 10, y); ctx.quadraticCurveTo(x + 15, y + 6, x + 20, y); ctx.lineWidth = 2.4; ctx.lineCap = "round"; ctx.stroke(); }
  }
  ctx.globalAlpha = 1;
}
function vignette(w, h) {
  const g = ctx.createRadialGradient(w / 2, h * 0.46, Math.min(w, h) * 0.3, w / 2, h * 0.46, Math.max(w, h) * 0.75);
  g.addColorStop(0, "rgba(9,5,18,0)"); g.addColorStop(1, "rgba(9,5,18,.6)");
  ctx.fillStyle = g; ctx.fillRect(0, 0, w, h);
}
// The top screen: rays fan up from the pocket below the hinge toward the
// wordmark, with the warm haze behind the letters.
function topBackdrop(o) {
  const c = canvas(o.texW, o.texH); ctx = c.getContext("2d");
  const w = o.w, h = o.h;
  ctx.fillStyle = "#171226"; ctx.fillRect(0, 0, o.texW, o.texH);
  const top = ctx.createRadialGradient(w / 2, -h * 0.12, 0, w / 2, -h * 0.12, w * 0.6);
  top.addColorStop(0, "rgba(169,139,255,.11)"); top.addColorStop(1, "rgba(169,139,255,0)");
  ctx.fillStyle = top; ctx.fillRect(0, 0, w, h);
  confetti(w, h, 7); dots(w, h, 12); vignette(w, h);
  ctx.save(); ctx.globalCompositeOperation = "lighter";
  const cx = o.rayX, cy = o.rayY, len = cy - o.wordY + 40;
  const cols = ["255,210,63", "255,95,158", "63,208,232", "255,95,158", "255,210,63"];
  const spread = Math.min(0.3, Math.max(0.12, Math.atan2(o.wordW * 0.36, len) / 2));
  for (let i = 0; i < 5; i++) {
    const a = -Math.PI / 2 + (i - 2) * spread, half = 0.05 + (i % 2) * 0.018, ra = 0.075;
    const rg = ctx.createLinearGradient(cx, cy, cx + Math.cos(a) * len, cy + Math.sin(a) * len);
    rg.addColorStop(0, `rgba(${cols[i]},${ra})`); rg.addColorStop(0.7, `rgba(${cols[i]},${ra * 0.35})`); rg.addColorStop(1, `rgba(${cols[i]},0)`);
    ctx.fillStyle = rg; ctx.beginPath();
    ctx.moveTo(cx, cy);
    ctx.lineTo(cx + Math.cos(a - half) * len, cy + Math.sin(a - half) * len);
    ctx.lineTo(cx + Math.cos(a + half) * len, cy + Math.sin(a + half) * len);
    ctx.closePath(); ctx.fill();
  }
  ctx.restore();
  return c;
}
// Haze behind the wordmark; the app fades it in as the letters land.
function haze(o) {
  const c = canvas(o.texW, o.texH); ctx = c.getContext("2d");
  const hz = [["255,210,63", 0.28, 0.46, 0.3], ["255,95,158", 0.52, 0.56, 0.28], ["63,208,232", 0.76, 0.44, 0.26]];
  const rad = Math.max(o.wordW * 0.44, o.wordH * 0.8);
  for (const [col, px, py, a] of hz) {
    const x = o.texW / 2 - o.wordW / 2 + o.wordW * px, y = o.texH / 2 - o.wordH / 2 + o.wordH * py;
    const g = ctx.createRadialGradient(x, y, 0, x, y, rad);
    g.addColorStop(0, `rgba(${col},${a * 0.6})`); g.addColorStop(1, `rgba(${col},0)`);
    ctx.fillStyle = g; ctx.beginPath(); ctx.arc(x, y, rad, 0, TAU); ctx.fill();
  }
  return c;
}
function bottomBackdrop(o) {
  const c = canvas(o.texW, o.texH); ctx = c.getContext("2d");
  const w = o.w, h = o.h;
  ctx.fillStyle = "#171226"; ctx.fillRect(0, 0, o.texW, o.texH);
  const bot = ctx.createRadialGradient(w / 2, h * 1.1, 0, w / 2, h * 1.1, w * 0.7);
  bot.addColorStop(0, "rgba(255,95,158,.14)"); bot.addColorStop(1, "rgba(255,95,158,0)");
  ctx.fillStyle = bot; ctx.fillRect(0, 0, w, h);
  confetti(w, h, 3); dots(w, h, 0); vignette(w, h);
  // pocket glow
  ctx.save(); ctx.globalCompositeOperation = "lighter"; ctx.translate(o.cx, o.topY);
  ctx.save(); ctx.scale(1, 1.25);
  const pw = o.pw, g = ctx.createRadialGradient(0, 0, 0, 0, 0, pw * 1.35);
  g.addColorStop(0, "rgba(255,95,158,.2)"); g.addColorStop(0.45, "rgba(169,139,255,.07)"); g.addColorStop(1, "rgba(169,139,255,0)");
  ctx.fillStyle = g; ctx.beginPath(); ctx.arc(0, 0, pw * 1.35, 0, TAU); ctx.fill();
  ctx.restore();
  const yg = ctx.createRadialGradient(0, 0, 0, 0, 0, pw * 0.55);
  yg.addColorStop(0, "rgba(255,210,63,.14)"); yg.addColorStop(1, "rgba(255,210,63,0)");
  ctx.fillStyle = yg; ctx.beginPath(); ctx.arc(0, 0, pw * 0.55, 0, TAU); ctx.fill();
  // rays up toward the top screen
  const cols = ["255,210,63", "255,95,158", "63,208,232", "255,95,158", "255,210,63"];
  for (let i = 0; i < 5; i++) {
    const a = -Math.PI / 2 + (i - 2) * 0.16, half = 0.05 + (i % 2) * 0.018, len = o.topY + 40, ra = 0.09;
    const rg = ctx.createLinearGradient(0, 0, Math.cos(a) * len, Math.sin(a) * len);
    rg.addColorStop(0, `rgba(${cols[i]},${ra})`); rg.addColorStop(1, `rgba(${cols[i]},${ra * 0.4})`);
    ctx.fillStyle = rg; ctx.beginPath();
    ctx.moveTo(Math.cos(a) * pw * 0.12, 0);
    ctx.lineTo(Math.cos(a - half) * len, Math.sin(a - half) * len);
    ctx.lineTo(Math.cos(a + half) * len, Math.sin(a + half) * len);
    ctx.closePath(); ctx.fill();
  }
  ctx.restore();
  // floor
  const fg = ctx.createLinearGradient(0, o.floorY, 0, h);
  fg.addColorStop(0, "rgba(14,9,26,.55)"); fg.addColorStop(1, "rgba(14,9,26,.25)");
  ctx.fillStyle = fg; ctx.fillRect(0, o.floorY + 2, w, h - o.floorY);
  ctx.save(); ctx.setLineDash([8, 8]); ctx.lineCap = "round";
  ctx.beginPath(); ctx.moveTo(0, o.floorY + 3); ctx.lineTo(w, o.floorY + 3);
  ctx.lineWidth = 2; ctx.strokeStyle = "rgba(169,139,255,.3)"; ctx.stroke(); ctx.restore();
  ctx.beginPath(); ctx.ellipse(o.cx, o.floorY + 2, pw * 0.3, 5, 0, 0, TAU); ctx.fillStyle = "rgba(6,3,12,.55)"; ctx.fill();
  return c;
}
// A pulse of the pocket glow for pops; additive art on transparent.
function glow(o) {
  const c = canvas(o.texW, o.texH); ctx = c.getContext("2d");
  ctx.translate(o.texW / 2, o.texH / 2);
  const pw = o.pw;
  ctx.save(); ctx.scale(1, 0.9);
  const g = ctx.createRadialGradient(0, 0, 0, 0, 0, o.texW / 2);
  g.addColorStop(0, "rgba(255,95,158,.34)"); g.addColorStop(0.35, "rgba(255,210,63,.18)"); g.addColorStop(0.7, "rgba(169,139,255,.08)"); g.addColorStop(1, "rgba(169,139,255,0)");
  ctx.fillStyle = g; ctx.beginPath(); ctx.arc(0, 0, o.texW / 2, 0, TAU); ctx.fill();
  ctx.restore();
  void pw;
  return c;
}
// "tap the pocket", with the arrow bending down toward the mouth.
function hint(w, h) {
  const c = canvas(w, h); ctx = c.getContext("2d");
  ctx.translate(w / 2, 0);
  ctx.save(); ctx.translate(0, 17); ctx.rotate(-4 * Math.PI / 180);
  ctx.font = '600 15px "Fredoka"'; ctx.textAlign = "center"; ctx.textBaseline = "middle";
  ctx.fillStyle = "#0e091a"; ctx.fillText("tap the pocket", 0, 2);
  ctx.fillStyle = C.ink2; ctx.fillText("tap the pocket", 0, 0);
  ctx.restore();
  // homepage arrow (58x44 viewBox), scaled into 34x26 under the text, mirrored down
  ctx.save(); ctx.translate(-4, 28); ctx.scale(34 / 58, 26 / 44);
  ctx.strokeStyle = C.y; ctx.lineWidth = 3 * 58 / 34; ctx.lineCap = "round"; ctx.lineJoin = "round";
  ctx.stroke(new Path2D("M4 8c14-4 30 0 38 12 3 5 4 10 3 16")); ctx.stroke(new Path2D("M36 30l9 7 6-10"));
  ctx.restore();
  return c;
}

window.NX = { toy, letter, shadow, glyph, particle, pocketFront, pocketMouth, pocketEyes, topBackdrop, haze, bottomBackdrop, glow, hint, toys: Object.keys(TOYS) };
})();
