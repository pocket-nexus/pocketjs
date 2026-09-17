#!/usr/bin/env bun
// vapor/scripts/promo/promo.ts — render the Pocket Vapor promo video.
//
//   bun vapor/scripts/promo/capture.ts   # once: gameplay frames
//   bun vapor/scripts/promo/music.ts     # once: the chiptune bed
//   bun vapor/scripts/promo/promo.ts     # → dist/vapor/promo/pocket-vapor.mp4
//
// 1920x1080 @ 60 fps, ~47 s, final cut — no appended end card; the PocketJS
// logo badge rides every frame instead. Frames are drawn with @napi-rs/canvas
// on the PocketJS brand field (dark #05070d, blueprint grid, corner glows) and
// streamed as raw RGBA into ffmpeg, muxed with the synthesized soundtrack.
// The gameplay segment starts exactly on bar 10 of the soundtrack, where the
// lead melody enters — keep promo timeline and music structure in sync.

import { join } from "node:path";
import { createCanvas, type SKRSContext2D } from "@napi-rs/canvas";
import { FRAMES_PER_PRESS, LEAD, pressList, TOTAL_FRAMES } from "./capture.ts";
import { Button } from "../../host/input.ts";

const ROOT = join(import.meta.dir, "..", "..", "..");
const OUT = join(ROOT, "dist", "vapor", "promo");
const W = 1920;
const H = 1080;
const FPS = 60;

// ---- palette (site/outro visual system) -------------------------------------
const FIELD = "#05070d";
const GRID = "rgba(56, 189, 248, 0.055)";
const TEXT = "#f1f5f9";
const DIM = "#94a3b8";
const FAINT = "#64748b";
const CYAN = "#22d3ee";
const BLUE = "#38bdf8";
const EMERALD = "#34d399";
const VIOLET = "#a78bfa";
const AMBER = "#fbbf24";

const MONO = "Menlo, Monaco, monospace";

// ---- segment timeline --------------------------------------------------------
const SEG = {
  title: { start: 0, len: 210 },
  code: { start: 210, len: 450 },
  split: { start: 660, len: 492 },
  play: { start: 1152, len: 882 }, // frame 1152 = 19.2 s = soundtrack bar 10 (lead enters)
  numbers: { start: 2034, len: 420 },
  close: { start: 2454, len: 360 },
};
const TOTAL = SEG.close.start + SEG.close.len;
if (SEG.play.len !== TOTAL_FRAMES) throw new Error("gameplay segment must match capture length");

// ---- drawing helpers -----------------------------------------------------------
const canvas = createCanvas(W, H);
const ctx = canvas.getContext("2d");

function background(): void {
  ctx.fillStyle = FIELD;
  ctx.fillRect(0, 0, W, H);
  ctx.strokeStyle = GRID;
  ctx.lineWidth = 1;
  for (let x = 0.5; x < W; x += 48) {
    ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, H); ctx.stroke();
  }
  for (let y = 0.5; y < H; y += 48) {
    ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(W, y); ctx.stroke();
  }
  let g = ctx.createRadialGradient(0, 0, 0, 0, 0, 900);
  g.addColorStop(0, "rgba(56, 189, 248, 0.14)");
  g.addColorStop(1, "rgba(56, 189, 248, 0)");
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, W, H);
  g = ctx.createRadialGradient(W, H, 0, W, H, 900);
  g.addColorStop(0, "rgba(34, 211, 238, 0.12)");
  g.addColorStop(1, "rgba(34, 211, 238, 0)");
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, W, H);
}

function easeOut(t: number): number {
  return 1 - (1 - t) ** 3;
}
/** staggered entrance: alpha + upward drift for element i at local frame t */
function entrance(t: number, i: number, step = 14, dur = 22): { a: number; dy: number } {
  const lt = (t - i * step) / dur;
  if (lt <= 0) return { a: 0, dy: 24 };
  if (lt >= 1) return { a: 1, dy: 0 };
  return { a: easeOut(lt), dy: 24 * (1 - easeOut(lt)) };
}

function text(s: string, x: number, y: number, size: number, color: string, alpha = 1, align: CanvasTextAlign = "left", weight = ""): void {
  ctx.globalAlpha = alpha;
  ctx.fillStyle = color;
  ctx.font = `${weight ? weight + " " : ""}${size}px ${MONO}`;
  ctx.textAlign = align;
  ctx.fillText(s, x, y);
  ctx.globalAlpha = 1;
}

// minimal syntax highlighting: ordered token classes
const TOKEN_RULES: [RegExp, string][] = [
  [/^\/\/.*/, FAINT],
  [/^\/\*.*/, FAINT],
  [/^"[^"]*"/, AMBER],
  [/^<\/?[A-Z][A-Za-z]*/, EMERALD],
  [/^<\/?>|^<row/, EMERALD],
  [/^(export|default|const|return|static|void|for|if|else)\b/, VIOLET],
  [/^(ref|computed|filter|map|slice|length|value)\b/, BLUE],
  [/^(u8|u16|s32|rec_todo|vp_view)\b/, VIOLET],
  [/^[0-9]+(\.[0-9]+)?/, CYAN],
  [/^[A-Za-z_][A-Za-z0-9_]*/, TEXT],
  [/^\s+/, TEXT],
  [/^./, DIM],
];

function codeLine(line: string, x: number, y: number, size: number, alpha: number): void {
  ctx.globalAlpha = alpha;
  ctx.font = `${size}px ${MONO}`;
  ctx.textAlign = "left";
  let rest = line;
  let cx = x;
  while (rest.length > 0) {
    let matched = false;
    for (const [re, color] of TOKEN_RULES) {
      const m = re.exec(rest);
      if (m && m[0].length > 0) {
        ctx.fillStyle = color;
        ctx.fillText(m[0], cx, y);
        cx += ctx.measureText(m[0]).width;
        rest = rest.slice(m[0].length);
        matched = true;
        break;
      }
    }
    if (!matched) break;
  }
  ctx.globalAlpha = 1;
}

function panel(x: number, y: number, w: number, h: number, alpha = 1, stroke = "#1c2233"): void {
  ctx.globalAlpha = alpha;
  ctx.fillStyle = "rgba(8, 12, 22, 0.92)";
  ctx.strokeStyle = stroke;
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.roundRect(x, y, w, h, 14);
  ctx.fill();
  ctx.stroke();
  ctx.globalAlpha = 1;
}

// ---- gameplay frame loading ---------------------------------------------------
interface Screen {
  name: string;
  sub: string;
  rom: string;
  dir: string;
  sw: number; sh: number;      // source crop
  scale: number;
  color: string;
}
const SCREENS: Screen[] = [
  { name: "GAME BOY ADVANCE", sub: "ARM7TDMI · 16.8 MHz · 2001", rom: "9.1 KB ROM", dir: "gba", sw: 240, sh: 160, scale: 3, color: BLUE },
  { name: "GAME BOY", sub: "SM83 · 4.19 MHz · 1989", rom: "32 KB ROM", dir: "gb", sw: 160, sh: 144, scale: 3, color: EMERALD },
  { name: "NES", sub: "6502 · 1.79 MHz · 1983", rom: "40 KB ROM", dir: "nes", sw: 256, sh: 240, scale: 2, color: VIOLET },
];

const frameCache = new Map<string, ReturnType<typeof createCanvas>>();

async function loadScreen(s: Screen, idx: number) {
  const key = `${s.dir}/${idx}`;
  const hit = frameCache.get(key);
  if (hit) return hit;
  frameCache.clear(); // only current frame set stays hot
  const path = join(OUT, "frames", s.dir, `f${String(idx).padStart(5, "0")}.ppm`);
  const bytes = new Uint8Array(await Bun.file(path).arrayBuffer());
  const head = new TextDecoder().decode(bytes.slice(0, 32));
  const m = head.match(/^P6\n(\d+) (\d+)\n255\n/);
  if (!m) throw new Error(`bad ppm ${path}`);
  const fw = Number(m[1]);
  const off = m[0].length;
  const c = createCanvas(s.sw, s.sh);
  const cc = c.getContext("2d");
  const img = cc.createImageData(s.sw, s.sh);
  for (let y = 0; y < s.sh; y++) {
    for (let x = 0; x < s.sw; x++) {
      const si = off + (y * fw + x) * 3;
      const di = (y * s.sw + x) * 4;
      img.data[di] = bytes[si];
      img.data[di + 1] = bytes[si + 1];
      img.data[di + 2] = bytes[si + 2];
      img.data[di + 3] = 255;
    }
  }
  cc.putImageData(img, 0, 0);
  frameCache.set(key, c);
  return c;
}

const PRESS_LABEL: Record<number, string> = {
  [Button.Up]: "UP", [Button.Down]: "DOWN", [Button.Left]: "LEFT", [Button.Right]: "RIGHT",
  [Button.A]: "A", [Button.B]: "B", [Button.Start]: "START", [Button.Select]: "SELECT",
};
const PRESSES = pressList();

// ---- segment renderers ----------------------------------------------------------

function segAlpha(t: number, len: number, fade = 14): number {
  if (t < fade) return t / fade;
  if (t > len - fade) return Math.max(0, (len - t) / fade);
  return 1;
}

function drawTitle(t: number): void {
  const a = segAlpha(t, SEG.title.len);
  ctx.globalAlpha = a;
  const e0 = entrance(t, 0), e1 = entrance(t, 1), e2 = entrance(t, 2);
  text("POCKET VAPOR", W / 2, 470 + e0.dy, 118, TEXT, a * e0.a, "center", "bold");
  ctx.fillStyle = EMERALD;
  ctx.globalAlpha = a * e1.a;
  ctx.fillRect(W / 2 - 260, 512, 520, 5);
  text("Reactive JavaScript in 2 KB of RAM", W / 2, 590 + e1.dy, 40, EMERALD, a * e1.a, "center");
  text("GBA  ·  GAME BOY  ·  NES", W / 2, 668 + e2.dy, 30, DIM, a * e2.a, "center");
  ctx.globalAlpha = 1;
}

const COMPONENT_CODE = [
  "export default () => {",
  "  const todos = ref<Todo[]>([",
  '    { text: "SHIP POCKET VAPOR", done: false },',
  '    { text: "WRITE THE COMPILER", done: true },',
  '    { text: "RUN ON A REAL GBA", done: false },',
  "  ]);",
  "  const remaining = computed(() =>",
  "    todos.value.filter((t) => !t.done).length);",
  "  const current = computed(() => filtered.value[cursor.value]);",
  "",
  "  return (",
  "    <>",
  '      <TitleBar line={0} text="POCKET VAPOR TODO" />',
  "      {visible.value.map((t, i) => (",
  "        <TodoRow line={LIST_Y + i} todo={t}",
  "                 selected={t === current.value} />",
  "      ))}",
  "    </>",
  "  );",
  "};",
];

function drawCode(t: number): void {
  const a = segAlpha(t, SEG.code.len);
  text("this is a real Vue component", W / 2, 130, 42, TEXT, a * entrance(t, 0).a, "center", "bold");
  text("ref · computed · JSX · imported from \"vue\"", W / 2, 185, 26, DIM, a * entrance(t, 1).a, "center");
  const px = 400, py = 240, pw = 1120, ph = 720;
  panel(px, py, pw, ph, a);
  const lineStep = 16; // one new line every 16 frames
  const visible = Math.min(COMPONENT_CODE.length, Math.floor((t - 20) / lineStep) + 1);
  for (let i = 0; i < visible; i++) {
    const la = Math.min(1, (t - 20 - i * lineStep) / 10);
    if (la > 0) codeLine(COMPONENT_CODE[i], px + 44, py + 62 + i * 32, 22, a * la);
  }
  if (visible < COMPONENT_CODE.length && t > 20) {
    ctx.globalAlpha = a * (Math.floor(t / 16) % 2 ? 1 : 0.2);
    ctx.fillStyle = EMERALD;
    ctx.fillRect(px + 44, py + 44 + visible * 32, 12, 24);
    ctx.globalAlpha = 1;
  }
}

const TS_SIDE = [
  "const filtered = computed(() =>",
  "  filter.value === 1",
  "    ? todos.value.filter((t) => !t.done)",
  "    : todos.value.filter((t) => t.done));",
];
const C_SIDE = [
  "static void c_filtered_update(void) {",
  "  u8 i; c_filtered_v.len = 0;",
  "  for (i = 0; i < g_todos_len; i++) {",
  "    rec_todo *p = g_todos + (u16)i;",
  "    if (!p->done)",
  "      c_filtered_v.idx[c_filtered_v.len++] = i;",
  "  }",
  "}",
];

function drawSplit(t: number): void {
  const a = segAlpha(t, SEG.split.len);
  text("the compiler turns reactivity into data", W / 2, 130, 42, TEXT, a * entrance(t, 0).a, "center", "bold");
  text("refs → dirty bits · dependencies → ROM bitmasks · filter/slice → index views", W / 2, 185, 25, DIM, a * entrance(t, 1).a, "center");
  const e2 = entrance(t, 2), e3 = entrance(t, 5);
  panel(120, 260 + e2.dy, 820, 480, a * e2.a, "#274060");
  text("you write", 160, 320 + e2.dy, 22, BLUE, a * e2.a);
  TS_SIDE.forEach((l, i) => codeLine(l, 160, 380 + e2.dy + i * 40, 23, a * e2.a));
  panel(980, 260 + e3.dy, 820, 480, a * e3.a, "#2a4a3a");
  text("it ships (generated, verbatim)", 1020, 320 + e3.dy, 22, EMERALD, a * e3.a);
  C_SIDE.forEach((l, i) => codeLine(l, 1020, 380 + e3.dy + i * 40, 23, a * e3.a));
}

async function drawPlay(t: number): Promise<void> {
  const a = segAlpha(t, SEG.play.len, 10);
  text("same component · same inputs · three consoles, live", W / 2, 110, 36, TEXT, a, "center", "bold");
  const layout = [
    { s: SCREENS[0], x: 56, w: 720, h: 480 },
    { s: SCREENS[1], x: 824, w: 480, h: 432 },
    { s: SCREENS[2], x: 1352, w: 512, h: 480 },
  ];
  const top = 260;
  for (const { s, x, w, h } of layout) {
    const y = top + (480 - h) / 2;
    ctx.globalAlpha = a;
    ctx.fillStyle = "#000";
    ctx.fillRect(x - 8, y - 8, w + 16, h + 16);
    ctx.strokeStyle = "#1c2233";
    ctx.lineWidth = 2;
    ctx.strokeRect(x - 8, y - 8, w + 16, h + 16);
    const frame = await loadScreen(s, Math.min(t, TOTAL_FRAMES - 1));
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(frame, 0, 0, s.sw, s.sh, x, y, w, h);
    text(s.name, x + w / 2, top - 40, 26, s.color, a, "center", "bold");
    text(s.sub, x + w / 2, top - 8, 19, FAINT, a, "center");
    text(s.rom, x + w / 2, y + h + 44, 24, s.color, a, "center", "bold");
    ctx.globalAlpha = 1;
  }
  // live button read-out from the deterministic schedule
  const pi = Math.floor((t - LEAD) / FRAMES_PER_PRESS);
  const inHold = (t - LEAD) % FRAMES_PER_PRESS < 14;
  if (t >= LEAD && pi >= 0 && pi < PRESSES.length && inHold) {
    const label = PRESS_LABEL[PRESSES[pi]];
    panel(W / 2 - 130, 830, 260, 76, a, "#274060");
    text(label, W / 2, 882, 34, CYAN, a, "center", "bold");
  }
  const phase =
    t < LEAD ? "booted. every ref is a dirty bit now" :
    pi < 4 ? "toggling a todo: one mask test, one row repaint" :
    pi < 7 ? "cycling a computed filter view" :
    pi < 24 ? "typing into a reactive string ref, one glyph at a time" :
    "saved. push() into a fixed pool, remaining recomputed";
  text(phase, W / 2, 970, 25, DIM, a, "center");
}

function drawNumbers(t: number): void {
  const a = segAlpha(t, SEG.numbers.len);
  text("the receipts", W / 2, 160, 42, TEXT, a * entrance(t, 0).a, "center", "bold");
  const rows = [
    ["app state, compiled", "940 bytes", EMERALD],
    ["Vue Vapor runtime (prod build)", "218 KB", BLUE],
    ["entire NES work RAM", "2 KB", VIOLET],
    ["assertions: real Vue vs three ROMs, every keypress", "7,264", CYAN],
  ];
  rows.forEach(([k, v, c], i) => {
    const e = entrance(t, 2 + i * 2);
    const y = 300 + i * 150 + e.dy;
    text(k as string, 240, y, 30, DIM, a * e.a);
    text(v as string, 1680, y, 56, c as string, a * e.a, "right", "bold");
    ctx.globalAlpha = a * e.a * 0.35;
    ctx.strokeStyle = "#1c2233";
    ctx.beginPath(); ctx.moveTo(240, y + 40); ctx.lineTo(1680, y + 40); ctx.stroke();
    ctx.globalAlpha = 1;
  });
  text("the same tape, the same cells, every commit", W / 2, 950 + entrance(t, 11).dy, 26, FAINT, a * entrance(t, 11).a, "center");
}

function drawClose(t: number): void {
  const a = segAlpha(t, SEG.close.len, 20);
  const e0 = entrance(t, 0), e1 = entrance(t, 2), e2 = entrance(t, 4);
  text("POCKET VAPOR", W / 2, 440 + e0.dy, 84, TEXT, a * e0.a, "center", "bold");
  text("pocketjs.dev/blog/pocket-vapor", W / 2, 560 + e1.dy, 38, EMERALD, a * e1.a, "center");
  text("github.com/pocket-stack/pocketjs", W / 2, 625 + e2.dy, 30, DIM, a * e2.a, "center");
}

// ---- logo badge (every frame) ------------------------------------------------------
// The PocketJS lens/viewfinder glyph, redrawn in vectors from the site's
// brand SVG (same geometry as skills/pocketjs-video-outro/assets/outro.html):
// 32x32 viewBox — rounded-rect edge, lens dot at (10,16), two bars.
function drawLogo(x0: number, y0: number, size: number): void {
  const u = size / 32;
  const grad = (x1: number, y1: number, x2: number, y2: number, stops: [number, string][]) => {
    const g = ctx.createLinearGradient(x0 + x1 * u, y0 + y1 * u, x0 + x2 * u, y0 + y2 * u);
    for (const [o, c] of stops) g.addColorStop(o, c);
    return g;
  };
  ctx.lineJoin = "round";
  ctx.strokeStyle = grad(4, 4, 28, 28, [
    [0, "#eef6ff"], [0.38, "#b7c8e2"], [0.58, "#7487a0"], [0.78, "#aec0d6"], [1, "#dbe8f6"],
  ]);
  ctx.lineWidth = 2.6 * u;
  ctx.beginPath();
  ctx.roundRect(x0 + 2 * u, y0 + 6 * u, 28 * u, 20 * u, 6 * u);
  ctx.stroke();
  ctx.fillStyle = grad(7, 13, 13, 19, [[0, "#e4edf8"], [0.55, "#a7b8cf"], [1, "#53677f"]]);
  ctx.beginPath();
  ctx.arc(x0 + 10 * u, y0 + 16 * u, 3.1 * u, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = grad(16, 12, 24, 20, [[0, "#d7e3f1"], [1, "#71849d"]]);
  ctx.beginPath();
  ctx.roundRect(x0 + 16 * u, y0 + 12.6 * u, 10 * u, 2.2 * u, 1.1 * u);
  ctx.fill();
  ctx.beginPath();
  ctx.roundRect(x0 + 16 * u, y0 + 17.2 * u, 6.5 * u, 2.2 * u, 1.1 * u);
  ctx.fill();
}

function badge(): void {
  ctx.globalAlpha = 0.92;
  drawLogo(48, 38, 44);
  ctx.globalAlpha = 1;
  text("PocketJS", 106, 69, 24, DIM, 0.92);
}

// ---- render loop -----------------------------------------------------------------
const mp4 = join(OUT, "pocket-vapor.mp4");
const ff = Bun.spawn(
  [
    "ffmpeg", "-y",
    "-f", "rawvideo", "-pix_fmt", "rgba", "-s", `${W}x${H}`, "-r", String(FPS), "-i", "pipe:0",
    "-i", join(OUT, "music.wav"),
    "-map", "0:v", "-map", "1:a",
    "-c:v", "libx264", "-preset", "medium", "-crf", "18", "-pix_fmt", "yuv420p",
    // no -t / -shortest: music.wav is synthesized to exactly TOTAL/FPS seconds,
    // and a duration cap makes ffmpeg close stdin before the writer finishes (EPIPE)
    "-c:a", "aac", "-b:a", "192k", mp4,
  ],
  { stdin: "pipe", stdout: "ignore", stderr: Bun.file(join(OUT, "ffmpeg.log")) },
);

const t0 = Date.now();
for (let f = 0; f < TOTAL; f++) {
  background();
  if (f < SEG.code.start) drawTitle(f - SEG.title.start);
  else if (f < SEG.split.start) drawCode(f - SEG.code.start);
  else if (f < SEG.play.start) drawSplit(f - SEG.split.start);
  else if (f < SEG.numbers.start) await drawPlay(f - SEG.play.start);
  else if (f < SEG.close.start) drawNumbers(f - SEG.numbers.start);
  else drawClose(f - SEG.close.start);
  badge();

  const img = (ctx as SKRSContext2D).getImageData(0, 0, W, H);
  // write() under backpressure returns a Promise; not awaiting it TRUNCATES the
  // stream mid-frame (rawvideo: "packet size < expected frame_size", then EPIPE)
  await ff.stdin.write(img.data);
  await ff.stdin.flush();
  if (f % 300 === 0) console.log(`frame ${f}/${TOTAL} (${((Date.now() - t0) / 1000).toFixed(0)}s)`);
}
await ff.stdin.end();
await ff.exited;
console.log(`${mp4} rendered in ${((Date.now() - t0) / 1000).toFixed(0)}s`);
