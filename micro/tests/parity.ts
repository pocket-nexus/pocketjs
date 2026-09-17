#!/usr/bin/env bun
// micro/tests/parity.ts — Pocket Micro vs Solid, pixel for pixel.
//
// Compiles an app with the Micro CLI, builds the desktop harness around the
// generated module, drives the app's golden tape (tests/golden-specs.ts) and
// byte-compares the harness's software-rasterized frames against the Solid
// web goldens in tests/goldens/web/. The oracle is the stock Solid bundle
// under the wasm core; the candidate is the compiled Rust under the same
// core and rasterizer. Same tape, same frames, same PNG encoder.
//
//   bun micro/tests/parity.ts [app] [--run <dir>]   default app: hero

import { existsSync, mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { $ } from "bun";
import { GOLDEN_SPECS } from "../../tests/golden-specs.ts";
import { encodePNG } from "../../tests/png.ts";
import { oracleFrames } from "./oracle.ts";
import { SCREEN_H, SCREEN_W } from "../../contracts/spec/spec.ts";

const ROOT = resolve(new URL("../..", import.meta.url).pathname);
const args = process.argv.slice(2);
const app = args.find((a) => !a.startsWith("--")) ?? "hero";
const runFlag = args.indexOf("--run");
const runDir = resolve(runFlag >= 0 ? args[runFlag + 1] : join(ROOT, ".pocket-build/validation/pocket-micro/parity", String(Date.now())));
mkdirSync(runDir, { recursive: true });

export interface ParityResult {
  app: string;
  /** Per captured frame: byte equality with the fresh Solid oracle frame,
   *  and (informational) with the committed web golden. */
  frames: { frame: number; oracle: string; match: boolean; golden: string; goldenMatch: boolean; actual: string; differing?: number }[];
  state: unknown;
  runDir: string;
}

export function tapeFor(spec: (typeof GOLDEN_SPECS)[number]): string {
  // The golden input function is per-frame; encode it as "frame:mask" thresholds.
  const parts: string[] = ["0:0"];
  let prev = 0;
  for (let f = 0; f < spec.frames; f++) {
    const mask = spec.input ? spec.input(f) : 0;
    if (mask !== prev) {
      parts.push(`${f}:${mask}`);
      prev = mask;
    }
  }
  if (prev !== 0) parts.push(`${spec.frames}:0`);
  return parts.join(",");
}

export async function runParity(appName: string, out: string): Promise<ParityResult> {
  const spec = GOLDEN_SPECS.find((s) => (s.app ?? s.name) === `${appName}-main` || s.name === appName);
  if (!spec) throw new Error(`no golden spec for ${appName}`);
  const dist = join(out, "build");
  await $`bun micro/compiler/cli.ts build ${appName} --out ${dist}`.cwd(ROOT).quiet();
  const harnessDir = join(ROOT, "micro/harness");
  const targetDir = join(ROOT, ".pocket-build/validation/pocket-micro/harness-target");
  const env = { ...process.env, POCKET_MICRO_APP_RS: join(dist, "app.rs"), CARGO_TARGET_DIR: targetDir };
  const build = Bun.spawnSync(["cargo", "build", "--quiet"], { cwd: harnessDir, env, stdout: "pipe", stderr: "pipe" });
  await Bun.write(join(out, "cargo-build.log"), build.stdout.toString() + build.stderr.toString());
  if (build.exitCode !== 0) throw new Error(`harness build failed:\n${build.stderr.toString()}`);
  const tape = tapeFor(spec);
  await Bun.write(join(out, "tape.txt"), tape + "\n");
  const frames = join(out, "frames");
  const run = Bun.spawnSync(
    [join(targetDir, "debug/pocket-micro-harness"), join(dist, `${appName}.pak`), tape, String(spec.frames), frames, spec.capture.join(",")],
    { stdout: "pipe", stderr: "pipe" },
  );
  if (run.exitCode !== 0) throw new Error(`harness run failed:\n${run.stderr.toString()}`);
  const state = JSON.parse(run.stdout.toString().trim().split("\n").pop()!);
  const oracle = await oracleFrames(spec, join(out, "oracle"));
  const result: ParityResult = { app: appName, frames: [], state, runDir: out };
  const same = (a: Uint8Array, b: Uint8Array) => a.length === b.length && a.every((v, i) => v === b[i]);
  for (const f of spec.capture) {
    const rgba = new Uint8Array(await Bun.file(join(frames, `f${f}.rgba`)).arrayBuffer());
    const png = encodePNG(rgba, SCREEN_W, SCREEN_H);
    const actualPath = join(out, `${spec.name}.${f}.micro.png`);
    await Bun.write(actualPath, png);
    const oraclePath = oracle.get(f)!;
    const oraclePng = new Uint8Array(await Bun.file(oraclePath).arrayBuffer());
    const match = same(oraclePng, png);
    const goldenPath = join(ROOT, "tests/goldens/web", `${spec.name}.${f}.png`);
    const goldenMatch = existsSync(goldenPath) && same(new Uint8Array(await Bun.file(goldenPath).arrayBuffer()), png);
    result.frames.push({ frame: f, oracle: oraclePath, match, golden: goldenPath, goldenMatch, actual: actualPath });
  }
  await Bun.write(join(out, "result.json"), JSON.stringify(result, null, 2) + "\n");
  return result;
}

if (import.meta.main) {
  const result = await runParity(app, runDir);
  console.log(`Pocket Micro parity: ${app} (${runDir})`);
  console.log(`  state: ${JSON.stringify(result.state)}`);
  let fail = 0;
  for (const f of result.frames) {
    console.log(`  frame ${f.frame}: ${f.match ? "MATCH" : "DIFF "} vs fresh Solid oracle; committed golden ${f.goldenMatch ? "matches" : "differs"} (${f.golden})`);
    if (!f.match) fail++;
  }
  process.exit(fail ? 1 : 0);
}
