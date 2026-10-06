// hosts/sim/sim.ts — the deterministic simulation host (docs/DETERMINISM.md).
//
// A PocketJS host with no screen, no vblank, and no wall clock: it boots a
// built app bundle against the wasm core (the SAME HostOps binding the
// browser host and tests/golden.ts use), then drives virtual frames as fast
// as the CPU allows. The clock policy is explicit: `hz` virtual frames per
// virtual second, each one JS frame() transaction plus 60/hz core ticks —
// so ms-based animations cover the same virtual time at every rate, and a
// low-rate world is a strict subsampling of the 60 Hz world's trajectory.
//
// Input is a SCRIPT in virtual seconds (`{ at, press }`), not frame counts,
// so one user journey drives every simulation rate. The run product is a
// TRACE: a per-frame framebuffer hash, every effect command/delivery with
// its frame index, and the raw final framebuffer. Two runs of the same
// scenario must produce byte-identical traces — that is the whole point —
// and callers can prove it cheaply by comparing `trace.hashes`.
//
//   import { runScenario } from "../sim/sim.ts";
//   const trace = await runScenario({ app: "cafe-main", hz: 4, seconds: 6,
//     script: [{ at: 1, press: BTN.DOWN }, { at: 1.5, press: BTN.CIRCLE }] });
//
// `chaos` inserts real wall-clock sleeps, garbage churn, and forced GC
// between frames. It exists so tests can PROVE the wall clock is not an
// input: a chaos trace must equal a clean trace, byte for byte.

import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join, resolve } from "node:path";
import { createWasmUi } from "../web/wasm-ops.js";
import { normalizeHz, TICKS_PER_SECOND } from "../../framework/src/clock.ts";
import { createTouchHitFacts, __packTouch, __packTouchWide } from "../../framework/src/touch.ts";
import { unpack } from "../../framework/compiler/pak.ts";
import type { AxisDelta } from "../../framework/src/relative-axis.ts";
import type { MotionState } from "../../framework/src/motion.ts";

const ROOT = resolve(fileURLToPath(new URL("../..", import.meta.url))); // PocketJS/
const DIST = join(ROOT, "dist/");
const WASM_PATH = join(ROOT, "hosts/web/pocketjs.wasm");

export interface ScriptEvent {
  /** Virtual seconds since boot. Lands on frame round(at * hz) — keep script
   *  times on the 0.5 s grid and they align exactly at every valid hz. */
  at: number;
  /** BTN mask held for exactly that one virtual frame (a press pulse). */
  press?: number;
  /** BTN mask held from this frame until the next event that carries `hold`
   *  (level-triggered — for trigger-zoom style inputs; 0 releases). */
  hold?: number;
  /** Packed analog nub value ((x << 8) | y, 128 = center) held from this
   *  frame until the next event that carries `analog` (level-triggered —
   *  a one-frame nub pulse cannot pan anything). spec ANALOG_CENTER releases. */
  analog?: number;
  /** Front-panel contacts held from this frame until the next event that
   *  carries `touch` (level-triggered like `hold`/`analog`); [] releases.
   *  Logical px; `id` defaults to 0 (the common single-finger case). */
  touch?: { id?: number; x: number; y: number }[];
}

export interface Scenario {
  /** Built bundle name under dist/ (e.g. "cafe-main"). */
  app: string;
  /** Virtual frames per second; must divide 60. Default 60. */
  hz?: number;
  /** Journey length in virtual seconds. */
  seconds: number;
  script?: ScriptEvent[];
}

export interface ChaosOptions {
  /** Max wall-clock sleep injected between frames (ms). */
  maxSleepMs?: number;
  /** Force a GC every N frames (0 = never). */
  gcEvery?: number;
}

export interface EffectEvent {
  t: "command" | "delivery";
  frame: number;
  id: number;
  kind: string;
}

export interface Trace {
  app: string;
  hz: number;
  frames: number;
  /** FNV-1a of the RGBA framebuffer after every virtual frame. */
  hashes: string[];
  effects: EffectEvent[];
  /** Raw RGBA of the final frame (for cross-hz byte comparison / PNGs). */
  finalFrame: Uint8Array;
  /** Component tree JSON after the final frame (DevTools getTree). */
  tree: unknown;
}

/** FNV-1a 32-bit over the RGBA framebuffer (same as tools/tape.ts). */
export function fnv1a(bytes: Uint8Array): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < bytes.length; i++) {
    h ^= bytes[i];
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, "0");
}

/** Expand a virtual-seconds script into per-frame masks + analog + touch. */
export function scriptToMasks(
  script: ScriptEvent[],
  hz: number,
  frames: number,
): { masks: number[]; analogs: number[]; touches: (number[] | undefined)[] } {
  const ANALOG_CENTER = 0x8080; // spec.ts (kept literal — this module stays host-side)
  const masks = new Array<number>(frames).fill(0);
  const analogs = new Array<number>(frames).fill(ANALOG_CENTER);
  const touches = new Array<number[] | undefined>(frames).fill(undefined);
  const holds: { f: number; v: number }[] = [];
  const nubs: { f: number; v: number }[] = [];
  const contacts: { f: number; v: number[] }[] = [];
  for (const ev of script) {
    const f = Math.round(ev.at * hz);
    if (f < 0 || f >= frames) {
      throw new Error(`sim: script event at ${ev.at}s -> frame ${f} is outside 0..${frames - 1}`);
    }
    if (ev.press !== undefined) masks[f] |= ev.press;
    if (ev.hold !== undefined) holds.push({ f, v: ev.hold });
    if (ev.analog !== undefined) nubs.push({ f, v: ev.analog & 0xffff });
    if (ev.touch !== undefined) {
      contacts.push({ f, v: ev.touch.map((c) => __packTouch(c.id ?? 0, c.x, c.y)) });
    }
  }
  // Level-triggered tracks: each event holds its value until the next one.
  holds.sort((a, b) => a.f - b.f);
  nubs.sort((a, b) => a.f - b.f);
  contacts.sort((a, b) => a.f - b.f);
  for (let i = 0; i < holds.length; i++) {
    const end = i + 1 < holds.length ? holds[i + 1].f : frames;
    for (let f = holds[i].f; f < end; f++) masks[f] |= holds[i].v;
  }
  for (let i = 0; i < nubs.length; i++) {
    const end = i + 1 < nubs.length ? nubs[i + 1].f : frames;
    for (let f = nubs[i].f; f < end; f++) analogs[f] = nubs[i].v;
  }
  for (let i = 0; i < contacts.length; i++) {
    const end = i + 1 < contacts.length ? contacts[i + 1].f : frames;
    const v = contacts[i].v.length > 0 ? contacts[i].v : undefined;
    for (let f = contacts[i].f; f < end; f++) touches[f] = v;
  }
  return { masks, analogs, touches };
}

/**
 * One finger gliding from (x0, y0) to (x1, y1) between t0 and t1 virtual
 * seconds: per-frame linear interpolation on the frame grid (int-rounded
 * px), released at t1. Composable — spread into a scenario script:
 *   script: [...touchGlide(240, 200, 240, 80, 1, 1.5), { at: 3, press: … }]
 */
export function touchGlide(
  x0: number,
  y0: number,
  x1: number,
  y1: number,
  t0: number,
  t1: number,
  id = 0,
): ScriptEvent[] {
  if (t1 <= t0) throw new Error("sim: touchGlide needs t1 > t0");
  const out: ScriptEvent[] = [];
  // Emit one event per frame at EVERY valid hz's grid: use the 60 Hz frame
  // grid (the finest), and scriptToMasks' rounding lands each event on the
  // active rate's frame. Same-frame duplicates collapse level-triggered.
  const f0 = Math.round(t0 * 60);
  const f1 = Math.round(t1 * 60);
  for (let f = f0; f < f1; f++) {
    const t = (f - f0) / (f1 - f0);
    out.push({
      at: f / 60,
      touch: [
        { id, x: Math.round(x0 + (x1 - x0) * t), y: Math.round(y0 + (y1 - y0) * t) },
      ],
    });
  }
  out.push({ at: f1 / 60, touch: [] });
  return out;
}

function ensureBuilt(path: string, cmd: string[]): void {
  if (existsSync(path)) return;
  const p = Bun.spawnSync(cmd, { cwd: ROOT, stdout: "inherit", stderr: "inherit" });
  if (p.exitCode !== 0 || !existsSync(path)) {
    throw new Error(`sim: failed to produce ${path}`);
  }
}

let wasmBytes: ArrayBuffer | null = null;

export interface SimWorld {
  /** One host frame: buttons bitmask, analog byte, packed touch contacts
   *  (framework/src/touch.ts __packTouch format) — exactly the native frame() shape. */
  frame: (buttons: number, analog?: number, touches?: readonly number[], axes?: readonly AxisDelta[], motion?: MotionState | null) => void;
  tick: () => void;
  render: () => Uint8Array;
  ticksPerFrame: number;
  hz: number;
  effects: EffectEvent[];
  getTree: () => unknown;
}

export interface SimViewportOptions {
  width?: number;
  height?: number;
  rasterDensity?: number;
  renderScale?: number;
  /** Optional auxiliary surface dimensions, created before the guest mounts. */
  auxiliary?: [number, number];
}

/**
 * Boot a fresh world: fresh wasm core, fresh bundle eval, host globals
 * (ui/__pak/__simHz/effect trace/DevTools transport) installed before eval —
 * the identical boot the browser host performs, minus the screen.
 * `extraGlobals` land before eval too (e.g. a __pocketEffectDriver override —
 * tools/flake-lab.ts injects a wall-clock driver this way).
 */
export async function bootWorld(
  app: string,
  hz: number,
  extraGlobals?: Record<string, unknown>,
  mutateOps?: (ops: Record<string, unknown>) => void,
  viewport: SimViewportOptions = {},
): Promise<SimWorld> {
  ensureBuilt(WASM_PATH, [process.execPath, "tools/wasm.ts"]);
  ensureBuilt(DIST + app + ".js", [process.execPath, "tools/build.ts", app]);
  if (!wasmBytes) wasmBytes = await Bun.file(WASM_PATH).arrayBuffer();
  const wasm = await createWasmUi(wasmBytes, viewport);
  const renderScale = viewport.renderScale ?? 1;
  const g = globalThis as Record<string, unknown>;
  const effects: EffectEvent[] = [];
  const inbox: string[] = [];
  const outbox: string[] = [];
  g.ui = wasm.ops;
  // Host-flavored op extensions (the launcher runner adds appTable/appLaunch/
  // appShot here) — installed before eval like every other contract slot.
  mutateOps?.(wasm.ops as unknown as Record<string, unknown>);
  g.__pak = existsSync(DIST + app + ".pak")
    ? await Bun.file(DIST + app + ".pak").arrayBuffer()
    : undefined;
  g.frame = undefined;
  g.offload = undefined; // isolated capability namespace; only test providers grant it
  g.audio = undefined; // audio module namespace: absent unless extraGlobals mounts one
  g.db = undefined; // db module namespace: absent unless extraGlobals mounts one
  g.fs = undefined; // fs module namespace: absent unless extraGlobals mounts one
  g.__pocketApp = app;
  g.__simHz = hz;
  g.__pocketEffectTrace = (e: EffectEvent) => effects.push(e);
  g.__pocketEffectDriver = undefined; // no host override unless extraGlobals injects one
  g.__pocketDevtoolsTransport = {
    send: (line: string) => outbox.push(line),
    recv: () => (inbox.length ? inbox.shift() : null),
  };
  if (extraGlobals) Object.assign(g, extraGlobals);
  const src = await Bun.file(DIST + app + ".js").text();
  (0, eval)(src);
  const appFrame = g.frame as
    | ((buttons: number, analog?: number, touches?: readonly number[], hits?: readonly number[], touchSurfaces?: readonly number[], rightAnalog?: number, axes?: readonly AxisDelta[], motion?: MotionState | null) => void)
    | undefined;
  if (typeof appFrame !== "function") {
    throw new Error("sim: bundle did not install globalThis.frame (entry must call render()/mount())");
  }
  // Touch hit facts (docs/TOUCH.md): the sim is a host, so it resolves each
  // new contact's bounds hit against the committed core frame and carries it
  // — the guest never queries on the touch path, exactly like device hosts.
  const hitTestBounds = (wasm.ops as { hitTestBounds?: (x: number, y: number) => number })
    .hitTestBounds;
  const hitFacts = hitTestBounds ? createTouchHitFacts(hitTestBounds) : undefined;
  const frame = (buttons: number, analog?: number, touches?: readonly number[], axes?: readonly AxisDelta[], motion?: MotionState | null): void =>
    appFrame(buttons, analog, touches, hitFacts?.(touches), undefined, undefined, axes, motion);
  return {
    frame,
    tick: wasm.tick,
    render: () => wasm.renderScaled(renderScale),
    ticksPerFrame: TICKS_PER_SECOND / hz,
    hz,
    effects,
    // Tree probe: ask the DevTools shim, flush with one extra frame (the
    // shim polls its transport at frame start). The probe frame advances the
    // world — call it only when the run is over.
    getTree: () => {
      outbox.length = 0;
      inbox.push(JSON.stringify({ t: "getTree" }));
      frame(0);
      for (let t = 0; t < TICKS_PER_SECOND / hz; t++) wasm.tick();
      for (const line of outbox) {
        const msg = JSON.parse(line) as { t: string; root?: unknown };
        if (msg.t === "tree") return msg.root;
      }
      return null;
    },
  };
}

// ---------------------------------------------------------------------------
// A bundle built anywhere, stepped by hand
// ---------------------------------------------------------------------------
//
// `bootWorld` runs an app of this checkout from dist/ and lets a guest
// exception escape. `bootBundle` runs any built bundle from the two paths its
// build wrote, at the viewport its target has, and turns a guest exception
// into data: a tool that shows an author their own game (a screenshot, the
// texts on screen, the line that threw) drives it. It builds nothing: a
// missing wasm core or bundle is an error that names the path.
//
//   const world = await bootBundle({ js: "out/game.js", pak: "out/game.pak",
//     viewport: { width: 400, height: 240, auxiliary: [320, 240] } });
//   for (let f = 0; f < 60; f++) world.step();
//   world.step({ buttons: BTN.CIRCLE });
//   world.step({ touches: [{ x: 160, y: 120 }], surface: "auxiliary" });
//   const { width, height, rgba } = world.pixels();
//   const roots = world.tree();

export type SimSurface = "primary" | "auxiliary";

export interface BundleOptions {
  /** The built bundle. */
  js: string;
  /** Its asset pack. A bundle with none runs without `__pak`. */
  pak?: string;
  /** What the guest reads as `__pocketApp`. Default: the bundle's file name. */
  app?: string;
  /** Virtual frames per second; must divide 60. Default 60. */
  hz?: number;
  /** The target's logical viewport, raster density and second screen. `renderScale` is not read: pixels come at the raster density. */
  viewport?: SimViewportOptions;
  /** The wasm core. Default: hosts/web/pocketjs.wasm of this PocketJS root. */
  wasm?: string;
}

/** A guest exception: thrown while the bundle evaluated (`boot`) or inside a frame. */
export interface GuestFailure {
  phase: "boot" | "frame";
  /** The frame that threw; 0 for `boot`. */
  frame: number;
  message: string;
  /** The engine's stack. Frames inside the bundle carry its file name, line and column. */
  stack: string;
}

/** One line the guest wrote to `console`. */
export interface GuestLog {
  frame: number;
  level: "log" | "info" | "warn" | "error" | "debug";
  text: string;
}

/** A finger or stylus, in logical pixels of the surface it is on. */
export interface SimContact {
  id?: number;
  x: number;
  y: number;
}

/** What is held for one frame. Everything left out is at rest. */
export interface StepInput {
  /** BTN mask. */
  buttons?: number;
  /** Packed analog stick, (x << 8) | y with 128 the centre. */
  analog?: number;
  touches?: readonly SimContact[];
  /** The surface the contacts are on. Default `primary`. */
  surface?: SimSurface;
}

/** One node of the retained tree, as the core holds it. */
export interface SimNode {
  id: number;
  type: "view" | "text" | "image" | "surface";
  /** The node's text; "" for a node that holds none. */
  text: string;
  /** `display: none` on this node. Its subtree paints nothing. */
  hidden: boolean;
  /** x, y, width, height of its world box in logical pixels of its surface; null when it did not paint. */
  rect: [number, number, number, number] | null;
  /** The resolved background and text colours as the core holds them: 0xAABBGGRR. A background with alpha 0 paints nothing. */
  bgColor: number;
  textColor: number;
  children: SimNode[];
}

export interface SimPixels {
  /** Physical size: the logical viewport times the raster density on the primary surface. */
  width: number;
  height: number;
  /** RGBA8, a copy the next render does not overwrite. */
  rgba: Uint8Array;
}

/** One font face the pack carries. */
export interface SimFont {
  /** The slot a `text-*` / `font-bold` class resolves to. */
  slot: number;
  /** The height of one line in logical pixels: the height of a <Text> box in this face. */
  lineHeight: number;
  bold: boolean;
}

export interface BundleWorld {
  hz: number;
  ticksPerFrame: number;
  /** The font faces baked into the pack, by slot. */
  fonts: SimFont[];
  /** The width of one line of `text` in a font slot, in logical pixels, as layout measures it. */
  measureText(text: string, fontSlot: number): number;
  viewport: { width: number; height: number; rasterDensity: number; auxiliary: [number, number] | null };
  /** Frames stepped so far. */
  readonly frames: number;
  /** The guest's exception, once it threw. A failed world steps no further. */
  readonly failure: GuestFailure | null;
  /** Everything the guest wrote to `console`, oldest first. */
  logs: GuestLog[];
  effects: EffectEvent[];
  /** One virtual frame with this input, then the core's ticks. False once the guest has failed. */
  step(input?: StepInput): boolean;
  /** What a surface shows now. */
  pixels(surface?: SimSurface): SimPixels;
  /** The retained tree under a surface's root, with each node's box. */
  tree(surface?: SimSurface): SimNode | null;
}

const NODE_TYPE_NAMES = ["view", "text", "image", "surface"] as const;
const LOG_LEVELS = ["log", "info", "warn", "error", "debug"] as const;
/** spec ROOT_ID and ENUMS.Display.None, kept literal: this module stays host-side. */
const PRIMARY_ROOT = 1;
const DISPLAY_NONE = 1;

function failureOf(error: unknown, phase: GuestFailure["phase"], frame: number): GuestFailure {
  if (error instanceof Error) return { phase, frame, message: `${error.name}: ${error.message}`, stack: error.stack ?? "" };
  return { phase, frame, message: String(error), stack: "" };
}

/** One console call as one line: strings as written, everything else as JSON where it has one. */
function logText(args: unknown[]): string {
  return args
    .map((arg) => {
      if (typeof arg === "string") return arg;
      if (arg instanceof Error) return `${arg.name}: ${arg.message}`;
      try {
        return JSON.stringify(arg) ?? String(arg);
      } catch {
        return String(arg);
      }
    })
    .join(" ");
}

/** Boot a built bundle from its files and hand back a world to step, look at and read. */
export async function bootBundle(options: BundleOptions): Promise<BundleWorld> {
  const hz = normalizeHz(options.hz ?? TICKS_PER_SECOND);
  if (hz !== (options.hz ?? TICKS_PER_SECOND)) throw new Error(`sim: hz=${options.hz} does not divide ${TICKS_PER_SECOND}`);
  const wasmPath = options.wasm ?? WASM_PATH;
  if (!existsSync(wasmPath)) throw new Error(`sim: the wasm core is missing: ${wasmPath}`);
  if (!existsSync(options.js)) throw new Error(`sim: the bundle is missing: ${options.js}`);
  const app = options.app ?? options.js.replace(/^.*[\\/]/, "").replace(/\.js$/, "");
  const viewport = options.viewport ?? {};
  const density = viewport.rasterDensity ?? 1;
  const wasm = await createWasmUi(await Bun.file(wasmPath).arrayBuffer(), viewport);
  const ops = wasm.ops as unknown as Record<string, unknown> & {
    debugInspect?: (id: number) => void;
    debugRectXY?: () => number;
    debugRectWH?: () => number;
    hitTestBounds?: (x: number, y: number) => number;
    hitTestBoundsAuxiliary?: (x: number, y: number) => number;
    __viewport: { w: number; h: number };
    __auxiliarySurface?: { root: number; w: number; h: number };
  };

  const logs: GuestLog[] = [];
  const effects: EffectEvent[] = [];
  let frames = 0;
  let failure: GuestFailure | null = null;

  // The guest's console is the process's. While guest code runs, its lines
  // are kept with the frame that wrote them and printed nowhere.
  const host = globalThis.console as unknown as Record<string, (...args: unknown[]) => void>;
  const guest = <T>(run: () => T): T => {
    const kept = LOG_LEVELS.map((level) => host[level]);
    LOG_LEVELS.forEach((level) => {
      host[level] = (...args: unknown[]) => void logs.push({ frame: frames, level, text: logText(args) });
    });
    try {
      return run();
    } finally {
      LOG_LEVELS.forEach((level, index) => (host[level] = kept[index]!));
    }
  };

  const g = globalThis as Record<string, unknown>;
  const pak = options.pak && existsSync(options.pak) ? await Bun.file(options.pak).arrayBuffer() : undefined;
  // A font atlas names its slot, its line height and its weight in its header (spec FONT ATLAS).
  const fonts: SimFont[] = [];
  if (pak) {
    for (const blob of unpack(new Uint8Array(pak))) {
      if (!blob.key.startsWith("ui:font.") || blob.data.length < 16) continue;
      fonts.push({ slot: blob.data[12]!, lineHeight: blob.data[11]!, bold: (blob.data[13]! & 1) !== 0 });
    }
    fonts.sort((a, b) => a.slot - b.slot);
  }
  g.ui = wasm.ops;
  g.__pak = pak;
  g.frame = undefined;
  g.offload = undefined;
  g.audio = undefined;
  g.db = undefined;
  g.fs = undefined;
  g.__pocketApp = app;
  g.__simHz = hz;
  g.__pocketEffectTrace = (e: EffectEvent) => effects.push(e);
  g.__pocketEffectDriver = undefined;
  // No DevTools transport: the tree is read from the core, so the guest runs as it does in a browser realm.
  g.__pocketDevtoolsTransport = undefined;

  const source = await Bun.file(options.js).text();
  try {
    // The name is what a stack frame inside the bundle carries.
    guest(() => (0, eval)(`${source}\n//# sourceURL=${app}.js`));
    if (typeof g.frame !== "function") throw new Error("the bundle installed no frame function (its entry must call mount())");
  } catch (error) {
    failure = failureOf(error, "boot", 0);
  }
  const appFrame = g.frame as
    | ((buttons: number, analog?: number, touches?: readonly number[], hits?: readonly number[], touchSurfaces?: readonly number[]) => void)
    | undefined;

  let surface = 0;
  const hitFacts = createTouchHitFacts((x, y) =>
    surface ? ops.hitTestBoundsAuxiliary?.(x, y) ?? 0 : ops.hitTestBounds?.(x, y) ?? 0,
  );
  const ticksPerFrame = TICKS_PER_SECOND / hz;

  const rectOf = (id: number, auxiliary: boolean): SimNode["rect"] => {
    if (!ops.debugInspect || !ops.debugRectXY || !ops.debugRectWH) return null;
    // The core records the inspected node's box when it builds the draw list.
    ops.debugInspect(id);
    if (auxiliary) wasm.drawHashAuxiliary?.();
    else wasm.drawHash?.();
    const xy = ops.debugRectXY();
    if (xy === -1) return null;
    const wh = ops.debugRectWH();
    return [(xy << 16) >> 16, xy >> 16, wh & 0xffff, (wh >> 16) & 0xffff];
  };
  const inspect = (
    wasm as unknown as {
      inspectNode(id: number): { type: number; text: string; children: number[]; display: number; style: { bgColor: number; textColor: number } } | null;
    }
  ).inspectNode;
  const walk = (id: number, auxiliary: boolean, shown: boolean): SimNode | null => {
    const node = inspect(id);
    if (!node) return null;
    const hidden = node.display === DISPLAY_NONE;
    const children: SimNode[] = [];
    for (const child of node.children) {
      const entry = walk(child, auxiliary, shown && !hidden);
      if (entry) children.push(entry);
    }
    return {
      id,
      type: NODE_TYPE_NAMES[node.type] ?? "view",
      text: node.text,
      hidden,
      rect: shown && !hidden ? rectOf(id, auxiliary) : null,
      bgColor: node.style.bgColor,
      textColor: node.style.textColor,
      children,
    };
  };

  return {
    hz,
    ticksPerFrame,
    fonts,
    measureText: (text, fontSlot) => (wasm.ops as unknown as { measureText(text: string, slot: number): number }).measureText(text, fontSlot),
    viewport: {
      width: ops.__viewport.w,
      height: ops.__viewport.h,
      rasterDensity: density,
      auxiliary: ops.__auxiliarySurface ? [ops.__auxiliarySurface.w, ops.__auxiliarySurface.h] : null,
    },
    get frames() {
      return frames;
    },
    get failure() {
      return failure;
    },
    logs,
    effects,
    step(input = {}) {
      if (failure || !appFrame) return false;
      surface = input.surface === "auxiliary" ? 1 : 0;
      const touches = input.touches?.length
        ? input.touches.map((contact) => __packTouchWide(contact.id ?? 0, Math.round(contact.x), Math.round(contact.y)))
        : undefined;
      try {
        guest(() => {
          appFrame(input.buttons ?? 0, input.analog ?? 0x8080, touches, hitFacts(touches), touches?.map(() => surface));
          for (let t = 0; t < ticksPerFrame; t++) wasm.tick();
        });
      } catch (error) {
        failure = failureOf(error, "frame", frames);
        return false;
      }
      frames++;
      return true;
    },
    pixels(which = "primary") {
      if (which === "auxiliary") {
        const aux = ops.__auxiliarySurface;
        if (!aux) throw new Error("sim: this world has no auxiliary surface");
        return { width: aux.w, height: aux.h, rgba: wasm.renderAuxiliary().slice() };
      }
      return {
        width: ops.__viewport.w * density,
        height: ops.__viewport.h * density,
        rgba: (density === 1 ? wasm.render() : wasm.renderScaled(density)).slice(),
      };
    },
    tree(which = "primary") {
      const auxiliary = which === "auxiliary";
      const root = auxiliary ? ops.__auxiliarySurface?.root : PRIMARY_ROOT;
      if (!root) return null;
      try {
        return walk(root, auxiliary, true);
      } finally {
        // Drop the inspection so the next render paints no highlight.
        ops.debugInspect?.(0);
        wasm.drawHash?.();
        if (auxiliary) wasm.drawHashAuxiliary?.();
      }
    },
  };
}

/** Run one scenario to completion and return its trace. */
export async function runScenario(scenario: Scenario, chaos?: ChaosOptions): Promise<Trace> {
  const hz = normalizeHz(scenario.hz ?? TICKS_PER_SECOND);
  if (hz !== (scenario.hz ?? TICKS_PER_SECOND)) {
    throw new Error(`sim: hz=${scenario.hz} does not divide ${TICKS_PER_SECOND}`);
  }
  const frames = Math.round(scenario.seconds * hz);
  const { masks, analogs, touches } = scriptToMasks(scenario.script ?? [], hz, frames);
  const world = await bootWorld(scenario.app, hz);
  const hashes: string[] = [];
  let garbage: unknown[] = [];
  for (let f = 0; f < frames; f++) {
    if (chaos) {
      // Real nondeterminism, injected on purpose: variable wall-clock delay,
      // allocation pressure, forced GC. None of it may reach the trace.
      await new Promise((r) => setTimeout(r, Math.random() * (chaos.maxSleepMs ?? 5)));
      garbage.push(new Array(1024).fill(f));
      if (garbage.length > 64) garbage = [];
      if (chaos.gcEvery && f % chaos.gcEvery === chaos.gcEvery - 1) Bun.gc(true);
    }
    world.frame(masks[f], analogs[f], touches[f]); // one virtual-frame transaction (JS side)
    for (let t = 0; t < world.ticksPerFrame; t++) world.tick(); // core catch-up
    hashes.push(fnv1a(world.render()));
  }
  const finalFrame = world.render().slice();
  const tree = world.getTree();
  return { app: scenario.app, hz, frames, hashes, effects: world.effects.slice(), finalFrame, tree };
}

/** Depth-first search of a DevTools tree (TreeNodeJson: text = `x`, children
 *  = `k`) for a text node containing `text` — the sim's selector query. */
export function treeHasText(tree: unknown, text: string): boolean {
  if (tree == null) return false;
  const node = tree as { x?: unknown; k?: unknown[] };
  if (typeof node.x === "string" && node.x.includes(text)) return true;
  return Array.isArray(node.k) && node.k.some((c) => treeHasText(c, text));
}
