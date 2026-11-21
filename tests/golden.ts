// tests/golden.ts — headless byte-exact pixel goldens for the wasm rasterizer.
//
// Loads platforms/web/pocketjs.wasm under Bun, installs the SAME HostOps binding the
// browser host uses (platforms/web/wasm-ops.js), evals a dist/<demo>.js bundle with
// globalThis.ui + globalThis.__pak pre-installed (the host contract), drives
// N fixed-dt frames with a scripted input function, captures the RGBA
// framebuffer at chosen frames and byte-compares the encoded PNG against the
// committed tests/goldens/web/<demo>.<frame>.png.
//
//   bun tests/golden.ts            # rebuild isolated bundles, then compare
//   UPDATE=1 bun tests/golden.ts   # (re)write goldens
//
// Determinism: core ticks exactly 1/60 s per frame (frame content is a pure
// function of frame index), the rasterizer is integer/exact-f32 math, and the
// PNG encoder (Bun.deflateSync) is deterministic — so byte equality holds.
// On mismatch a <demo>.<frame>.actual.png is written next to the golden.

import { existsSync, mkdirSync, rmSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join, resolve } from "node:path";
import { createWasmUi } from "../platforms/web/wasm-ops.js";
import { SCREEN_H, SCREEN_W } from "../contracts/spec/spec.ts";
import { GOLDEN_SPECS, packedTouchFor, type GoldenSpec } from "./golden-specs.ts";
import { createTouchHitFacts } from "../framework/src/touch.ts";

const ROOT = resolve(fileURLToPath(new URL("..", import.meta.url))); // PocketJS/
// Goldens never consume the shared dist/ directory: it may contain ignored,
// stale, or half-rebuilt artifacts from another host command. Rebuilding each
// demo serially into this dedicated directory also keeps every .js/.pak pair
// from the same compiler invocation.
const DIST = join(ROOT, "dist/golden/");
const GOLDEN_DIR = join(ROOT, "tests/goldens/web/");
const WASM_PATH = join(ROOT, "platforms/web/pocketjs.wasm");
const UPDATE = !!process.env.UPDATE;

const W = SCREEN_W;
const H = SCREEN_H;

// ---------------------------------------------------------------------------
// Build artifacts
// ---------------------------------------------------------------------------

function ensureBuilt(path: string, cmd: string[]): void {
  if (existsSync(path)) return;
  console.log(`golden: ${path.slice(ROOT.length)} missing — running: ${cmd.join(" ")}`);
  const p = Bun.spawnSync(cmd, { cwd: ROOT, stdout: "inherit", stderr: "inherit" });
  if (p.exitCode !== 0 || !existsSync(path)) {
    console.error(`golden: failed to produce ${path}`);
    process.exit(1);
  }
}

function buildDemo(name: string): void {
  const output = DIST + name + ".js";
  const cmd = [process.execPath, "tools/build.ts", name, `--outdir=${DIST}`];
  console.log(`golden: rebuilding ${name}`);
  const p = Bun.spawnSync(cmd, { cwd: ROOT, stdout: "inherit", stderr: "inherit" });
  if (p.exitCode !== 0 || !existsSync(output)) {
    console.error(`golden: failed to produce ${output}`);
    process.exit(1);
  }
}

// ---------------------------------------------------------------------------
// Minimal deterministic PNG encoder — shared with tools/tape.ts (tests/png.ts)
// ---------------------------------------------------------------------------

import { encodePNG as encodePNGShared } from "./png.ts";

function encodePNG(rgba: Uint8Array): Buffer {
  return encodePNGShared(rgba, W, H);
}

/** Distinct packed-pixel count — a golden must never be one flat color. */
function distinctPixels(rgba: Uint8Array): number {
  const seen = new Set<number>();
  const u32 = new Uint32Array(rgba.buffer, rgba.byteOffset, W * H);
  for (let i = 0; i < u32.length; i++) {
    seen.add(u32[i]);
    if (seen.size > 16) break; // enough to prove non-triviality
  }
  return seen.size;
}

// ---------------------------------------------------------------------------
// Demo specs (scripted input per docs/DESIGN.md testing plan)
// ---------------------------------------------------------------------------

const SPECS = GOLDEN_SPECS;

// ---------------------------------------------------------------------------
// Runner
// ---------------------------------------------------------------------------

ensureBuilt(WASM_PATH, [process.execPath, "tools/wasm.ts"]);
rmSync(DIST, { recursive: true, force: true });
mkdirSync(DIST, { recursive: true });
for (const bundle of new Set(SPECS.map((spec) => spec.app ?? spec.name))) buildDemo(bundle);
mkdirSync(GOLDEN_DIR, { recursive: true });

const wasmBytes = await Bun.file(WASM_PATH).arrayBuffer();

async function runDemo(spec: GoldenSpec): Promise<Map<number, Uint8Array>> {
  // A fresh wasm instance per demo: fresh core, zero cross-demo state.
  const wasm = await createWasmUi(wasmBytes);
  const g = globalThis as Record<string, unknown>;
  const bundle = spec.app ?? spec.name;
  g.ui = wasm.ops; // the host contract: HostOps BEFORE eval
  g.__pak = existsSync(DIST + bundle + ".pak")
    ? await Bun.file(DIST + bundle + ".pak").arrayBuffer()
    : undefined;
  g.frame = undefined;
  try {
    const src = await Bun.file(DIST + bundle + ".js").text();
    (0, eval)(src); // IIFE mounts the app and installs globalThis.frame
    const frame = g.frame as
      | ((buttons: number, analog?: number, touches?: readonly number[], hits?: readonly number[]) => void)
      | undefined;
    if (typeof frame !== "function") {
      throw new Error("bundle did not install globalThis.frame (does the entry call render()?)");
    }
    // Touch hit facts: the oracle is a host too — resolve at the down edge,
    // carry per contact, deliver as frame() arg 4 (docs/TOUCH.md).
    const boundsQuery = (wasm.ops as { hitTestBounds?: (x: number, y: number) => number })
      .hitTestBounds;
    const hitFacts = boundsQuery ? createTouchHitFacts(boundsQuery) : undefined;
    const captures = new Map<number, Uint8Array>();
    const want = new Set(spec.capture);
    for (let f = 0; f < spec.frames; f++) {
      // input + effects + sweep (touch rides args 3+4)
      const packed = packedTouchFor(spec, f);
      frame(spec.input ? spec.input(f) : 0, undefined, packed, hitFacts?.(packed));
      wasm.tick(); // anims + layout, exactly 1/60 s
      if (want.has(f)) captures.set(f, wasm.render().slice());
    }
    return captures;
  } finally {
    delete g.ui;
    delete g.__pak;
    g.frame = undefined;
  }
}

let pass = 0;
let fail = 0;
for (const spec of SPECS) {
  let captures: Map<number, Uint8Array>;
  try {
    captures = await runDemo(spec);
  } catch (e) {
    console.log("FAIL ", spec.name, "- threw:", (e as Error)?.stack ?? e);
    fail++;
    continue;
  }
  for (const f of spec.capture) {
    const label = `${spec.name}.${f}`;
    const buf = captures.get(f)!;
    const distinct = distinctPixels(buf);
    if (distinct < 3) {
      console.log("FAIL ", label, `- degenerate frame (${distinct} distinct pixel value(s))`);
      await Bun.write(GOLDEN_DIR + label + ".actual.png", encodePNG(buf));
      fail++;
      continue;
    }
    const png = encodePNG(buf);
    const goldPath = GOLDEN_DIR + label + ".png";
    if (UPDATE || !existsSync(goldPath)) {
      await Bun.write(goldPath, png);
      console.log(UPDATE ? "WROTE" : "NEW  ", label);
      pass++;
    } else {
      const gold = new Uint8Array(await Bun.file(goldPath).arrayBuffer());
      let diff = png.length !== gold.length ? 1 : 0;
      for (let i = 0; i < png.length && diff === 0; i++) {
        if (png[i] !== gold[i]) diff = 1;
      }
      if (diff === 0) {
        console.log("PASS ", label);
        pass++;
      } else {
        await Bun.write(GOLDEN_DIR + label + ".actual.png", png);
        console.log("FAIL ", label, "- PNG bytes differ (see " + label + ".actual.png)");
        fail++;
      }
    }
  }
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
