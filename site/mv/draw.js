// site/mv/draw.js — the drawing toolkit the film is made of.
//
// Every mark is a rough stroke: the same path re-drawn two or three times with
// its points pushed around by a seeded random walk. Seeding that walk from
// Math.floor(t * BOIL) instead of the frame number is what gives the picture
// its hand-drawn boil — the line redraws eight times a second and holds in
// between, the way inked frames on twos do, and the number of video frames a
// hold spans never changes the look.
//
// Nothing here keeps state between calls. Give draw.js and film.js the same t
// and you get the same pixels, which is what lets tools/render-mv.ts capture
// frames out of real time.

export const BOIL = 8; // stroke redraws per second

// ------------------------------------------------------------------ palette

export const INK = "#eef2ff";
export const DEEP = "#0a1440";
export const BLUE = "#14276e";
export const BLUE_MID = "#2b56c8";
export const BLUE_LIT = "#5b8cff";
export const SKY = "#7fb0ff"; // the pale blue a lit screen resolves to
export const PAPER = "#f2f0e6";
export const YELLOW = "#ffd23f";
export const PINK = "#ff5f9e";
export const CYAN = "#3fd0e8";
export const HUES = [YELLOW, PINK, CYAN];

// ------------------------------------------------------------------ random

/** xorshift — one seed in, the same sequence out, in every renderer. */
export function rng(seed) {
  let x = (seed | 0) || 0x9e3779b9;
  const step = () => {
    x ^= x << 13; x >>>= 0;
    x ^= x >> 17;
    x ^= x << 5; x >>>= 0;
    return x / 0x100000000;
  };
  // Neighbouring seeds agree on their first few outputs, which lands every
  // cloud in a stack and every star on one diagonal. Burn them.
  step(); step(); step();
  return step;
}

/** A signed random in [-1, 1]. */
export const rnd2 = (r) => r() * 2 - 1;

/** The stroke seed for time t: holds for 1/BOIL of a second. */
export const boil = (t) => Math.floor(t * BOIL) * 2654435761;

export const lerp = (a, b, u) => a + (b - a) * u;
export const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
/** 0 before `from`, 1 after `to`, smoothed in between. */
export function ramp(x, from, to) {
  const u = clamp((x - from) / (to - from || 1e-6), 0, 1);
  return u * u * (3 - 2 * u);
}
export const easeOut = (u) => 1 - Math.pow(1 - clamp(u, 0, 1), 3);
export const easeIn = (u) => Math.pow(clamp(u, 0, 1), 3);

// ------------------------------------------------------------------ strokes

/** Resample a polyline so long straights carry as much wobble as short ones. */
function resample(pts, step) {
  const out = [pts[0]];
  for (let i = 1; i < pts.length; i++) {
    const [x0, y0] = pts[i - 1];
    const [x1, y1] = pts[i];
    const d = Math.hypot(x1 - x0, y1 - y0);
    const n = Math.max(1, Math.round(d / step));
    for (let k = 1; k <= n; k++) out.push([lerp(x0, x1, k / n), lerp(y0, y1, k / n)]);
  }
  return out;
}

function traceSmooth(ctx, pts, closed) {
  ctx.beginPath();
  ctx.moveTo(pts[0][0], pts[0][1]);
  for (let i = 1; i < pts.length - 1; i++) {
    const [x, y] = pts[i];
    const [nx, ny] = pts[i + 1];
    ctx.quadraticCurveTo(x, y, (x + nx) / 2, (y + ny) / 2);
  }
  const last = pts[pts.length - 1];
  ctx.lineTo(last[0], last[1]);
  if (closed) ctx.closePath();
}

/**
 * The one stroke primitive. `o.seed` identifies the mark, `o.t` is the time
 * that decides its boil, and everything else is taste.
 */
export function stroke(ctx, pts, o = {}) {
  if (pts.length < 2) return;
  const {
    t = 0, seed = 1, color = INK, width = 4, passes = 2,
    wobble = 2.6, alpha = 1, closed = false, step = 26, taper = true,
  } = o;
  const dense = resample(pts, step);
  ctx.save();
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  ctx.strokeStyle = color;
  for (let p = 0; p < passes; p++) {
    const r = rng(seed * 2246822519 + p * 374761393 + boil(t));
    const drift = wobble * (0.6 + p * 0.5);
    let ox = rnd2(r) * drift * 0.7;
    let oy = rnd2(r) * drift * 0.7;
    const jittered = dense.map(([x, y], i) => {
      ox = ox * 0.72 + rnd2(r) * drift * 0.5;
      oy = oy * 0.72 + rnd2(r) * drift * 0.5;
      const ends = taper ? Math.min(1, Math.min(i, dense.length - 1 - i) / 3 + 0.35) : 1;
      return [x + ox * ends, y + oy * ends];
    });
    ctx.globalAlpha = alpha * (p === 0 ? 1 : 0.55);
    ctx.lineWidth = width * (p === 0 ? 1 : 0.62) * (0.85 + r() * 0.3);
    traceSmooth(ctx, jittered, closed);
    ctx.stroke();
  }
  ctx.restore();
}

/** A filled shape whose edge wanders the same way a stroke does. */
export function blob(ctx, pts, o = {}) {
  const { t = 0, seed = 1, color = INK, alpha = 1, wobble = 4, closed = true } = o;
  const dense = resample(pts, 30);
  const r = rng(seed * 2654435761 + boil(t));
  let ox = 0, oy = 0;
  const jittered = dense.map(([x, y]) => {
    ox = ox * 0.7 + rnd2(r) * wobble * 0.55;
    oy = oy * 0.7 + rnd2(r) * wobble * 0.55;
    return [x + ox, y + oy];
  });
  ctx.save();
  ctx.globalAlpha = alpha;
  ctx.fillStyle = color;
  traceSmooth(ctx, jittered, closed);
  ctx.fill();
  ctx.restore();
}

export function line(ctx, x0, y0, x1, y1, o) {
  stroke(ctx, [[x0, y0], [x1, y1]], o);
}

export function ellipse(ctx, cx, cy, rx, ry, o = {}) {
  const n = o.sides ?? 34;
  const rot = o.rot ?? 0;
  const pts = [];
  for (let i = 0; i <= n; i++) {
    const a = (i / n) * Math.PI * 2 + rot;
    pts.push([cx + Math.cos(a) * rx, cy + Math.sin(a) * ry]);
  }
  if (o.fill) blob(ctx, pts, { ...o, color: o.fill });
  if (o.color !== null) stroke(ctx, pts, { ...o, closed: false });
}

export function rect(ctx, x, y, w, h, o = {}) {
  const rad = o.radius ?? 0;
  const pts = [];
  const corner = (cx, cy, a0) => {
    for (let i = 0; i <= 5; i++) {
      const a = a0 + (i / 5) * (Math.PI / 2);
      pts.push([cx + Math.cos(a) * rad, cy + Math.sin(a) * rad]);
    }
  };
  if (rad > 0) {
    corner(x + w - rad, y + rad, -Math.PI / 2);
    corner(x + w - rad, y + h - rad, 0);
    corner(x + rad, y + h - rad, Math.PI / 2);
    corner(x + rad, y + rad, Math.PI);
    pts.push(pts[0]);
  } else {
    pts.push([x, y], [x + w, y], [x + w, y + h], [x, y + h], [x, y]);
  }
  if (o.fill) blob(ctx, pts, { ...o, color: o.fill, wobble: o.wobble ?? 2.5 });
  if (o.color !== null) stroke(ctx, pts, o);
}

/** Pencil shading: parallel strokes clipped to whatever the caller just set. */
export function hatch(ctx, x, y, w, h, o = {}) {
  const { t = 0, seed = 5, color = INK, alpha = 0.35, gap = 22, angle = -0.5, width = 2.4 } = o;
  const r = rng(seed * 40503 + boil(t));
  const len = Math.hypot(w, h);
  const dx = Math.cos(angle) * len;
  const dy = Math.sin(angle) * len;
  const nx = -Math.sin(angle);
  const ny = Math.cos(angle);
  const cx = x + w / 2;
  const cy = y + h / 2;
  ctx.save();
  ctx.beginPath();
  ctx.rect(x, y, w, h);
  ctx.clip();
  for (let d = -len / 2; d < len / 2; d += gap) {
    const jd = d + rnd2(r) * gap * 0.25;
    stroke(ctx, [
      [cx + nx * jd - dx / 2, cy + ny * jd - dy / 2],
      [cx + nx * jd + dx / 2, cy + ny * jd + dy / 2],
    ], { t, seed: seed * 31 + d, color, alpha, width, passes: 1, wobble: 3.2, step: 60 });
  }
  ctx.restore();
}

// ------------------------------------------------------------------ texture

const tiles = new Map();

/**
 * A noise tile, built once and reused: the paper the film is drawn on. The
 * noise is laid in `block`-sized squares rather than single pixels — paper
 * tooth is not one pixel wide, and per-pixel noise redrawn eight times a second
 * costs an h264 encoder more bitrate than the rest of the film put together.
 */
export function grainTile(make, size = 320, seed = 7, density = 0.5, color = "0,0,0", block = 2) {
  const key = `${size}:${seed}:${density}:${color}:${block}`;
  const hit = tiles.get(key);
  if (hit) return hit;
  const c = make(size, size);
  const g = c.getContext("2d");
  const r = rng(seed);
  for (let y = 0; y < size; y += block) {
    for (let x = 0; x < size; x += block) {
      const v = r();
      if (v >= density) continue;
      g.fillStyle = `rgba(${color},${(v * 0.35).toFixed(3)})`;
      g.fillRect(x, y, block, block);
    }
  }
  tiles.set(key, c);
  return c;
}

/** Lay the grain over the frame, sliding it so the texture crawls. */
export function grain(ctx, W, H, t, tile, alpha = 0.5) {
  const r = rng(boil(t));
  const ox = Math.floor(r() * tile.width);
  const oy = Math.floor(r() * tile.height);
  ctx.save();
  ctx.globalAlpha = alpha;
  const pat = ctx.createPattern(tile, "repeat");
  ctx.fillStyle = pat;
  ctx.translate(-ox, -oy);
  ctx.fillRect(0, 0, W + tile.width, H + tile.height);
  ctx.restore();
}

export function vignette(ctx, W, H, strength = 0.55, color = "6,10,36") {
  const g = ctx.createRadialGradient(W / 2, H / 2, H * 0.28, W / 2, H / 2, H * 0.92);
  g.addColorStop(0, `rgba(${color},0)`);
  g.addColorStop(1, `rgba(${color},${strength})`);
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, W, H);
}

// ------------------------------------------------------------------ type

/**
 * Type drawn like everything else: the same string set three times, a hair
 * apart, so the edges never sit perfectly still.
 */
export function text(ctx, str, x, y, o = {}) {
  const {
    t = 0, seed = 3, font = "700 64px sans-serif", color = INK, align = "left",
    baseline = "alphabetic", alpha = 1, shake = 1.4, passes = 2, tracking = 0,
  } = o;
  ctx.save();
  ctx.font = font;
  ctx.textAlign = tracking ? "left" : align;
  ctx.textBaseline = baseline;
  ctx.fillStyle = color;
  let px = x;
  if (tracking) {
    const w = measure(ctx, str, tracking);
    px = align === "center" ? x - w / 2 : align === "right" ? x - w : x;
  }
  for (let p = 0; p < passes; p++) {
    const r = rng(seed * 7919 + p * 104729 + boil(t));
    ctx.globalAlpha = alpha * (p === 0 ? 1 : 0.4);
    const ox = rnd2(r) * shake;
    const oy = rnd2(r) * shake;
    if (tracking) {
      let cx = px;
      for (const ch of str) {
        ctx.fillText(ch, cx + ox + rnd2(r) * shake * 0.6, y + oy + rnd2(r) * shake * 0.6);
        cx += ctx.measureText(ch).width + tracking;
      }
    } else {
      ctx.fillText(str, x + ox, y + oy);
    }
  }
  ctx.restore();
}

export function measure(ctx, str, tracking = 0) {
  let w = 0;
  for (const ch of str) w += ctx.measureText(ch).width + tracking;
  return w - (str.length ? tracking : 0);
}

/** Wipe a drawing on from the left, the way a line is actually laid down. */
export function reveal(ctx, x, y, w, h, u, fn) {
  if (u <= 0) return;
  if (u >= 1) return fn();
  ctx.save();
  ctx.beginPath();
  ctx.rect(x, y, w * easeOut(u), h);
  ctx.clip();
  fn();
  ctx.restore();
}

// ------------------------------------------------------------------ motifs

/**
 * The PocketJS mark, redrawn by hand: body, lens, two keys. Geometry follows
 * site/assets/favicon.svg so the film's device and the site's icon are the
 * same object.
 */
export function device(ctx, cx, cy, scale, o = {}) {
  const { t = 0, seed = 11, color = INK, screen = null, alpha = 1, lit = 0 } = o;
  const u = (n) => n * scale;
  const x = cx - u(14);
  const y = cy - u(10);
  if (screen) {
    ctx.save();
    ctx.globalAlpha = alpha;
    rect(ctx, x + u(1.3), y + u(1.3), u(25.4), u(17.4), {
      t, seed: seed + 2, radius: u(4.7), fill: screen, color: null, wobble: u(0.22),
    });
    ctx.restore();
  }
  rect(ctx, x, y, u(28), u(20), {
    t, seed, radius: u(6), color, width: Math.max(1.6, u(0.9)), alpha, wobble: u(0.2), step: u(3),
  });
  ellipse(ctx, x + u(10), y + u(10), u(3.1), u(3.1), {
    t, seed: seed + 3, color: lit ? PINK : color, fill: lit ? PINK : null,
    width: Math.max(1.2, u(0.7)), alpha, wobble: u(0.18),
  });
  rect(ctx, x + u(16), y + u(6.6), u(10), u(2.2), {
    t, seed: seed + 5, radius: u(1.1), color: lit ? CYAN : color, fill: lit ? CYAN : null,
    width: Math.max(1, u(0.55)), alpha, wobble: u(0.15),
  });
  rect(ctx, x + u(16), y + u(11.2), u(6.5), u(2.2), {
    t, seed: seed + 7, radius: u(1.1), color: lit ? PINK : color, fill: lit ? PINK : null,
    width: Math.max(1, u(0.55)), alpha, wobble: u(0.15),
  });
}

/** A bird made of an angle bracket pair — the flock the chorus flies. */
export function bird(ctx, x, y, span, flap, o = {}) {
  const { t = 0, seed = 21, color = INK, width = 5, alpha = 1 } = o;
  const rise = span * (0.44 + 0.22 * Math.sin(flap));
  stroke(ctx, [
    [x - span, y + rise * 0.18],
    [x - span * 0.48, y - rise],
    [x, y - rise * 0.34],
    [x + span * 0.48, y - rise],
    [x + span, y + rise * 0.18],
  ], { t, seed, color, width, alpha, wobble: span * 0.035, step: span * 0.36, passes: 1 });
}

/** A runner, four rough strokes and a head, legs on a sine. */
export function runner(ctx, x, y, h, phase, o = {}) {
  const { t = 0, seed = 31, color = INK, alpha = 1, lift = 0 } = o;
  const w = Math.max(3, h * 0.035);
  const s = (a, b, k) => stroke(ctx, [a, b], { t, seed: seed + k, color, width: w, alpha, wobble: h * 0.012, step: h * 0.3, passes: 2 });
  const hip = [x, y - h * 0.46];
  const shoulder = [x + h * 0.03, y - h * 0.78];
  const swing = Math.sin(phase);
  const swing2 = Math.sin(phase + Math.PI);
  ellipse(ctx, shoulder[0] + h * 0.02, y - h * 0.88, h * 0.085, h * 0.095, {
    t, seed: seed + 1, color, fill: color, alpha, wobble: h * 0.01,
  });
  s(hip, shoulder, 2);
  // legs
  s(hip, [x + swing * h * 0.2, y - h * 0.22], 3);
  s([x + swing * h * 0.2, y - h * 0.22], [x + swing * h * 0.3 + h * 0.06, y - Math.max(0, swing) * h * 0.04], 4);
  s(hip, [x + swing2 * h * 0.2, y - h * 0.22], 5);
  s([x + swing2 * h * 0.2, y - h * 0.22], [x + swing2 * h * 0.32 - h * 0.04, y - Math.max(0, swing2) * h * 0.05], 6);
  // arms — `lift` swings both of them up and out
  const elbow = h * (0.56 + lift * 0.18);
  const handY = h * (0.68 + lift * 0.42);
  s(shoulder, [x - swing * h * 0.2, y - elbow], 7);
  s([x - swing * h * 0.2, y - elbow], [x - swing * h * 0.1 - h * (0.05 + lift * 0.14), y - handY], 8);
  s(shoulder, [x - swing2 * h * 0.18, y - elbow], 9);
  s([x - swing2 * h * 0.18, y - elbow], [x - swing2 * h * 0.1 + h * (0.04 + lift * 0.16), y - handY], 10);
}

/** A cloud: three overlapping rough lobes with a flat bottom. */
export function cloud(ctx, x, y, w, o = {}) {
  const { t = 0, seed = 41, color = INK, alpha = 1, fill = null, width = 5 } = o;
  const h = w * 0.42;
  const pts = [];
  const lobes = [[-0.42, 0.06, 0.3], [-0.05, -0.2, 0.42], [0.36, 0.02, 0.32]];
  for (let i = 0; i < lobes.length; i++) {
    const [lx, ly, lr] = lobes[i];
    const from = i === 0 ? Math.PI : Math.PI * 1.05;
    for (let k = 0; k <= 12; k++) {
      const a = from + (k / 12) * Math.PI * (i === lobes.length - 1 ? 1.1 : 0.95);
      pts.push([x + w * lx + Math.cos(a) * w * lr, y + h * ly + Math.sin(a) * w * lr * 0.95]);
    }
  }
  pts.push([x + w * 0.62, y + h * 0.3], [x - w * 0.62, y + h * 0.3]);
  if (fill) blob(ctx, pts, { t, seed: seed + 1, color: fill, alpha, wobble: w * 0.012 });
  stroke(ctx, pts, { t, seed, color, width, alpha, wobble: w * 0.012, step: w * 0.09, closed: true });
}

/** A block of pixels, drawn as squares, so the grid is a real grid. */
export function pixels(ctx, x, y, cell, cols, rows, pick, o = {}) {
  const { alpha = 1, gap = 0 } = o;
  ctx.save();
  ctx.globalAlpha = alpha;
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const v = pick(c, r);
      if (!v) continue;
      ctx.fillStyle = typeof v === "string" ? v : v.color;
      const a = typeof v === "string" ? 1 : v.alpha ?? 1;
      ctx.globalAlpha = alpha * a;
      ctx.fillRect(x + c * cell, y + r * cell, cell - gap, cell - gap);
    }
  }
  ctx.restore();
}

/** Radial speed lines from a point — the chorus's punctuation. */
export function burst(ctx, cx, cy, r0, r1, count, o = {}) {
  const { t = 0, seed = 51, color = INK, alpha = 0.8, width = 4 } = o;
  const r = rng(seed * 7717 + boil(t));
  for (let i = 0; i < count; i++) {
    const a = (i / count) * Math.PI * 2 + r() * 0.12;
    const inner = r0 * (0.85 + r() * 0.3);
    const outer = r1 * (0.7 + r() * 0.6);
    stroke(ctx, [
      [cx + Math.cos(a) * inner, cy + Math.sin(a) * inner],
      [cx + Math.cos(a) * outer, cy + Math.sin(a) * outer],
    ], { t, seed: seed + i, color, width, alpha, passes: 1, wobble: 3, step: 90 });
  }
}
