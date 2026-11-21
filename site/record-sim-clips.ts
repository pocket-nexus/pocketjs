// site/record-sim-clips.ts — records clean "emulator" clips of the in-repo
// demos for the hero demo wall: no camera, no hands, no hardware. The wasm
// core renders every frame headlessly (the same deterministic boot as
// tools/tape.ts / tests/golden.ts), driven by a scripted button tape, and
// the raw RGBA frames are piped straight into ffmpeg.
//
//   bun site/record-sim-clips.ts             # record every wall clip
//   bun site/record-sim-clips.ts hero-main   # record one app
//
// Output: site/.cache/demo-wall/sim/<app>.mp4 — 480x272, 24 s @ 30 fps
// (every 2nd sim frame of the fixed-60 Hz clock), near-lossless so the wall
// bake (site/bake-demo-wall.ts) is the only lossy generation.
//
// Each app runs in a SUBPROCESS: eval'ing one bundle per process keeps the
// runtimes from ever sharing globals.

import { existsSync, mkdirSync, rmSync } from "node:fs";
import { createWasmUi } from "../platforms/web/wasm-ops.js";
import { BTN, SCREEN_H, SCREEN_W } from "../contracts/spec/spec.ts";

const ROOT = new URL("..", import.meta.url).pathname;
const SITE = ROOT + "site/";
const SIM_DIR = SITE + ".cache/demo-wall/sim/";
const BUILD_DIST = SITE + ".cache/demo-wall/sim-build/";
const WASM_PATH = ROOT + "platforms/web/pocketjs.wasm";

const DUR_S = 24; // must match bake-demo-wall.ts DUR
const SIM_HZ = 60;
const OUT_FPS = 30; // every 2nd sim frame
const FRAMES = DUR_S * SIM_HZ;

// 24-second interaction scripts, one per app — golden-specs.ts pulses
// stretched to a full loop. A returned mask applies to THAT frame only, so
// holds are expressed as ranges (exactly like tests/golden-specs.ts).
type Script = (f: number) => number;
export const WALL_APPS: Record<string, Script> = {
  // "JSX at 60 FPS" card: focus the button, then keep the counter ticking.
  "hero-main": (f) =>
    f === 8 ? BTN.DOWN : f >= 60 && f <= 1380 && (f - 60) % 90 === 0 ? BTN.CIRCLE : 0,
  // EVERGREEN grid -> play a track -> browse -> next track via the trigger.
  "music-main": (f) =>
    f === 60 ? BTN.DOWN
    : f === 120 ? BTN.CIRCLE
    : f === 420 || f === 480 ? BTN.DOWN
    : f === 540 ? BTN.CIRCLE
    : f === 840 ? BTN.RTRIGGER
    : f === 1080 ? BTN.DOWN
    : f === 1200 ? BTN.RTRIGGER
    : 0,
  // Photo gallery: pick a tile, then page with the shoulders.
  "gallery-main": (f) =>
    f === 100 ? BTN.RIGHT
    : f === 160 ? BTN.CIRCLE
    : f === 320 || f === 560 || f === 800 ? BTN.RTRIGGER
    : f === 1040 ? BTN.LTRIGGER
    : f === 1280 ? BTN.RTRIGGER
    : 0,
  // DeepZoom poster: zoom to 100%, pan onto the rings, settle, then fit and
  // repeat. Frame 720 (the baked poster) holds the full-color ring view.
  "zoomlab-main": (f) =>
    (f >= 60 && f < 180) || (f >= 840 && f < 960) ? BTN.RTRIGGER
    : (f >= 180 && f < 360) || (f >= 960 && f < 1140) ? BTN.LEFT
    : f === 780 || f === 1380 ? BTN.CROSS
    : 0,
  // Mission Control: tab across the dashboard panels.
  "stats-main": (f) => (f > 0 && f % 300 === 0 ? BTN.RIGHT : 0),
  // Game Library: browse covers, open a game, back out, open another.
  "library-main": (f) =>
    f === 60 || f === 120 ? BTN.RIGHT
    : f === 240 ? BTN.CIRCLE
    : f === 640 ? BTN.TRIANGLE
    : f === 720 ? BTN.RIGHT
    : f === 840 ? BTN.CIRCLE
    : f === 1240 ? BTN.TRIANGLE
    : 0,
  // Pocket Talk: open a thread, scroll history, then type on the OSK and
  // send — the delivery receipt lands before the loop cut.
  "im-main": (f) =>
    f === 200 ? BTN.CIRCLE
    : f >= 300 && f < 480 ? BTN.UP
    : f === 560 ? BTN.SELECT
    : f === 660 ? BTN.TRIANGLE
    : f === 720 ? BTN.DOWN
    : f === 760 ? BTN.CIRCLE
    : f === 820 ? BTN.RIGHT
    : f === 860 ? BTN.CIRCLE
    : f === 920 ? BTN.RIGHT
    : f === 960 ? BTN.CIRCLE
    : f === 1160 ? BTN.START
    : 0,
  // Deterministic café: build two carts and place two orders. Frame 720 lands
  // on the first green confirmation receipt; the final menu holds into the cut.
  "cafe-main": (f) =>
    f === 60 ? BTN.CIRCLE
    : f === 90 ? BTN.DOWN
    : f === 120 || f === 180 ? BTN.CIRCLE
    : f === 630 ? BTN.START
    : f === 840 ? BTN.CIRCLE
    : f === 900 || f === 1020 ? BTN.DOWN
    : f === 960 || f === 1080 ? BTN.CIRCLE
    : f === 1200 ? BTN.START
    : 0,
};

function buildApp(app: string): string {
  const dist = BUILD_DIST + app + "/";
  rmSync(dist, { recursive: true, force: true });
  mkdirSync(dist, { recursive: true });
  const p = Bun.spawnSync(["bun", "tools/build.ts", app, `--outdir=${dist}`], {
    cwd: ROOT,
    stdout: "inherit",
    stderr: "inherit",
  });
  if (p.exitCode !== 0 || !existsSync(dist + app + ".js")) {
    throw new Error(`record-sim: build failed for ${app}`);
  }
  return dist;
}

/** Same boot dance as tools/tape.ts — fresh core, bundle installs frame(). */
async function boot(app: string, dist: string) {
  if (!existsSync(WASM_PATH)) {
    const p = Bun.spawnSync(["bun", "tools/wasm.ts"], { cwd: ROOT, stdout: "inherit", stderr: "inherit" });
    if (p.exitCode !== 0) throw new Error("record-sim: wasm build failed");
  }
  const wasm = await createWasmUi(await Bun.file(WASM_PATH).arrayBuffer());
  const g = globalThis as Record<string, unknown>;
  g.ui = wasm.ops;
  g.__pak = existsSync(dist + app + ".pak") ? await Bun.file(dist + app + ".pak").arrayBuffer() : undefined;
  g.frame = undefined;
  g.__pocketApp = app;
  (0, eval)(await Bun.file(dist + app + ".js").text());
  const frame = g.frame as ((buttons: number) => void) | undefined;
  if (typeof frame !== "function") throw new Error(`record-sim: ${app} did not install globalThis.frame`);
  return { frame, tick: wasm.tick, render: () => wasm.render() };
}

async function recordOne(app: string): Promise<void> {
  const script = WALL_APPS[app];
  if (!script) throw new Error(`record-sim: no wall script for ${app} (known: ${Object.keys(WALL_APPS).join(", ")})`);
  const out = SIM_DIR + app + ".mp4";
  mkdirSync(SIM_DIR, { recursive: true });
  const dist = buildApp(app);
  const b = await boot(app, dist);

  const ff = Bun.spawn(
    ["ffmpeg", "-y", "-v", "error",
      "-f", "rawvideo", "-pix_fmt", "rgba", "-s", `${SCREEN_W}x${SCREEN_H}`, "-framerate", String(OUT_FPS), "-i", "-",
      "-c:v", "libx264", "-preset", "medium", "-crf", "14", "-pix_fmt", "yuv420p", out],
    { stdin: "pipe", stdout: "inherit", stderr: "inherit" },
  );
  for (let f = 0; f < FRAMES; f++) {
    b.frame(script(f));
    b.tick();
    if (f % (SIM_HZ / OUT_FPS) === 0) {
      const rgba = b.render().slice();
      const expectedBytes = SCREEN_W * SCREEN_H * 4;
      if (rgba.byteLength !== expectedBytes) {
        throw new Error(
          `record-sim: ${app} frame ${f} has ${rgba.byteLength} RGBA bytes; expected ${expectedBytes}`,
        );
      }
      ff.stdin.write(rgba);
      await ff.stdin.flush();
    }
  }
  await ff.stdin.end();
  if ((await ff.exited) !== 0) throw new Error(`record-sim: ffmpeg failed for ${app}`);
  console.log(`record-sim: ${out.slice(SITE.length)} (${(Bun.file(out).size / 1024).toFixed(0)} KiB)`);
}

/** Used by bake-demo-wall.ts: subprocess-per-app so eval'd bundles never share globals. */
export function ensureSimClip(app: string): string {
  const out = SIM_DIR + app + ".mp4";
  if (existsSync(out)) return out;
  const p = Bun.spawnSync(["bun", import.meta.path, app], { cwd: ROOT, stdout: "inherit", stderr: "inherit" });
  if (p.exitCode !== 0 || !existsSync(out)) throw new Error(`record-sim: recording ${app} failed`);
  return out;
}

if (import.meta.main) {
  const apps = process.argv[2] ? [process.argv[2]] : Object.keys(WALL_APPS);
  if (apps.length === 1) {
    await recordOne(apps[0]);
  } else {
    for (const app of apps) ensureSimClip(app);
  }
}
