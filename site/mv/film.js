// site/mv/film.js — the storyboard.
//
// drawFrame(ctx, t) paints the whole picture for one moment of the song. It
// reads nothing but t, so the page can drive it from the audio clock and
// tools/render-mv.ts can drive it frame by frame with no clock at all and get
// the same film.
//
// The cut list is written in bars, not seconds: score.js owns the tempo, and
// every shot change, flash and typographic slam is a bar number here.

import * as D from "./draw.js";
import { BAR, BARS, SPB, DURATION, BAR_CHORDS, SECTIONS } from "./score.js";
import { lyricAt, TITLE_JA, TITLE_EN, SOURCE, FACTS, DEVICES } from "./lyrics.js";

export const W = 1920;
export const H = 1080;
export { DURATION };

const JA = '700 1px "Zen Kaku Gothic New", "Hiragino Sans", "Noto Sans JP", "Yu Gothic", sans-serif';
const JA_BLACK = '900 1px "Zen Kaku Gothic New", "Hiragino Sans", "Noto Sans JP", "Yu Gothic", sans-serif';
const EN = '500 1px "IBM Plex Sans", -apple-system, system-ui, sans-serif';
const MONO = '500 1px "IBM Plex Mono", ui-monospace, Menlo, monospace';
const PIXEL = '400 1px "VT323", ui-monospace, monospace';
const at = (font, px) => font.replace(" 1px ", ` ${Math.round(px)}px `);

// --------------------------------------------------------------- time

function clock(t) {
  const beat = t / SPB;
  const bar = t / BAR;
  return {
    t,
    beat,
    bar,
    barIndex: Math.floor(bar),
    barPhase: bar - Math.floor(bar),
    beatPhase: beat - Math.floor(beat),
    /** A decaying kick on every beat, 1 at the downbeat. */
    pulse: Math.pow(1 - (beat - Math.floor(beat)), 2.6),
    /** The same, but only on the first beat of the bar. */
    barPulse: Math.pow(1 - (bar - Math.floor(bar)), 3) * (Math.floor(beat) % 4 === 0 ? 1 : 0),
    chord: BAR_CHORDS[Math.min(BARS - 1, Math.floor(bar))],
  };
}

// --------------------------------------------------------------- grounds

function wash(ctx, top, bottom) {
  const g = ctx.createLinearGradient(0, 0, 0, H);
  g.addColorStop(0, top);
  g.addColorStop(1, bottom);
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, W, H);
}

/** Slow horizontal currents — the blue is never a flat fill. */
function currents(ctx, t, color, count, alpha) {
  for (let i = 0; i < count; i++) {
    const r = D.rng(900 + i * 77);
    const y = r() * H;
    const speed = 14 + r() * 26;
    const x = ((r() * W + t * speed) % (W + 700)) - 350;
    const len = 240 + r() * 620;
    D.stroke(ctx, [[x, y], [x + len, y + (r() - 0.5) * 26]], {
      t, seed: 3100 + i, color, width: 2 + r() * 3, alpha: alpha * (0.4 + r() * 0.6),
      passes: 1, wobble: 7, step: 120,
    });
  }
}

/** Pixels rising through the frame, the film's dust. */
function motes(ctx, t, count, alpha = 0.8, speed = 42) {
  for (let i = 0; i < count; i++) {
    const r = D.rng(4400 + i * 131);
    const x = r() * W;
    const size = 3 + Math.floor(r() * 4) * 3;
    const y = H + 60 - (((r() * H + t * (speed * (0.5 + r()))) % (H + 220)));
    const hue = r() < 0.22 ? D.HUES[Math.floor(r() * 3)] : D.INK;
    ctx.globalAlpha = alpha * (0.25 + r() * 0.75);
    ctx.fillStyle = hue;
    ctx.fillRect(Math.round(x), Math.round(y), size, size);
  }
  ctx.globalAlpha = 1;
}

/** The sky the whole film is about, drawable at any size. */
function miniSky(ctx, x, y, w, h, t, u, seed = 1) {
  ctx.save();
  ctx.beginPath();
  ctx.rect(x, y, w, h);
  ctx.clip();
  const g = ctx.createLinearGradient(0, y, 0, y + h);
  g.addColorStop(0, "#0d1c5e");
  g.addColorStop(0.62, D.BLUE_MID);
  g.addColorStop(1, D.SKY);
  ctx.fillStyle = g;
  ctx.fillRect(x, y, w, h);
  const s = Math.min(w, h);
  D.ellipse(ctx, x + w * 0.74, y + h * 0.3, s * 0.13, s * 0.13, {
    t, seed: seed * 17, color: D.YELLOW, fill: D.YELLOW, alpha: 0.9 * u, width: s * 0.012,
  });
  D.cloud(ctx, x + w * 0.3, y + h * 0.42, w * 0.34, {
    t, seed: seed * 23, color: D.INK, fill: "rgba(240,244,255,.22)", alpha: u, width: s * 0.014,
  });
  D.cloud(ctx, x + w * 0.72, y + h * 0.66, w * 0.26, {
    t, seed: seed * 29, color: D.INK, fill: "rgba(240,244,255,.18)", alpha: 0.8 * u, width: s * 0.012,
  });
  for (let i = 0; i < 4; i++) {
    const r = D.rng(seed * 31 + i * 13);
    const bx = x + w * (0.12 + r() * 0.7) + ((t * (18 + r() * 30)) % (w * 1.2));
    D.bird(ctx, x + ((bx - x) % (w * 1.1)), y + h * (0.18 + r() * 0.3), s * 0.05,
      t * 7 + i, { t, seed: seed * 37 + i, color: D.INK, width: s * 0.011, alpha: u });
  }
  ctx.restore();
}

// --------------------------------------------------------------- motifs

/**
 * A hand as one closed silhouette — palm, four fingers, thumb — so the fill
 * and the outline describe the same shape. `curl` folds the fingers in for a
 * cupped hand; fingers point up in the local frame.
 */
function handPath(s, curl) {
  const fingers = [[-0.33, 0.60, 0.105], [-0.11, 0.76, 0.115], [0.11, 0.82, 0.118], [0.32, 0.68, 0.108]];
  const p = [[-0.46, 0.80], [-0.52, 0.34], [-0.46, 0.08]];
  fingers.forEach(([fx, flen, fw], i) => {
    const tip = 0.04 - flen * (1 - curl * 0.62);
    p.push([fx - fw, 0.02]);
    p.push([fx - fw, tip + fw]);
    for (let k = 0; k <= 6; k++) {
      const a = Math.PI + (k / 6) * Math.PI;
      p.push([fx + Math.cos(a) * fw, tip + fw + Math.sin(a) * fw]);
    }
    p.push([fx + fw, i === fingers.length - 1 ? 0.1 : 0.06]);
  });
  p.push([0.48, 0.18], [0.56, 0.34], [0.74, 0.42], [0.8, 0.55], [0.66, 0.62], [0.5, 0.58]);
  p.push([0.44, 0.8], [0, 0.88], [-0.46, 0.8]);
  return p.map(([x, y]) => [x * s, y * s]);
}

function hand(ctx, x, y, s, tilt, o = {}) {
  const { t = 0, seed = 71, color = D.INK, alpha = 1, fill = null, curl = 0.25 } = o;
  const pts = handPath(s, curl);
  ctx.save();
  ctx.translate(x, y);
  ctx.rotate(tilt);
  if (fill) D.blob(ctx, pts, { t, seed, color: fill, alpha, wobble: s * 0.012 });
  D.stroke(ctx, pts, {
    t, seed, color, width: Math.max(3, s * 0.035), alpha,
    closed: true, wobble: s * 0.014, step: s * 0.07,
  });
  ctx.restore();
}

/** Source code, set in mono, scrolling up behind a clip. */
function sourceColumn(ctx, x, y, w, h, t, scroll, o = {}) {
  const { color = D.BLUE, alpha = 0.8, size = 21, seed = 200 } = o;
  const lh = size * 1.75;
  ctx.save();
  ctx.beginPath();
  ctx.rect(x, y, w, h);
  ctx.clip();
  const first = Math.floor(scroll / lh) - 1;
  for (let i = first; i < first + h / lh + 3; i++) {
    const line = SOURCE[((i % SOURCE.length) + SOURCE.length) % SOURCE.length];
    const ly = y + i * lh - scroll;
    if (!line) continue;
    const fade = D.clamp(Math.min(ly - y, y + h - ly) / 42, 0, 1);
    ctx.save();
    ctx.font = at(MONO, size);
    const over = D.measure(ctx, line) - w;
    ctx.restore();
    D.text(ctx, line, x, ly, {
      t, seed: seed + i, font: at(MONO, size), color,
      alpha: alpha * fade * (over > 0 ? 0.35 : 1), shake: 0.9, passes: 1,
    });
  }
  ctx.restore();
}

/** A screen's worth of pixels resolving out of noise as u goes 0 -> 1. */
function pixelScreen(ctx, x, y, w, h, t, u, seed = 9) {
  const cols = 30;
  const cell = w / cols;
  const rows = Math.ceil(h / cell);
  const boil = Math.floor(t * 6);
  D.pixels(ctx, x, y, cell, cols, rows, (c, r) => {
    const n = D.rng(seed * 7919 + c * 131 + r * 977 + (u > 0.98 ? 0 : boil))();
    if (n > 0.12 + u * 0.82) return null;
    const sky = r / rows;
    const color = n < 0.06 ? D.HUES[Math.floor(n * 50) % 3]
      : sky < 0.45 ? "#1b3792" : sky < 0.75 ? D.BLUE_MID : D.SKY;
    return { color, alpha: 0.35 + n * 0.65 };
  }, { alpha: 1 - u * 0.15 });
}

/** A grid of devices, one per hardware target the runtime actually reaches. */
function deviceWall(ctx, t, c, seed = 400) {
  const cols = 5;
  const rows = 3;
  const cw = W / cols;
  const ch = (H - 180) / rows;
  for (let r = 0; r < rows; r++) {
    for (let i = 0; i < cols; i++) {
      const k = r * cols + i;
      const rr = D.rng(seed + k * 37);
      const cx = cw * (i + 0.5);
      const cy = 120 + ch * (r + 0.45);
      const on = (Math.floor(c.beat) + k) % 4 === 0;
      const scale = (cw * 0.026) * (0.86 + rr() * 0.22) * (1 + (on ? c.pulse * 0.08 : 0));
      D.device(ctx, cx, cy, scale, {
        t, seed: seed + k * 11, color: D.INK,
        screen: on ? D.HUES[k % 3] : "rgba(12,24,80,.85)", lit: on ? 1 : 0,
      });
      D.text(ctx, DEVICES[k % DEVICES.length], cx, cy + ch * 0.36, {
        t, seed: seed + k, font: at(PIXEL, 34), color: on ? D.HUES[k % 3] : "rgba(238,242,255,.55)",
        align: "center", shake: 1, passes: 1, tracking: 2,
      });
    }
  }
}

// --------------------------------------------------------------- scenes

// 0 -> 8 : a handheld falling through deep water-blue, and the title.
function sceneIntro(ctx, t, c) {
  wash(ctx, "#050b2c", "#13266f");
  currents(ctx, t, "rgba(120,160,255,.5)", 14, 0.5);
  motes(ctx, t, 90, 0.7, 30);

  const fall = D.clamp(c.bar / 5.4, 0, 1);
  const cy = D.lerp(-180, H * 0.44, D.easeOut(fall)) + Math.sin(t * 1.1) * 14 * fall;
  const cx = W * 0.5 + Math.sin(t * 0.7) * 60 * (1 - fall * 0.6);
  const rot = D.lerp(-0.9, 0.06, D.easeOut(fall));
  const glow = ctx.createRadialGradient(cx, cy, 20, cx, cy, 520);
  glow.addColorStop(0, "rgba(91,140,255,.45)");
  glow.addColorStop(1, "rgba(91,140,255,0)");
  ctx.fillStyle = glow;
  ctx.fillRect(0, 0, W, H);

  // The arc it fell along, still hanging in the water.
  for (let i = 0; i < 3; i++) {
    const u = 1 - i * 0.28;
    D.stroke(ctx, [[cx - 260 * u, cy - 420 * u], [cx - 40 * u, cy - 180 * u], [cx, cy - 60]], {
      t, seed: 61 + i, color: "rgba(180,205,255,.45)", width: 3, alpha: 0.5 * fall, passes: 1, wobble: 9,
    });
  }

  ctx.save();
  ctx.translate(cx, cy);
  ctx.rotate(rot);
  const lit = c.bar >= 2;
  D.device(ctx, 0, 0, 10.5, {
    t, seed: 13, color: D.INK, lit: lit ? 1 : 0,
    screen: lit ? "rgba(43,86,200,.92)" : "rgba(10,20,64,.9)",
  });
  if (lit) miniSky(ctx, -132, -92, 264, 184, t, D.ramp(c.bar, 2, 4.5), 3);
  ctx.restore();

  // Title, written on across bars 4 to 6.
  const wr = D.ramp(c.bar, 4, 6);
  if (wr > 0) {
    ctx.save();
    ctx.font = at(JA_BLACK, 132);
    const tw = D.measure(ctx, TITLE_JA, 14);
    ctx.restore();
    D.reveal(ctx, W / 2 - tw / 2 - 20, H * 0.72, tw + 40, 220, wr, () => {
      D.text(ctx, TITLE_JA, W / 2, H * 0.78, {
        t, seed: 77, font: at(JA_BLACK, 132), color: D.INK, align: "center", tracking: 14, shake: 2,
      });
    });
    D.line(ctx, W / 2 - tw / 2, H * 0.815, W / 2 - tw / 2 + tw * wr, H * 0.815, {
      t, seed: 79, color: D.CYAN, width: 5, alpha: 0.85,
    });
    D.text(ctx, TITLE_EN, W / 2, H * 0.86, {
      t, seed: 81, font: at(EN, 34), color: "rgba(238,242,255,.8)",
      align: "center", tracking: 7, alpha: D.ramp(c.bar, 5.6, 6.8), shake: 1,
    });
  }
}

// 8 -> 16 : paper, blue ink, a hand and the source. The verse is drawn, not lit.
function sceneDesk(ctx, t, c) {
  const local = c.bar - 8;
  wash(ctx, D.PAPER, "#dcd9cc");
  D.hatch(ctx, 0, H * 0.62, W, H * 0.38, { t, seed: 91, color: "rgba(20,39,110,.10)", gap: 34, angle: -0.42, width: 3 });

  const shot = Math.floor(local / 2); // a new framing every two bars
  const close = shot === 1 || shot === 3;
  const scale = close ? 24 : 13;
  const cx = close ? W * 0.5 : W * 0.63;
  const cy = close ? H * 0.5 : H * 0.48;
  const tilt = close ? 0.02 : -0.13 + Math.sin(t * 0.9) * 0.03;

  if (!close) {
    sourceColumn(ctx, W * 0.07, H * 0.18, W * 0.42, H * 0.6, t, t * 40, { color: "rgba(20,39,110,.78)" });
    D.line(ctx, W * 0.07, H * 0.16, W * 0.07 + 330, H * 0.16, { t, seed: 95, color: D.PINK, width: 5 });
    D.text(ctx, "app.tsx", W * 0.07, H * 0.14, { t, seed: 96, font: at(MONO, 30), color: D.BLUE, tracking: 3 });
  }

  if (!close) hand(ctx, cx - 14, cy + scale * 21, scale * 22, tilt + 0.04, { t, seed: 111, color: D.BLUE, fill: "#e6e3d6", curl: 0.42 });
  ctx.save();
  ctx.translate(cx, cy);
  ctx.rotate(tilt);
  const sx = -scale * 14;
  const sy = -scale * 10;
  D.device(ctx, 0, 0, scale, { t, seed: 101, color: D.BLUE, screen: "#101f5e" });
  const inner = { x: sx + scale * 1.4, y: sy + scale * 1.4, w: scale * 25.2, h: scale * 17.2 };
  if (shot === 0) pixelScreen(ctx, inner.x, inner.y, inner.w, inner.h, t, 0.2, 5);
  else if (shot === 1) pixelScreen(ctx, inner.x, inner.y, inner.w, inner.h, t, D.ramp(local, 2, 3.6), 5);
  else if (shot === 2) {
    pixelScreen(ctx, inner.x, inner.y, inner.w, inner.h, t, 0.92, 5);
    D.text(ctx, "60", 0, scale * 2, { t, seed: 103, font: at(PIXEL, scale * 9), color: D.YELLOW, align: "center", shake: 2 });
  } else miniSky(ctx, inner.x, inner.y, inner.w, inner.h, t, D.ramp(local, 6, 7), 7);
  ctx.restore();


  // The bar line: a mark struck on every downbeat, the way a metronome leaves one.
  for (let i = 0; i < 8; i++) {
    const b = 8 + i;
    if (c.bar < b) break;
    D.line(ctx, W * 0.07 + i * 34, H * 0.93, W * 0.07 + i * 34, H * 0.93 - 34 * (b === c.barIndex ? 1 + c.barPulse : 0.55), {
      t, seed: 120 + i, color: b === c.barIndex ? D.PINK : "rgba(20,39,110,.4)", width: 5, passes: 1,
    });
  }
}

// 16 -> 24 : the run. Ground scrolls, hardware scrolls behind it, sparks trail.
function sceneRun(ctx, t, c) {
  const local = c.bar - 16;
  wash(ctx, "#081447", "#1d3ba6");
  currents(ctx, t, "rgba(120,160,255,.35)", 10, 0.45);

  // Hardware skyline, two parallax layers.
  for (let layer = 0; layer < 2; layer++) {
    const speed = layer === 0 ? 34 : 96;
    const size = layer === 0 ? 3.6 : 5.6;
    const base = layer === 0 ? H * 0.38 : H * 0.48;
    for (let i = 0; i < 16; i++) {
      const r = D.rng(700 + layer * 91 + i * 53);
      const span = W + 520;
      const x = (((i / 16 + r() * 0.045) * span - t * speed) % span + span) % span - 260;
      D.device(ctx, x, base - r() * 120, size * (0.55 + r() * 1.15), {
        t, seed: 720 + layer * 40 + i, color: layer === 0 ? "rgba(150,180,255,.3)" : "rgba(205,222,255,.5)",
        screen: layer === 0 ? "rgba(20,40,120,.6)" : "rgba(28,58,160,.8)",
      });
    }
  }

  // Ground. A scrim under the skyline keeps the runner off the hardware.
  const gy = H * 0.78;
  const scrim = ctx.createLinearGradient(0, H * 0.5, 0, H);
  scrim.addColorStop(0, "rgba(6,14,58,0)");
  scrim.addColorStop(1, "rgba(6,14,58,.85)");
  ctx.fillStyle = scrim;
  ctx.fillRect(0, H * 0.5, W, H * 0.5);
  D.line(ctx, -40, gy, W + 40, gy, { t, seed: 130, color: D.INK, width: 6, step: 90, wobble: 5 });
  for (let i = 0; i < 40; i++) {
    const span = W + 200;
    const x = ((i * 64 - t * 320) % span + span) % span - 100;
    D.line(ctx, x, gy + 8, x - 34, gy + 54, { t, seed: 140 + i, color: "rgba(180,205,255,.45)", width: 3, passes: 1 });
  }

  // The runner, and what trails off them.
  const rx = W * 0.34 + Math.sin(t * 1.3) * 26;
  D.runner(ctx, rx, gy + 6, H * 0.42, t * 13.4, { t, seed: 151, color: D.INK });
  D.device(ctx, rx - H * 0.11, gy - H * 0.25, 4, { t, seed: 157, color: D.YELLOW, screen: D.YELLOW, lit: 1 });
  for (let i = 0; i < 46; i++) {
    const r = D.rng(800 + i * 29);
    const age = ((t * (1.4 + r()) + r() * 3) % 2.2) / 2.2;
    const size = 4 + Math.floor(r() * 4) * 4;
    ctx.globalAlpha = (1 - age) * 0.9;
    ctx.fillStyle = D.HUES[Math.floor(r() * 3)];
    ctx.fillRect(rx - age * (420 + r() * 520), gy - 40 - r() * H * 0.3 + age * 120, size, size);
  }
  ctx.globalAlpha = 1;

  // Bars 20-21 carry "no DOM, no CSS": strike the words through on the beat.
  if (local >= 4 && local < 6) {
    const u = D.ramp(local, 4, 4.5);
    ctx.save();
    ctx.globalAlpha = u;
    const band = ctx.createLinearGradient(0, H * 0.26, 0, H * 0.64);
    band.addColorStop(0, "rgba(6,12,46,0)");
    band.addColorStop(0.3, "rgba(6,12,46,.86)");
    band.addColorStop(0.7, "rgba(6,12,46,.86)");
    band.addColorStop(1, "rgba(6,12,46,0)");
    ctx.fillStyle = band;
    ctx.fillRect(0, H * 0.26, W, H * 0.38);
    ctx.restore();
    const words = ["DOM", "CSS", "WebView"];
    words.forEach((word, i) => {
      const shown = local >= 4 + i * 0.5;
      if (!shown) return;
      const x = W * (0.2 + i * 0.3);
      D.text(ctx, word, x, H * 0.47, {
        t, seed: 900 + i, font: at(MONO, 92), color: D.INK, align: "center", alpha: 0.9, shake: 2.4, tracking: 4,
      });
      const su = D.ramp(local, 4.25 + i * 0.5, 4.6 + i * 0.5);
      D.line(ctx, x - 150, H * 0.455, x - 150 + 300 * su, H * 0.45, {
        t, seed: 910 + i, color: D.PINK, width: 9,
      });
    });
  }
}

// 24 -> 32 : push all the way into the screen, then break up on the snare roll.
function scenePre(ctx, t, c) {
  const local = c.bar - 24;
  const u = D.clamp(local / 6, 0, 1);
  wash(ctx, "#060d31", "#16308a");
  motes(ctx, t, 70, 0.55, 90 + u * 340);

  const scale = 9 * Math.pow(9.2, D.easeIn(u) * 0.98 + u * 0.02);
  const cx = W * 0.5;
  const cy = H * 0.5;
  D.burst(ctx, cx, cy, 220 + u * 700, 1500 + u * 900, 26, {
    t, seed: 300, color: "rgba(140,175,255,.32)", width: 3 + u * 5, alpha: 0.25 + u * 0.5,
  });

  const sx = cx - scale * 12.6;
  const sy = cy - scale * 8.6;
  const sw = scale * 25.2;
  const sh = scale * 17.2;
  pixelScreen(ctx, sx, sy, sw, sh, t, D.ramp(local, 1.5, 5), 11);
  if (local > 4) {
    ctx.save();
    ctx.globalAlpha = D.ramp(local, 4, 5.8);
    miniSky(ctx, sx, sy, sw, sh, t, 1, 13);
    ctx.restore();
  }
  D.device(ctx, cx, cy, scale, { t, seed: 301, color: D.INK, alpha: D.clamp(1.6 - u * 1.5, 0, 1) });

  // The runtime's own claims, blowing past the camera.
  if (local < 5.8) FACTS.forEach((fact, i) => {
    const r = D.rng(1300 + i * 61);
    const age = (t * 0.55 + i / FACTS.length) % 1;
    const z = 0.12 + age * 1.55;
    const a = r() * Math.PI * 2;
    const px = cx + Math.cos(a) * W * 0.42 * z;
    const py = cy + Math.sin(a) * H * 0.4 * z;
    if (age > 0.9 || px < 200 || px > W - 200 || py < 80 || py > H - 220) return;
    D.text(ctx, fact, px, py, {
      t, seed: 1310 + i, font: at(MONO, 18 + z * 42), color: i % 3 === 0 ? D.CYAN : "rgba(225,235,255,.85)",
      align: "center", alpha: Math.min(1, age * 3) * (1 - age) * 1.6, shake: 1.6, tracking: 2,
    });
  });

  // Bars 30-31: the roll. Slice the frame and shake it apart.
  if (local >= 6) {
    const heat = (local - 6) / 2;
    const rate = 6 + heat * 26;
    const r = D.rng(Math.floor(t * rate));
    const strobe = r();
    if (strobe < 0.2 + heat * 0.35) {
      ctx.save();
      ctx.globalAlpha = 0.5 + heat * 0.45;
      ctx.fillStyle = strobe < 0.1 ? "#ffffff" : D.HUES[Math.floor(strobe * 30) % 3];
      ctx.fillRect(0, 0, W, H);
      ctx.restore();
    }
    for (let i = 0; i < 9; i++) {
      const sliceY = r() * H;
      const sliceH = 12 + r() * (30 + heat * 120);
      const shift = (r() - 0.5) * (40 + heat * 340);
      ctx.drawImage(ctx.canvas, 0, sliceY, W, sliceH, shift, sliceY, W, sliceH);
    }
  }
}

// 32 -> 48 : the chorus. Eight shots, two bars each.
const CHORUS_SHOTS = [pour, flock, palm, wall, leap, oldScreen, drawLine, wideOut];

/** Every chorus shot sits on the same ground and takes the same hit on one. */
function chorusBackdrop(ctx, t, c, top, bottom, splash = 1) {
  wash(ctx, top, bottom);
  const hit = c.barPulse * splash;
  if (hit < 0.02) return;
  // Torn paint in the corners, not a flash over the whole frame: the hit is
  // meant to be felt at the edge of the eye while the shot stays readable.
  const hue = D.HUES[c.barIndex % 3];
  for (let i = 0; i < 4; i++) {
    const r = D.rng(5100 + i * 37 + c.barIndex * 13);
    const cx = i % 2 === 0 ? -60 : W + 60;
    const cy = i < 2 ? -40 : H + 40;
    const reach = (240 + r() * 300) * hit;
    const pts = [];
    for (let k = 0; k <= 10; k++) {
      const a = (k / 10) * Math.PI * 2;
      pts.push([cx + Math.cos(a) * reach * (0.6 + r() * 0.9), cy + Math.sin(a) * reach * (0.6 + r() * 0.9)]);
    }
    D.blob(ctx, pts, { t, seed: 5200 + i, color: hue, alpha: 0.5 * hit, wobble: 18 });
  }
}

// "Put a sky in your pocket" — the device tipped over, the sky running out of it.
function pour(ctx, t, c, u) {
  chorusBackdrop(ctx, t, c, "#050d33", "#132a7a");
  const mx = W * 0.17;
  const my = H * 0.6;
  ctx.save();
  ctx.beginPath();
  ctx.moveTo(mx - 30, my + 70);
  ctx.lineTo(mx + 30, my - 70);
  ctx.lineTo(W * 1.15, -H * 0.4);
  ctx.lineTo(W * 1.15, H * 1.15);
  ctx.closePath();
  ctx.clip();
  const g = ctx.createLinearGradient(mx, my, W, H * 0.1);
  g.addColorStop(0, "#5b8cff");
  g.addColorStop(0.55, "#2b56c8");
  g.addColorStop(1, "#16308a");
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, W, H);
  for (let i = 0; i < 11; i++) {
    const r = D.rng(2100 + i * 47);
    const age = (t * 0.34 + i / 11) % 1;
    const spread = (r() - 0.5) * 1.5;
    const px = D.lerp(mx, W * 1.15, age);
    const py = D.lerp(my, H * 0.36, age) + spread * age * H * 0.6;
    D.cloud(ctx, px, py, (70 + r() * 120) * (0.35 + age * 1.5), {
      t, seed: 2110 + i, color: D.INK, fill: "rgba(246,249,255,.88)", width: 5, alpha: Math.min(1, age * 4),
    });
  }
  for (let i = 0; i < 13; i++) {
    const r = D.rng(2200 + i * 59);
    const age = (t * 0.46 + i / 13) % 1;
    const spread = (r() - 0.5) * 1.6;
    D.bird(ctx,
      D.lerp(mx + 40, W * 1.1, age),
      D.lerp(my - 20, H * 0.34, age) + spread * age * H * 0.62,
      (14 + r() * 26) * (0.4 + age * 1.6), t * 9 + i,
      { t, seed: 2210 + i, color: D.INK, width: 4 + age * 5, alpha: Math.min(1, age * 4) });
  }
  ctx.restore();

  D.burst(ctx, mx, my, 120, 520, 18, {
    t, seed: 2310, color: "rgba(226,238,255,.5)", width: 5, alpha: 0.3 + c.pulse * 0.45,
  });
  ctx.save();
  ctx.translate(mx, my);
  ctx.rotate(-0.78 + u * 0.16);
  D.device(ctx, 0, 0, 11.5, { t, seed: 2300, color: D.INK, screen: D.SKY, lit: 1 });
  ctx.restore();
}

// "Carry it anywhere" — open sky, the flock crossing it.
function flock(ctx, t, c, u) {
  chorusBackdrop(ctx, t, c, "#12338f", "#8fb8ff");
  D.ellipse(ctx, W * 0.5, H * 0.44, 300, 300, {
    t, seed: 2400, color: "rgba(255,255,255,.8)", fill: "rgba(255,253,235,.62)", width: 7,
  });
  for (let i = 0; i < 5; i++) {
    const r = D.rng(2450 + i * 53);
    const span = W + 900;
    const x = (((i / 5) * span + t * (26 + r() * 40)) % span) - 420;
    D.cloud(ctx, x, H * (0.16 + r() * 0.5), 230 + r() * 300, {
      t, seed: 2460 + i, color: D.INK, fill: "rgba(246,249,255,.5)", width: 6, alpha: 0.75,
    });
  }
  for (let layer = 0; layer < 3; layer++) {
    const scale = 0.5 + layer * 0.55;
    const speed = 130 + layer * 260;
    for (let i = 0; i < 10; i++) {
      const r = D.rng(2500 + layer * 31 + i * 17);
      const span = W + 800;
      const x = (((i / 10 + r() * 0.08) * span + t * speed) % span) - 380;
      const y = H * (0.12 + r() * 0.62) + Math.sin(t * 2 + i) * 26 * scale;
      D.bird(ctx, x, y, (30 + r() * 26) * scale, t * (7 + layer * 2.4) + i, {
        t, seed: 2510 + layer * 20 + i, color: layer === 2 ? D.DEEP : layer === 1 ? "rgba(10,20,64,.8)" : "rgba(20,40,120,.55)",
        width: 3 + layer * 3.5, alpha: 0.55 + layer * 0.22,
      });
    }
  }
  const gy = H * 0.88;
  D.line(ctx, -40, gy, W + 40, gy, { t, seed: 2600, color: D.DEEP, width: 7, step: 110, wobble: 5 });
  for (let i = 0; i < 9; i++) {
    const r = D.rng(2700 + i * 23);
    D.device(ctx, W * (0.06 + i * 0.11) + Math.sin(t * 0.4 + i) * 10, gy - 36, 2.6 + r() * 1.2, {
      t, seed: 2710 + i, color: D.DEEP, screen: D.HUES[(i + Math.floor(c.beat)) % 3], lit: 1,
    });
  }
}

// "The universe in your palm" — two hands, and a world made of pixels above them.
function palm(ctx, t, c, u) {
  chorusBackdrop(ctx, t, c, "#050c31", "#152c85");
  const cx = W * 0.5;
  const cy = H * 0.42;
  const rad = 292 + c.pulse * 18;
  const glow = ctx.createRadialGradient(cx, cy, 30, cx, cy, rad * 2.6);
  glow.addColorStop(0, "rgba(127,176,255,.5)");
  glow.addColorStop(1, "rgba(127,176,255,0)");
  ctx.fillStyle = glow;
  ctx.fillRect(0, 0, W, H);

  // The globe: one pixel per cell of the disc, shaded by the surface normal at
  // that cell, so it turns like a sphere instead of sliding like a texture.
  const cell = 14;
  const spin = t * 0.55;
  for (let py = -rad; py <= rad; py += cell) {
    for (let px = -rad; px <= rad; px += cell) {
      const d2 = px * px + py * py;
      if (d2 > rad * rad) continue;
      const nx = px / rad;
      const ny = py / rad;
      const nz = Math.sqrt(Math.max(0, 1 - nx * nx - ny * ny));
      const lon = Math.atan2(nx, nz) + spin;
      const lat = Math.asin(D.clamp(ny, -1, 1));
      const land = Math.sin(lon * 2.1 + Math.sin(lat * 3.3) * 1.5) * 0.6
        + Math.sin(lon * 3.9 - lat * 2.4) * 0.38
        + Math.cos(lat * 4.3 + lon * 1.2) * 0.32;
      const lit = D.clamp(nx * -0.42 + ny * -0.48 + nz * 0.77, 0, 1);
      const city = land > 0.2 && D.rng(Math.round(lon * 40) * 131 + Math.round(lat * 40) * 17)() < 0.1;
      ctx.globalAlpha = 0.35 + lit * 0.65;
      ctx.fillStyle = city ? D.HUES[Math.round(Math.abs(land) * 30) % 3]
        : land > 0.2 ? D.SKY : land > -0.1 ? D.BLUE_MID : "#16308a";
      ctx.fillRect(Math.round(cx + px), Math.round(cy + py), cell - 2, cell - 2);
    }
  }
  ctx.globalAlpha = 1;
  D.ellipse(ctx, cx, cy, rad, rad, { t, seed: 2800, color: D.INK, width: 5, alpha: 0.85 });
  for (let i = 0; i < 26; i++) {
    const a = (i / 26) * Math.PI * 2 + t * 1.3;
    const orb = rad * 1.45;
    ctx.fillStyle = D.HUES[i % 3];
    ctx.globalAlpha = 0.5 + 0.5 * Math.sin(a);
    ctx.fillRect(cx + Math.cos(a) * orb - 4, cy + Math.sin(a) * orb * 0.36 - 4, 9, 9);
  }
  ctx.globalAlpha = 1;

  const cup = (dir, seed) => {
    ctx.save();
    ctx.translate(cx + dir * 268, H * 1.05);
    ctx.scale(dir, 1);
    hand(ctx, 0, 0, 520, 0.82, { t, seed, color: D.INK, fill: "#0c1a52", curl: 0.5 });
    ctx.restore();
  };
  cup(-1, 2900);
  cup(1, 2910);
}

// "Small to nobody" — every screen the runtime reaches, at once.
function wall(ctx, t, c, u) {
  chorusBackdrop(ctx, t, c, "#050c2e", "#101f63");
  deviceWall(ctx, t, c);
  D.text(ctx, "ONE RUNTIME", W * 0.5, 82, {
    t, seed: 3000, font: at(PIXEL, 52), color: "rgba(226,236,255,.8)", align: "center", tracking: 12, shake: 1.2,
  });
}

// "Just say that you love it" — the leap.
function leap(ctx, t, c, u) {
  chorusBackdrop(ctx, t, c, "#081446", "#24429f");
  D.ellipse(ctx, W * 0.5, H * 0.5, 400, 400, {
    t, seed: 3100, color: null, fill: "#f2f5ff", alpha: 0.95,
  });
  ctx.save();
  ctx.beginPath();
  ctx.arc(W * 0.5, H * 0.5, 396, 0, Math.PI * 2);
  ctx.clip();
  D.hatch(ctx, W * 0.5 - 400, H * 0.5 - 400, 800, 800, {
    t, seed: 3110, color: "rgba(30,60,160,.22)", gap: 26, angle: 0.7, width: 3,
  });
  ctx.restore();
  D.burst(ctx, W * 0.5, H * 0.5, 420, 1100, 30, {
    t, seed: 3120, color: "rgba(226,236,255,.4)", width: 4, alpha: 0.4 + c.pulse * 0.3,
  });
  const x = D.lerp(W * 0.16, W * 0.86, u);
  const y = H * 0.9 - Math.sin(u * Math.PI) * H * 0.22;
  // A leap is one pose held, not a run sampled: pin the stride open and let
  // only the boil move it.
  D.runner(ctx, x, y, H * 0.44, Math.PI * 0.5 + Math.sin(t * 3) * 0.12, { t, seed: 3130, color: "#07112f", lift: 1 });
  D.device(ctx, x - 168, y - H * 0.47, 4.6, { t, seed: 3140, color: "#07112f", screen: D.YELLOW, lit: 1 });
}

// "In front of an old screen" — the shot the whole film is an argument for.
function oldScreen(ctx, t, c, u) {
  chorusBackdrop(ctx, t, c, "#03081f", "#0c1746", 0.18);
  const sx = W * 0.18;
  const sy = H * 0.12;
  const sw = W * 0.64;
  const sh = H * 0.56;
  const glow = ctx.createRadialGradient(W * 0.5, sy + sh * 0.5, 60, W * 0.5, sy + sh * 0.5, sw);
  glow.addColorStop(0, "rgba(91,140,255,.45)");
  glow.addColorStop(1, "rgba(91,140,255,0)");
  ctx.fillStyle = glow;
  ctx.fillRect(0, 0, W, H);
  miniSky(ctx, sx, sy, sw, sh, t, 1, 23);
  pixelScreen(ctx, sx, sy, sw, sh, t, 0.86, 29);
  // Scanlines, because the screen it is drawn on had them.
  ctx.save();
  ctx.globalAlpha = 0.22;
  ctx.fillStyle = "#000";
  for (let y = sy; y < sy + sh; y += 6) ctx.fillRect(sx, y, sw, 3);
  ctx.restore();
  D.rect(ctx, sx - 26, sy - 26, sw + 52, sh + 52, {
    t, seed: 3200, radius: 40, color: D.INK, width: 7, wobble: 3,
  });
  // Someone sitting in front of it, back to us.
  D.blob(ctx, [
    [W * 0.5 - 190, H], [W * 0.5 - 150, H * 0.86], [W * 0.5 - 60, H * 0.78],
    [W * 0.5 + 60, H * 0.78], [W * 0.5 + 150, H * 0.86], [W * 0.5 + 190, H],
  ], { t, seed: 3210, color: "#03081f", wobble: 6 });
  D.ellipse(ctx, W * 0.5, H * 0.75, 86, 92, { t, seed: 3220, color: "#03081f", fill: "#03081f", width: 5 });
}

// "We can still draw. From here." — the line being laid down, live.
function drawLine(ctx, t, c, u) {
  chorusBackdrop(ctx, t, c, "#0a1a5e", "#2a51c6");
  const gy = H * 0.66;
  const px = D.lerp(W * 0.06, W * 0.96, D.easeOut(u));
  ctx.save();
  ctx.beginPath();
  ctx.rect(0, 0, px, H);
  ctx.clip();
  const g = ctx.createLinearGradient(0, 0, 0, gy);
  g.addColorStop(0, "#1a3ea8");
  g.addColorStop(1, "#a8ccff");
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, W, gy);
  for (let i = 0; i < 5; i++) {
    const r = D.rng(3300 + i * 41);
    D.cloud(ctx, W * (0.08 + i * 0.2) + Math.sin(t * 0.5 + i) * 18, H * (0.18 + r() * 0.26), 180 + r() * 180, {
      t, seed: 3310 + i, color: D.INK, fill: "rgba(245,248,255,.28)", width: 6,
    });
  }
  for (let i = 0; i < 6; i++) {
    const r = D.rng(3400 + i * 29);
    D.bird(ctx, W * (0.1 + i * 0.16) + ((t * 60) % 300), H * (0.2 + r() * 0.2), 24 + r() * 22, t * 8 + i, {
      t, seed: 3410 + i, color: D.INK, width: 5,
    });
  }
  ctx.restore();
  D.line(ctx, W * 0.06, gy, px, gy + Math.sin(u * 5) * 6, {
    t, seed: 3500, color: D.DEEP, width: 16, step: 80, wobble: 6,
  });
  hand(ctx, px + 40, gy + 120, 260, -0.5, { t, seed: 3510, color: D.INK, fill: "rgba(10,26,94,.9)" });
  D.stroke(ctx, [[px + 10, gy + 4], [px + 120, gy + 130]], {
    t, seed: 3520, color: D.YELLOW, width: 12, wobble: 2, step: 60,
  });
}

// "On a night the colour of lapis" — all the way out.
function wideOut(ctx, t, c, u) {
  chorusBackdrop(ctx, t, c, "#061034", "#1b3690", 0.5);
  const pull = D.lerp(1.5, 1, D.easeOut(u));
  ctx.save();
  ctx.translate(W / 2, H * 0.6);
  ctx.scale(pull, pull);
  ctx.translate(-W / 2, -H * 0.6);
  for (let i = 0; i < 260; i++) {
    const r = D.rng(3600 + i * 13);
    const x = (((i * 137.5) % 100) / 100) * W + (r() - 0.5) * 34;
    const y = r() * H * 0.82;
    const s = 2 + Math.floor(r() * 3) * 2;
    ctx.globalAlpha = 0.25 + 0.75 * Math.abs(Math.sin(t * (0.6 + r()) + i));
    ctx.fillStyle = r() < 0.16 ? D.HUES[Math.floor(r() * 3)] : D.INK;
    ctx.fillRect(Math.round(x), Math.round(y), s, s);
  }
  ctx.globalAlpha = 1;
  for (let i = 0; i < 5; i++) {
    const r = D.rng(3650 + i * 29);
    D.cloud(ctx, W * (0.1 + i * 0.2) + Math.sin(t * 0.3 + i) * 24, H * (0.52 + r() * 0.16), 200 + r() * 210, {
      t, seed: 3660 + i, color: "rgba(180,205,255,.35)", width: 4, alpha: 0.6,
    });
  }
  const gy = H * 0.84;
  D.line(ctx, -60, gy, W + 60, gy, { t, seed: 3700, color: "rgba(200,220,255,.75)", width: 5, step: 140, wobble: 7 });
  const cx = W * 0.5;
  const cy = gy - 52;
  const glow = ctx.createRadialGradient(cx, cy, 8, cx, cy, 300);
  glow.addColorStop(0, "rgba(255,210,63,.45)");
  glow.addColorStop(1, "rgba(255,210,63,0)");
  ctx.fillStyle = glow;
  ctx.fillRect(0, 0, W, H);
  D.device(ctx, cx, cy, 3.4, { t, seed: 3710, color: D.INK, screen: D.YELLOW, lit: 1 });
  ctx.restore();
  const flash = D.ramp(u, 0.9, 1);
  if (flash > 0) {
    ctx.fillStyle = `rgba(255,255,255,${flash * 0.85})`;
    ctx.fillRect(0, 0, W, H);
  }
}

function sceneChorus(ctx, t, c) {
  const local = c.bar - 32;
  const shot = D.clamp(Math.floor(local / 2), 0, 7);
  CHORUS_SHOTS[shot](ctx, t, c, D.clamp((local - shot * 2) / 2, 0, 1));
}

// 48 -> 56 : one device on a wide field, and the name.
function sceneOutro(ctx, t, c) {
  const local = c.bar - 48;
  wash(ctx, "#050b2c", "#122468");
  currents(ctx, t, "rgba(120,160,255,.28)", 10, 0.4);
  motes(ctx, t, 110, 0.6, 22);

  const gy = H * 0.76;
  D.line(ctx, -40, gy, W + 40, gy, { t, seed: 1500, color: "rgba(200,220,255,.7)", width: 5, step: 120, wobble: 6 });
  const cx = W * 0.5;
  const cy = gy - 96;
  const glow = ctx.createRadialGradient(cx, cy, 10, cx, cy, 420);
  glow.addColorStop(0, "rgba(255,210,63,.3)");
  glow.addColorStop(1, "rgba(255,210,63,0)");
  ctx.fillStyle = glow;
  ctx.fillRect(0, 0, W, H);
  D.device(ctx, cx, cy, 6.2, { t, seed: 1510, color: D.INK, screen: "#1d3ba6", lit: 1 });
  miniSky(ctx, cx - 78, cy - 54, 156, 108, t, 1, 17);

  const wr = D.ramp(local, 1.5, 3.4);
  if (wr > 0) {
    D.text(ctx, "PocketJS", cx, H * 0.34, {
      t, seed: 1520, font: at(EN, 118), color: D.INK, align: "center", tracking: 4, alpha: wr, shake: 1.6,
    });
    D.line(ctx, cx - 250, H * 0.37, cx - 250 + 500 * wr, H * 0.37, { t, seed: 1521, color: D.YELLOW, width: 5 });
    D.text(ctx, "TypeScript apps. Native pixels. No DOM.", cx, H * 0.425, {
      t, seed: 1522, font: at(EN, 34), color: "rgba(230,238,255,.82)", align: "center",
      tracking: 5, alpha: D.ramp(local, 2.6, 4), shake: 1,
    });
    D.text(ctx, "pocketjs.dev", cx, H * 0.9, {
      t, seed: 1523, font: at(MONO, 42), color: D.CYAN, align: "center",
      tracking: 6, alpha: D.ramp(local, 4, 5.4), shake: 1.2,
    });
  }
  const fade = D.ramp(local, 6.4, 8);
  if (fade > 0) {
    ctx.fillStyle = `rgba(5,11,44,${fade})`;
    ctx.fillRect(0, 0, W, H);
  }
}

// --------------------------------------------------------------- lyrics

function drawLyric(ctx, t, c) {
  const line = lyricAt(c.bar);
  if (!line) return;
  const since = c.bar - line.bar;
  const inUp = D.ramp(since, 0, 0.32);
  const out = 1 - D.ramp(since, line.bars - 0.3, line.bars);
  const alpha = inUp * out;
  if (alpha <= 0.01) return;
  const slam = !!line.slam;
  const onPaper = c.bar >= SECTIONS.verse1.from && c.bar < SECTIONS.verse1.to;
  const size = slam ? 98 : 58;
  const y = slam ? H * 0.56 : H * 0.855;
  const rise = (1 - inUp) * (slam ? 40 : 22);
  const font = slam ? at(JA_BLACK, size) : at(JA, size);

  ctx.save();
  if (!slam) {
    const g = ctx.createLinearGradient(0, H * 0.7, 0, H);
    g.addColorStop(0, onPaper ? "rgba(236,234,223,0)" : "rgba(4,9,36,0)");
    g.addColorStop(1, onPaper ? "rgba(236,234,223,.78)" : "rgba(4,9,36,.55)");
    ctx.fillStyle = g;
    ctx.globalAlpha = alpha;
    ctx.fillRect(0, H * 0.7, W, H * 0.3);
  }
  ctx.restore();

  if (slam) {
    ctx.save();
    ctx.font = font;
    const tw = D.measure(ctx, line.ja, 10);
    ctx.restore();
    ctx.save();
    ctx.globalAlpha = alpha * 0.9;
    ctx.fillStyle = D.HUES[Math.floor(since * 2 + line.bar) % 3];
    ctx.fillRect(W / 2 - tw / 2 - 40, y - size * 0.86, (tw + 80) * D.easeOut(D.ramp(since, 0, 0.22)), size * 1.28);
    ctx.restore();
    D.text(ctx, line.ja, W / 2, y + rise, {
      t, seed: 1600 + line.bar, font, color: "#08123f", align: "center", tracking: 10, alpha, shake: 2.4,
    });
  } else {
    D.text(ctx, line.ja, W / 2, y + rise, {
      t, seed: 1600 + line.bar, font,
      color: line.code ? D.CYAN : onPaper ? D.BLUE : D.INK,
      align: "center", tracking: 6, alpha, shake: 1.6,
    });
  }
  D.text(ctx, line.en, W / 2, (slam ? y + size * 0.86 : y + 46) + rise * 0.5, {
    t, seed: 1700 + line.bar, font: at(EN, slam ? 34 : 28),
    color: slam ? "rgba(240,244,255,.95)" : onPaper ? "rgba(20,39,110,.7)" : "rgba(214,226,255,.78)",
    align: "center", tracking: slam ? 5 : 3, alpha: alpha * 0.95, shake: 1, passes: 1,
  });
}

// --------------------------------------------------------------- the frame

let tile = null;
let paperTile = null;

/**
 * Paint the film at time `t` (seconds from the first downbeat).
 * `make(w, h)` returns a blank offscreen canvas; the grain is built from it
 * once and cached.
 */
export function drawFrame(ctx, t, make) {
  const c = clock(D.clamp(t, 0, DURATION + 2));
  if (!tile) tile = D.grainTile(make, 320, 7, 0.55, "255,255,255");
  if (!paperTile) paperTile = D.grainTile(make, 320, 19, 0.6, "20,39,110");

  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.fillStyle = D.DEEP;
  ctx.fillRect(0, 0, W, H);

  // Camera: a hand-held drift, plus a punch on the beat once the drums land.
  const r = D.rng(D.boil(t));
  const punch = c.bar >= 32 ? c.barPulse * 0.012 : c.bar >= 8 ? c.barPulse * 0.005 : 0;
  ctx.save();
  ctx.translate(W / 2, H / 2);
  ctx.scale(1 + punch, 1 + punch);
  ctx.translate(-W / 2 + D.rnd2(r) * 3, -H / 2 + D.rnd2(r) * 3);

  const bar = c.bar;
  const paper = bar >= 8 && bar < 16;
  if (bar < 8) sceneIntro(ctx, t, c);
  else if (bar < 16) sceneDesk(ctx, t, c);
  else if (bar < 24) sceneRun(ctx, t, c);
  else if (bar < 32) scenePre(ctx, t, c);
  else if (bar < 48) sceneChorus(ctx, t, c);
  else sceneOutro(ctx, t, c);

  drawLyric(ctx, t, c);
  ctx.restore();

  D.grain(ctx, W, H, t, paper ? paperTile : tile, paper ? 0.4 : 0.34);
  D.vignette(ctx, W, H, paper ? 0.2 : 0.5, paper ? "80,80,60" : "4,8,34");

  // Section doors get one frame of white.
  for (const door of [8, 16, 24, 32, 40, 48]) {
    const d = (t - door * BAR) / BAR;
    if (d >= 0 && d < 0.12) {
      ctx.fillStyle = `rgba(255,255,255,${(1 - d / 0.12) * 0.55})`;
      ctx.fillRect(0, 0, W, H);
    }
  }
}
