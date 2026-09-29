// tools/sortie.ts — records apps/sortie (POCKET SORTIE) to an mp4.
//
//   bun tools/sortie.ts                      # record the MV, scaled 4x, with sound
//   bun tools/sortie.ts --stills=0,240,900   # write those frames as PNGs instead
//   bun tools/sortie.ts --scale=1 --silent   # 480x272, no audio track
//
// The wasm core renders every frame headlessly — the same deterministic boot as
// tools/tape.ts and site/record-sim-clips.ts — and the raw RGBA is piped into
// ffmpeg. There is no capture, no screen and no timing jitter: frame N of the
// mp4 is frame N of the simulation, and a rerun is byte-identical.
//
// The picture leaves the core at the app's own 480x272 and is enlarged by an
// integer nearest-neighbour scale, so every source pixel stays a square block of
// output pixels. 4x gives 1920x1088.
//
// Output (git-ignored, per CLAUDE.md):
//   .pocket-build/validation/sortie/<run>/pocketjs-sortie.mp4
//   .pocket-build/validation/sortie/<run>/poster.png

import { existsSync, mkdirSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createWasmUi } from "../hosts/web/wasm-ops.js";
import { encodePNG } from "./png.ts";
import { SCREEN_H, SCREEN_W } from "../contracts/spec/spec.ts";
import { RUNTIME_SECONDS } from "../apps/sortie/timing.ts";

const ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)));
const APP = "sortie-main";
const WASM_PATH = join(ROOT, "hosts/web/pocketjs.wasm");
const SCORE = join(ROOT, "apps/sortie/media/sortie.wav");
const BUILD_DIST = join(ROOT, ".pocket-build/sortie-build");

const HZ = 60;
const FRAMES = Math.round(RUNTIME_SECONDS * HZ);

const args = process.argv.slice(2);
const flag = (name: string): string | undefined =>
  args.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3);
const scale = Number(flag("scale") ?? 4);
const silent = args.includes("--silent");
const stills = flag("stills")
  ?.split(",")
  .map((n) => {
    const frame = Number(n);
    if (!Number.isInteger(frame) || frame < 0 || frame >= FRAMES) {
      throw new Error(`sortie: still frame ${n} is outside 0..${FRAMES - 1}`);
    }
    return frame;
  });
if (!Number.isInteger(scale) || scale < 1 || scale > 8) {
  throw new Error(`sortie: --scale must be an integer from 1 through 8 (got ${scale})`);
}

const run = flag("out") ?? new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
const OUT_DIR = join(ROOT, ".pocket-build/validation/sortie", run);

function build(): string {
  rmSync(BUILD_DIST, { recursive: true, force: true });
  mkdirSync(BUILD_DIST, { recursive: true });
  const p = Bun.spawnSync(["bun", "tools/build.ts", APP, `--outdir=${BUILD_DIST}`], {
    cwd: ROOT,
    stdout: "inherit",
    stderr: "inherit",
  });
  if (p.exitCode !== 0 || !existsSync(join(BUILD_DIST, `${APP}.js`))) {
    throw new Error("sortie: build failed");
  }
  return BUILD_DIST;
}

/** Same boot dance as tools/tape.ts — fresh core, the bundle installs frame(). */
async function boot(dist: string) {
  if (!existsSync(WASM_PATH)) {
    const p = Bun.spawnSync(["bun", "tools/wasm.ts"], { cwd: ROOT, stdout: "inherit", stderr: "inherit" });
    if (p.exitCode !== 0) throw new Error("sortie: wasm build failed");
  }
  const wasm = await createWasmUi(await Bun.file(WASM_PATH).arrayBuffer());
  const g = globalThis as Record<string, unknown>;
  g.ui = wasm.ops;
  g.__pak = await Bun.file(join(dist, `${APP}.pak`)).arrayBuffer();
  g.frame = undefined;
  g.__pocketApp = APP;
  (0, eval)(await Bun.file(join(dist, `${APP}.js`)).text());
  const frame = g.frame as ((buttons: number) => void) | undefined;
  if (typeof frame !== "function") throw new Error(`sortie: ${APP} did not install globalThis.frame`);
  return { frame, tick: wasm.tick, render: () => wasm.render() };
}

/** Nearest-neighbour enlargement: one source pixel becomes a scale x scale block. */
function enlarge(rgba: Uint8Array, n: number): Uint8Array {
  if (n === 1) return rgba;
  const w = SCREEN_W * n;
  const out = new Uint8Array(w * SCREEN_H * n * 4);
  for (let y = 0; y < SCREEN_H; y++) {
    const rowStart = y * n * w * 4;
    for (let x = 0; x < SCREEN_W; x++) {
      const s = (y * SCREEN_W + x) * 4;
      for (let dx = 0; dx < n; dx++) {
        const d = rowStart + (x * n + dx) * 4;
        out[d] = rgba[s];
        out[d + 1] = rgba[s + 1];
        out[d + 2] = rgba[s + 2];
        out[d + 3] = rgba[s + 3];
      }
    }
    // The first output row of this source row is built; the rest are copies.
    const row = out.subarray(rowStart, rowStart + w * 4);
    for (let dy = 1; dy < n; dy++) out.set(row, rowStart + dy * w * 4);
  }
  return out;
}

const dist = build();
const core = await boot(dist);
mkdirSync(OUT_DIR, { recursive: true });

if (stills) {
  const wanted = new Set(stills);
  for (let f = 0; f < FRAMES && wanted.size > 0; f++) {
    core.frame(0);
    core.tick();
    if (!wanted.has(f)) continue;
    wanted.delete(f);
    const pixels = enlarge(core.render().slice(), scale);
    const file = join(OUT_DIR, `frame-${String(f).padStart(4, "0")}.png`);
    await Bun.write(file, encodePNG(pixels, SCREEN_W * scale, SCREEN_H * scale));
    console.log(`sortie: ${file.slice(ROOT.length + 1)}`);
  }
  process.exit(0);
}

const width = SCREEN_W * scale;
const height = SCREEN_H * scale;
const mp4 = join(OUT_DIR, "pocketjs-sortie.mp4");
const audio = !silent && existsSync(SCORE) ? ["-i", SCORE] : [];
const encode = audio.length
  ? ["-c:a", "aac", "-b:a", "192k", "-shortest"]
  : ["-an"];

const ff = Bun.spawn(
  [
    "ffmpeg", "-y", "-v", "error",
    // One whole frame per packet: the pipe's default block size is smaller
    // than a 1920x1088 RGBA frame and ffmpeg logs a truncation for every read.
    "-blocksize", String(width * height * 4),
    "-f", "rawvideo", "-pix_fmt", "rgba", "-s", `${width}x${height}`, "-framerate", String(HZ), "-i", "-",
    ...audio,
    "-c:v", "libx264", "-preset", "slow", "-crf", "16", "-pix_fmt", "yuv420p",
    "-movflags", "+faststart",
    ...encode,
    mp4,
  ],
  { stdin: "pipe", stdout: "inherit", stderr: "inherit" },
);

let poster: Uint8Array | null = null;
for (let f = 0; f < FRAMES; f++) {
  core.frame(0);
  core.tick();
  const pixels = enlarge(core.render().slice(), scale);
  if (f === 1215) poster = pixels.slice(); // 錆の核心 — the poster frame
  ff.stdin.write(pixels);
  await ff.stdin.flush();
  if (f % 600 === 0) console.log(`sortie: frame ${f}/${FRAMES}`);
}
await ff.stdin.end();
if ((await ff.exited) !== 0) throw new Error("sortie: ffmpeg failed");
if (poster) await Bun.write(join(OUT_DIR, "poster.png"), encodePNG(poster, width, height));

console.log(
  `sortie: ${mp4.slice(ROOT.length + 1)} — ${width}x${height}, ${FRAMES} frames @ ${HZ} fps, ` +
    `${RUNTIME_SECONDS.toFixed(3)} s, ${(Bun.file(mp4).size / 1024 / 1024).toFixed(1)} MiB`,
);
