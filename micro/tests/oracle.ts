#!/usr/bin/env bun
// micro/tests/oracle.ts — fresh Solid oracle frames for one golden spec.
//
// Builds the stock Solid bundle of an app (tools/build.ts), runs it under the
// wasm core exactly as tests/golden.ts does (frame(input) -> tick -> render),
// and writes the captured frames as PNGs. parity.ts compares the compiled
// Rust against these frames, so a stale committed golden never masks or
// fakes a parity result.

import { existsSync, mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { createWasmUi } from "../../hosts/web/wasm-ops.js";
import { SCREEN_H, SCREEN_W } from "../../contracts/spec/spec.ts";
import { createTouchHitFacts } from "../../framework/src/touch.ts";
import { GOLDEN_SPECS, packedTouchFor, type GoldenSpec } from "../../tests/golden-specs.ts";
import { encodePNG } from "../../tests/png.ts";

const ROOT = resolve(new URL("../..", import.meta.url).pathname);
const WASM_PATH = join(ROOT, "hosts/web/pocketjs.wasm");

function ensure(path: string, cmd: string[]): void {
  if (existsSync(path)) return;
  const p = Bun.spawnSync(cmd, { cwd: ROOT, stdout: "inherit", stderr: "inherit" });
  if (p.exitCode !== 0 || !existsSync(path)) throw new Error(`failed to produce ${path}`);
}

/** Capture the spec's frames from the Solid bundle; returns frame -> PNG path. */
export async function oracleFrames(spec: GoldenSpec, out: string): Promise<Map<number, string>> {
  mkdirSync(out, { recursive: true });
  const bundle = spec.app ?? spec.name;
  const dist = join(out, "dist");
  const build = Bun.spawnSync([process.execPath, "tools/build.ts", bundle, `--outdir=${dist}`], { cwd: ROOT, stdout: "pipe", stderr: "pipe" });
  await Bun.write(join(out, "solid-build.log"), build.stdout.toString() + build.stderr.toString());
  if (build.exitCode !== 0) throw new Error(`Solid build failed:\n${build.stderr.toString()}`);
  ensure(WASM_PATH, [process.execPath, "tools/wasm.ts"]);
  const wasm = await createWasmUi(await Bun.file(WASM_PATH).arrayBuffer());
  const g = globalThis as Record<string, unknown>;
  g.ui = wasm.ops;
  g.__pak = await Bun.file(join(dist, `${bundle}.pak`)).arrayBuffer();
  g.frame = undefined;
  const paths = new Map<number, string>();
  try {
    (0, eval)(await Bun.file(join(dist, `${bundle}.js`)).text());
    const frame = g.frame as (buttons: number, analog?: number, touches?: readonly number[], hits?: readonly number[]) => void;
    if (typeof frame !== "function") throw new Error("bundle did not install globalThis.frame");
    const boundsQuery = (wasm.ops as { hitTestBounds?: (x: number, y: number) => number }).hitTestBounds;
    const hitFacts = boundsQuery ? createTouchHitFacts(boundsQuery) : undefined;
    const want = new Set(spec.capture);
    for (let f = 0; f < spec.frames; f++) {
      const packed = packedTouchFor(spec, f);
      frame(spec.input ? spec.input(f) : 0, undefined, packed, hitFacts?.(packed));
      wasm.tick();
      if (want.has(f)) {
        const path = join(out, `${spec.name}.${f}.solid.png`);
        await Bun.write(path, encodePNG(wasm.render().slice(), SCREEN_W, SCREEN_H));
        paths.set(f, path);
      }
    }
  } finally {
    delete g.ui;
    delete g.__pak;
    g.frame = undefined;
  }
  return paths;
}

if (import.meta.main) {
  const app = process.argv[2] ?? "hero";
  const spec = GOLDEN_SPECS.find((s) => (s.app ?? s.name) === `${app}-main` || s.name === app);
  if (!spec) throw new Error(`no golden spec for ${app}`);
  const out = resolve(process.argv[3] ?? join(ROOT, ".pocket-build/validation/pocket-micro/oracle", String(Date.now())));
  const frames = await oracleFrames(spec, out);
  for (const [f, p] of frames) console.log(`frame ${f}: ${p}`);
}
