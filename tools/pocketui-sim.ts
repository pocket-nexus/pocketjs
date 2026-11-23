#!/usr/bin/env bun
// tools/pocketui-sim.ts — run a PocketUI application on the simulation host
// (programs/sim/sim.ts bootBundle) and drive it by steps.
//
//   bun tools/pocketui-sim.ts [--config <pocket.host.config.ts>] [--target <host id>]
//                             [--size WxH] [--do "<steps>"] [--shot out.png]
//
// Without --config it runs the gallery (apps/pocketui). --target picks one of
// the config's hosts (default its first); the build is what `pocket compile`
// makes for that host, and the world has that host's viewport, raster density
// and auxiliary surface. --size gives a live-viewport host's window that size.
//
// Steps, separated by ";":
//   frames:N               run N frames
//   tap:X,Y                a tap                     hold:X,Y[,N]  a contact held N frames
//   drag:X0,Y0,X1,Y1[,N]   a drag over N frames (default 12)
//   lift:X0,Y0,X1,Y1[,H,N] a contact held H frames (a long press), then dragged over N frames and let go;
//                          liftshot:FILE before it takes a PNG while the contact is still down
//   press:NAME             a button: UP DOWN LEFT RIGHT CIRCLE CROSS TRIANGLE SQUARE LTRIGGER RTRIGGER START SELECT
//   type:TEXT              the keyboard commits TEXT  key:NAME  an editing key (KeyboardEvent.key)
//   hover:X,Y | hover:off  a pointer rests there without pressing, until hover:off
//   click:X,Y              the pointer's primary button pressed and released there
//   wheel:X,Y,DY           one frame of wheel scrolling at a point (positive DY toward the end)
//   resize:W,H             the window takes a new size (display.viewport.live)
//   shot:FILE              a PNG of the surface      texts  print the painted texts
//   cmd:ID                 run one of the application's commands by its id
//   theme:ID               ask the application for another theme (globalThis.__pocketUISetTheme, where it sets one)
//
// The functions are exported for an application repository's own tool and
// tests: it builds its config with buildApp and adds the globals it needs.
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { BTN } from "../contracts/spec/spec.ts";
import { bootBundle, type BundleWorld, type SimNode, type SimPointer, type SimSurface, type StepInput } from "../programs/sim/sim.ts";
import { compileApplication } from "./compile-app.ts";
import { encodePNG } from "./png.ts";

const ROOT = resolve(import.meta.dir, "..");
export const GALLERY = join(ROOT, "apps/pocketui/pocket.host.config.ts");

export interface BuildOptions {
  /** one of the config's hosts (default: its first) */
  target?: string;
  /** the directory the application's imports stay inside (default: the config's) */
  projectRoot?: string;
  /** where the guest and its plan go (default: <projectRoot>/.pocket/pocketui-sim/<target>) */
  outdir?: string;
}

export interface BuiltApp {
  js: string;
  pak: string;
  viewport: { width: number; height: number; rasterDensity: number; auxiliary?: [number, number] };
  /** the surface the application's touch is on */
  surface: SimSurface;
}

/** Compile an application for one host, as `pocket compile` does, and say what world it runs in. */
export async function buildApp(configPath: string, options: BuildOptions = {}): Promise<BuiltApp> {
  const config = resolve(configPath);
  const projectRoot = resolve(options.projectRoot ?? dirname(config));
  const work = resolve(options.outdir ?? join(projectRoot, ".pocket/pocketui-sim", options.target ?? "default"));
  const compiled = await compileApplication({ configPath: config, target: options.target, projectRoot, outdir: join(work, "guest"), planRoot: join(work, "plan"), output: join(work, "app.pkb") });
  const plan = compiled.plan as unknown as {
    app: { output: string };
    viewport: { logical: [number, number]; rasterDensity: number };
    surfaces?: { auxiliary?: { logical: [number, number] } };
    modality: { touch: string };
  };
  const auxiliary = plan.surfaces?.auxiliary?.logical;
  const guest = join(work, "guest", plan.app.output);
  return {
    js: `${guest}.js`,
    pak: `${guest}.pak`,
    viewport: { width: plan.viewport.logical[0], height: plan.viewport.logical[1], rasterDensity: plan.viewport.rasterDensity, ...(auxiliary ? { auxiliary } : {}) },
    surface: plan.modality.touch === "auxiliary" || auxiliary ? "auxiliary" : "primary",
  };
}

export interface SimOptions {
  /** installed on globalThis before the bundle evaluates (a service's bridge) */
  globals?: Record<string, unknown>;
  /** requests still being answered in real time: each frame waits for them */
  busy?: () => number;
}

export interface Sim {
  world: BundleWorld;
  surface: SimSurface;
  run(frames: number): Promise<void>;
  tap(x: number, y: number): Promise<void>;
  hold(x: number, y: number, frames: number): Promise<void>;
  drag(x0: number, y0: number, x1: number, y1: number, frames?: number): Promise<void>;
  /** a contact held still (a long press), then moved and let go: a drag of a lifted thing */
  lift(x0: number, y0: number, x1: number, y1: number, hold?: number, frames?: number): Promise<void>;
  /** called while a `lift` is still down at its end point */
  mid?: () => void;
  /** where a pointer rests without pressing, while it does */
  hoverAt: [number, number] | null;
  click(x: number, y: number): Promise<void>;
  wheel(x: number, y: number, dy: number): Promise<void>;
  press(name: keyof typeof BTN, settle?: number): Promise<void>;
  type(text: string): Promise<void>;
  key(name: string): Promise<void>;
  resize(width: number, height: number): Promise<void>;
  texts(): string[];
  shot(file: string): void;
  /** the guest's console lines since the last call */
  logs(): string[];
}

const settle = () => new Promise<void>((done) => setTimeout(done, 5));

/** Boot a built application and hand back a simulator to drive it. */
export async function bootSim(app: BuiltApp, options: SimOptions = {}): Promise<Sim> {
  for (const [key, value] of Object.entries(options.globals ?? {})) (globalThis as Record<string, unknown>)[key] = value;
  const world = await bootBundle({ js: app.js, pak: app.pak, viewport: app.viewport });
  const surface = app.surface;
  let seen = 0;
  const step = async (input: StepInput = {}) => {
    const pointer: SimPointer | undefined = input.pointer ?? (sim.hoverAt ? { x: sim.hoverAt[0], y: sim.hoverAt[1], surface } : undefined);
    if (!world.step({ ...input, surface, ...(pointer ? { pointer } : {}) })) throw new Error(`the application failed: ${world.failure?.message}\n${world.failure?.stack ?? ""}`);
    // a service that answers in real time (a glyph atlas being drawn) gets the time it needs
    for (let waited = 0; options.busy && options.busy() > 0 && waited < 400; waited++) await settle();
  };
  const touch = (x: number, y: number): StepInput => ({ touches: [{ id: 1, x, y }] });
  const sim: Sim = {
    world,
    surface,
    hoverAt: null,
    async run(frames) {
      for (let i = 0; i < frames; i++) await step();
    },
    async tap(x, y) {
      await step(touch(x, y));
      await step(touch(x, y));
      await sim.run(6);
    },
    async hold(x, y, frames) {
      for (let i = 0; i < frames; i++) await step(touch(x, y));
      await sim.run(4);
    },
    async drag(x0, y0, x1, y1, frames = 12) {
      for (let i = 0; i <= frames; i++) await step(touch(x0 + ((x1 - x0) * i) / frames, y0 + ((y1 - y0) * i) / frames));
      await sim.run(6);
    },
    async lift(x0, y0, x1, y1, hold = 40, frames = 16) {
      for (let i = 0; i < hold; i++) await step(touch(x0, y0));
      for (let i = 1; i <= frames; i++) await step(touch(x0 + ((x1 - x0) * i) / frames, y0 + ((y1 - y0) * i) / frames));
      sim.mid?.();
      await step(touch(x1, y1));
      await sim.run(6);
    },
    async click(x, y) {
      // a desktop host sends the press as a contact beside the pointer that holds the button (pointer.ts)
      for (let i = 0; i < 2; i++) await step({ ...touch(x, y), pointer: { x, y, buttons: 1, surface } });
      await step({ pointer: { x, y, surface } });
      await sim.run(6);
    },
    async wheel(x, y, dy) {
      await step({ pointer: { x, y, scrollY: dy, surface } });
      await sim.run(2);
    },
    async press(name, frames = 6) {
      await step({ buttons: BTN[name] });
      await sim.run(frames);
    },
    async type(text) {
      await step({ text: [{ commit: text }] });
      await sim.run(2);
    },
    async key(name) {
      await step({ text: [{ key: name }] });
      await step({ text: [{ key: name, pressed: false }] });
      await sim.run(2);
    },
    async resize(width, height) {
      world.resize(width, height);
      await sim.run(4);
    },
    texts() {
      const out: string[] = [];
      // a run of characters has no box of its own: the <Text> element above it has, where it painted
      const walk = (node: SimNode | null, painted: boolean) => {
        if (!node || node.hidden) return;
        if (node.type === "text" && node.text && (node.rect || painted)) out.push(node.text);
        for (const child of node.children) walk(child, node.rect !== null);
      };
      walk(world.tree(surface), false);
      return out;
    },
    shot(file) {
      const pixels = world.pixels(surface);
      mkdirSync(dirname(resolve(file)), { recursive: true });
      writeFileSync(resolve(file), encodePNG(pixels.rgba, pixels.width, pixels.height));
    },
    logs() {
      const out = world.logs.slice(seen).map((log) => `[${log.frame}] ${log.text}`);
      seen = world.logs.length;
      return out;
    },
  };
  return sim;
}

/** Run a ";"-separated list of steps (the header's). */
export async function runSteps(sim: Sim, steps: string): Promise<void> {
  for (const step of steps.split(";").map((s) => s.trim()).filter(Boolean)) {
    const colon = step.indexOf(":");
    const op = colon < 0 ? step : step.slice(0, colon);
    const arg = colon < 0 ? "" : step.slice(colon + 1);
    const nums = arg.split(",").map(Number);
    switch (op) {
      case "frames": await sim.run(nums[0]!); break;
      case "tap": await sim.tap(nums[0]!, nums[1]!); break;
      case "hold": await sim.hold(nums[0]!, nums[1]!, nums[2] ?? 40); break;
      case "drag": await sim.drag(nums[0]!, nums[1]!, nums[2]!, nums[3]!, nums[4] ?? 12); break;
      case "lift": await sim.lift(nums[0]!, nums[1]!, nums[2]!, nums[3]!, nums[4] ?? 40, nums[5] ?? 16); break;
      case "liftshot": sim.mid = () => sim.shot(arg); break;
      case "press": await sim.press(arg as keyof typeof BTN); break;
      case "hover": sim.hoverAt = arg === "off" ? null : [nums[0]!, nums[1]!]; await sim.run(3); break;
      case "click": await sim.click(nums[0]!, nums[1]!); break;
      case "wheel": await sim.wheel(nums[0]!, nums[1]!, nums[2]!); break;
      case "resize": await sim.resize(nums[0]!, nums[1]!); break;
      case "type": await sim.type(arg); break;
      case "key": await sim.key(arg); break;
      case "shot": sim.shot(arg); console.log(`shot ${arg}`); break;
      case "texts": console.log(sim.texts()); break;
      case "cmd": {
        const ui = (globalThis as { __pocketUI?: { commands: { run(id: string): boolean } } }).__pocketUI;
        if (!ui?.commands.run(arg)) console.log(`cmd ${arg}: not offered`);
        await sim.run(3);
        break;
      }
      case "theme": {
        const set = (globalThis as { __pocketUISetTheme?: (id: string) => void }).__pocketUISetTheme;
        if (set) set(arg);
        else console.log("theme: this application sets no theme hook");
        await sim.run(3);
        break;
      }
      default: throw new Error(`unknown step ${op}`);
    }
    for (const line of sim.logs()) console.log(line);
  }
}

if (import.meta.main) {
  const argv = process.argv.slice(2);
  const opt = (name: string) => {
    const at = argv.indexOf(name);
    return at >= 0 ? argv[at + 1] : undefined;
  };
  const started = performance.now();
  const app = await buildApp(opt("--config") ?? GALLERY, { target: opt("--target") });
  const sim = await bootSim(app);
  const size = opt("--size")?.split("x").map(Number);
  if (size) sim.world.resize(size[0]!, size[1]!);
  await sim.run(30);
  for (const line of sim.logs()) console.log(line);
  await runSteps(sim, opt("--do") ?? "");
  const shot = opt("--shot");
  if (shot) sim.shot(shot);
  console.log(`done in ${Math.round(performance.now() - started)} ms`);
  process.exit(0);
}
