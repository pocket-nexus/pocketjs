// Preview page runtime (the iframe loading /pocket/preview.html).
// The parent page reloads the iframe for every run so global state starts clean, then:
//   1. instantiate pocketjs.wasm (Rust UI core + software rasterizer) and set globalThis.ui
//   2. turn compiled modules into blob URLs, replacing each project-local import with its URL
//   3. dynamically import the entry (main.ts calls mount()) and call globalThis.frame(buttons, analog, touches, hits) at a fixed 60 Hz step
// Framework modules and vue / solid-js resolve through the import map in preview.html.
import { createWasmUi } from "../../../hosts/web/wasm-ops.js";
import { __packTouch, __packTouchWide, createTouchHitFacts } from "../../../framework/src/touch.ts";

const MODULE_TOKEN = "__pocket_module__:";

interface RunMessage {
  type: "run";
  modules: Record<string, { path: string; code: string; deps: string[] }>;
  entry: string;
  styles: Record<string, number>;
  pak: ArrayBuffer;
  viewport: { width: number; height: number };
  /** Device has a touchscreen: pointer events on the canvas reach the app as touch input */
  touch?: boolean;
}

let screenSize = { width: 480, height: 272 };

// contracts/spec/spec.ts BTN: PSP button bits
const BTN = {
  SELECT: 0x0001,
  START: 0x0008,
  UP: 0x0010,
  RIGHT: 0x0020,
  DOWN: 0x0040,
  LEFT: 0x0080,
  LTRIGGER: 0x0100,
  RTRIGGER: 0x0200,
  TRIANGLE: 0x1000,
  CIRCLE: 0x2000,
  CROSS: 0x4000,
  SQUARE: 0x8000,
} as const;
// Same mapping as site/playground/host.js
const KEYMAP: Record<string, number> = {
  ArrowUp: BTN.UP,
  ArrowRight: BTN.RIGHT,
  ArrowDown: BTN.DOWN,
  ArrowLeft: BTN.LEFT,
  KeyX: BTN.CROSS,
  Enter: BTN.CIRCLE,
  KeyZ: BTN.CIRCLE,
  KeyA: BTN.SQUARE,
  KeyS: BTN.TRIANGLE,
  ShiftLeft: BTN.SELECT,
  ShiftRight: BTN.SELECT,
  Space: BTN.START,
  KeyL: BTN.LTRIGGER,
  KeyR: BTN.RTRIGGER,
  KeyQ: BTN.LTRIGGER,
  KeyE: BTN.RTRIGGER,
};

const post = (msg: Record<string, unknown>) => parent.postMessage({ source: "microts-preview", ...msg }, "*");

// Forward console output to the parent page
for (const level of ["log", "info", "warn", "error", "debug"] as const) {
  const original = console[level].bind(console);
  console[level] = (...args: unknown[]) => {
    original(...args);
    post({ type: "log", level, text: args.map(formatArg).join(" ") });
  };
}
function formatArg(v: unknown): string {
  if (typeof v === "string") return v;
  if (v instanceof Error) return v.stack ?? v.message;
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}

function reportError(error: unknown, phase: string) {
  const err = error instanceof Error ? error : new Error(String(error));
  post({ type: "error", phase, message: err.message, stack: err.stack ?? "" });
}
window.addEventListener("error", (e) => reportError(e.error ?? e.message, "runtime"));
window.addEventListener("unhandledrejection", (e) => reportError(e.reason, "runtime"));

let held = 0;
let external = 0;
// A key pressed and released between two frames still reaches the next frame
let latched = 0;
const canvas = document.getElementById("screen") as HTMLCanvasElement;

window.addEventListener("keydown", (e) => {
  const bit = KEYMAP[e.code];
  if (bit === undefined) return;
  e.preventDefault();
  held |= bit;
  latched |= bit;
});
window.addEventListener("keyup", (e) => {
  const bit = KEYMAP[e.code];
  if (bit === undefined) return;
  e.preventDefault();
  held &= ~bit;
});
window.addEventListener("blur", () => (held = 0));
window.addEventListener("pointerdown", () => post({ type: "focus" }));

// Link modules into blob URLs: link dependencies first, then substitute their placeholders
function link(modules: RunMessage["modules"], entry: string): string {
  const urls = new Map<string, string>();
  const visiting = new Set<string>();
  const visit = (path: string): string => {
    const done = urls.get(path);
    if (done) return done;
    if (visiting.has(path)) throw new Error(`Circular import through ${path} is not supported in the playground`);
    visiting.add(path);
    const mod = modules[path];
    if (!mod) throw new Error(`Module ${path} was not compiled`);
    let code = mod.code;
    for (const dep of mod.deps) code = code.split(MODULE_TOKEN + dep).join(visit(dep));
    const url = URL.createObjectURL(new Blob([`${code}\n//# sourceURL=${location.origin}/project/${path}`], { type: "text/javascript" }));
    urls.set(path, url);
    visiting.delete(path);
    return url;
  };
  return visit(entry);
}

/** Fit the canvas to the device's screen area (the iframe is the screen area, at the logical viewport's aspect ratio) */
function fitCanvas() {
  const { width, height } = screenSize;
  const scale = Math.min(innerWidth / width, innerHeight / height);
  canvas.style.width = `${Math.floor(width * scale)}px`;
  canvas.style.height = `${Math.floor(height * scale)}px`;
  // Nearest-neighbor at 2x and above keeps pixels sharp; smaller scales are smoothed
  canvas.style.imageRendering = scale >= 2 ? "pixelated" : "auto";
}
window.addEventListener("resize", fitCanvas);

// ---------- Touch ----------
// Same as the PocketJS device hosts: one contact, coordinates in logical pixels, packed per framework/src/touch.ts;
// a tap pressed and released between two frames reports down for one frame, then up on the next.
let touchEnabled = false;
let contact: { x: number; y: number } | null = null;
let tapPending: { x: number; y: number } | null = null;
let hitFacts: ((packed: readonly number[] | undefined) => number[] | undefined) | undefined;

function logicalPoint(e: PointerEvent) {
  const r = canvas.getBoundingClientRect();
  const { width, height } = screenSize;
  const x = Math.min(width - 1, Math.max(0, Math.floor(((e.clientX - r.left) / r.width) * width)));
  const y = Math.min(height - 1, Math.max(0, Math.floor(((e.clientY - r.top) / r.height) * height)));
  return { x, y };
}
canvas.addEventListener("pointerdown", (e) => {
  if (!touchEnabled) return;
  canvas.setPointerCapture(e.pointerId);
  contact = logicalPoint(e);
  tapPending = contact;
});
canvas.addEventListener("pointermove", (e) => {
  if (touchEnabled && contact) contact = logicalPoint(e);
});
const release = () => (contact = null);
canvas.addEventListener("pointerup", release);
canvas.addEventListener("pointercancel", release);

function packTouches(): number[] | undefined {
  const point = contact ?? tapPending;
  tapPending = null;
  if (!point) return undefined;
  const wide = screenSize.width > 511 || screenSize.height > 511;
  return [wide ? __packTouchWide(0, point.x, point.y) : __packTouch(0, point.x, point.y)];
}

let wasmBytes: Promise<ArrayBuffer> | null = null;

async function run(msg: RunMessage) {
  const { width, height } = msg.viewport;
  canvas.width = width;
  canvas.height = height;
  document.documentElement.style.setProperty("--aspect", `${width} / ${height}`);
  screenSize = { width, height };
  touchEnabled = msg.touch === true;
  canvas.style.cursor = touchEnabled ? "pointer" : "";
  fitCanvas();
  const ctx = canvas.getContext("2d")!;
  ctx.imageSmoothingEnabled = false;
  const image = ctx.createImageData(width, height);

  wasmBytes ??= fetch(new URL("./pocketjs.wasm", import.meta.url)).then((r) => {
    if (!r.ok) throw new Error(`pocketjs.wasm: HTTP ${r.status}`);
    return r.arrayBuffer();
  });
  const wasm = await createWasmUi(await wasmBytes, { width, height });
  const g = globalThis as Record<string, unknown>;
  g.ui = wasm.ops;
  g.__pak = msg.pak;
  g.__pocketStyles = msg.styles;
  g.frame = undefined;

  const entryUrl = link(msg.modules, msg.entry);
  try {
    await import(/* @vite-ignore */ entryUrl);
  } catch (e) {
    reportError(e, "mount");
    return;
  }
  const frame = g.frame as
    | ((buttons: number, analog?: number, touches?: readonly number[], hits?: readonly number[]) => void)
    | undefined;
  const hitTestBounds = (wasm.ops as { hitTestBounds?: (x: number, y: number) => number }).hitTestBounds;
  hitFacts = hitTestBounds ? createTouchHitFacts(hitTestBounds) : undefined;
  if (typeof frame !== "function") {
    reportError(new Error("The entry did not mount an app. main.ts must call mount(App)."), "mount");
    return;
  }

  let last = performance.now();
  let acc = 0;
  let frames = 0;
  let statT = 0;
  let alive = true;
  const STEP = 1000 / 60;
  const blit = () => {
    image.data.set(wasm.renderIncremental());
    ctx.putImageData(image, 0, 0);
  };
  const step = () => {
    try {
      const touches = touchEnabled ? packTouches() : undefined;
      frame(held | latched | external, undefined, touches, hitFacts?.(touches));
      latched = 0;
      wasm.tick();
      return true;
    } catch (e) {
      alive = false;
      reportError(e, "frame");
      return false;
    }
  };
  step();
  blit();
  post({ type: "running", width, height });
  const loop = (now: number) => {
    if (!alive) return;
    requestAnimationFrame(loop);
    let dt = now - last;
    last = now;
    if (dt > 250) dt = 250;
    acc += dt;
    let steps = 0;
    while (acc >= STEP && steps < 4 && alive) {
      step();
      acc -= STEP;
      steps++;
      frames++;
    }
    if (steps) blit();
    statT += dt;
    if (statT >= 1000) {
      const mem = (wasm.exports as { memory?: WebAssembly.Memory }).memory?.buffer.byteLength ?? 0;
      post({ type: "stats", fps: Math.round((frames * 1000) / statT), memory: mem });
      frames = 0;
      statT = 0;
    }
  };
  requestAnimationFrame(loop);
}

window.addEventListener("message", (e: MessageEvent) => {
  const msg = e.data;
  if (!msg || typeof msg !== "object") return;
  if (msg.type === "run") void run(msg as RunMessage).catch((err) => reportError(err, "mount"));
  else if (msg.type === "buttons") {
    latched |= msg.mask & ~external;
    external = msg.mask | 0;
  }
  else if (msg.type === "focus") canvas.focus();
});

post({ type: "ready" });
