// bun tools/playset-sim.ts <app> [--frames 3600] [--every 600] [--play] [--json]
//
// A playset game without a console: the pocket-playset kernels as a desktop
// dylib (platforms/sim/playset.ts) under the game's own TypeScript, driven
// by its demo autopilot (or, with --play, by a neutral pad in a real run).
// Prints the status line and the native counters at intervals and fails on
// an exception, a run that ends in under ten seconds, or a frame record over
// the 3DS budgets (draws, triangles, bones) below.

import { resolve } from "node:path";
import { installPlaysetSim } from "../platforms/sim/playset.ts";
import type { Pad, PlaysetGame } from "../apps/playset/kit/game.ts";

/** What one 60 Hz frame of the PICA renderer is given, at most. */
export const PLAYSET_BUDGET = { draws: 140, tris: 16_000, bones: 1_200 } as const;

const args = process.argv.slice(2);
const app = args.find((a, i) => !a.startsWith("--") && !args[i - 1]?.match(/^--(frames|every)$/));
const value = (name: string, fallback: number) => {
  const i = args.indexOf(name);
  return i >= 0 ? Number(args[i + 1]) : fallback;
};
if (!app) {
  console.error("usage: bun tools/playset-sim.ts <app under apps/> [--frames 3600] [--every 600] [--play]");
  process.exit(2);
}
const frames = value("--frames", 3600);
const every = value("--every", 600);
const sim = installPlaysetSim();
const module = await import(resolve(import.meta.dir, "../apps", app, "game.ts"));
const t0 = performance.now();
const game: PlaysetGame = module.createGame();
const loadMs = performance.now() - t0;
game.start(!args.includes("--play"));
const pad: Pad = { x: 0, y: 0, rx: 0, ry: 0, held: 0, pressed: 0 };
const peak = { draws: 0, tris: 0, bones: 0 };
let worst = 0;
let endedAt = -1;
const failures: string[] = [];
console.log(`${app}: loaded in ${loadMs.toFixed(1)} ms (desktop)`);
for (let f = 0; f < frames; f++) {
  const a = performance.now();
  try {
    game.frame(pad);
  } catch (error) {
    console.error(`frame ${f}: ${(error as Error).stack ?? error}`);
    process.exit(1);
  }
  const r = sim.prepare();
  worst = Math.max(worst, performance.now() - a);
  peak.draws = Math.max(peak.draws, r.draws);
  peak.tris = Math.max(peak.tris, r.tris);
  peak.bones = Math.max(peak.bones, r.bones);
  if (game.status() === "gameover" && endedAt < 0) endedAt = f;
  if (f % every === 0 || f === frames - 1) {
    const st = game.play.stats;
    console.log(
      `f${String(f).padStart(5)} ${game.status().padEnd(8)} ${game.topLine()} | draws ${r.draws} tris ${r.tris} bones ${r.bones} live ${st[2]} fx ${st[5]}`,
    );
  }
}
if (endedAt >= 0 && endedAt < 600) failures.push(`the run ended at frame ${endedAt}`);
for (const k of ["draws", "tris", "bones"] as const) {
  if (peak[k] > PLAYSET_BUDGET[k]) failures.push(`${k} peaked at ${peak[k]} (budget ${PLAYSET_BUDGET[k]})`);
}
console.log(`peak draws ${peak.draws} tris ${peak.tris} bones ${peak.bones}; ${sim.soundsPlayed} sound requests; worst desktop frame ${worst.toFixed(2)} ms`);
if (args.includes("--json")) console.log(JSON.stringify({ app, loadMs, peak, worst, endedAt }));
sim.destroy();
if (failures.length) {
  console.error(`FAIL ${failures.join("; ")}`);
  process.exit(1);
}
