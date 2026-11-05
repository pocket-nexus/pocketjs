// site/bake-demo-wall.ts — bakes the landing hero's "demo wall": every demo
// tiled into one looping background video.
//
//   bun site/bake-demo-wall.ts
//
// Every stream is ENGINE OUTPUT — no camera, no hands, no hardware (those
// captures are social-media material, not landing-page material): headless
// sim recordings of the in-repo demos (site/record-sim-clips.ts, recorded on
// demand into gitignored site/.cache/demo-wall/sim/), the engine-rendered
// GIF loops from site/assets/blog/, the Pocket Character desktop-widget
// screen capture from R2, and committed frames from the three satellite apps
// that ship in their own repos (see `shots()` below). The two outputs ARE
// committed, like the old hero mp4 was:
//
//   site/assets/pocketjs-demo-wall.mp4   4x4 wall of 480x272 tiles, 24 s loop
//   site/assets/pocketjs-demo-wall.jpg   poster frame for first paint
//
// Every tile is normalized to the same clock (24 fps, exactly 24 s, cover-
// cropped to PSP-shaped 480x272) so the xstack grid never drifts.

import { $ } from "bun";
import { existsSync, mkdirSync } from "node:fs";
import { ensureMotionCredits } from "./motion-credit.ts";
import { ensureSimClip } from "./record-sim-clips.ts";

const SITE = new URL(".", import.meta.url).pathname;
const ROOT = SITE + "../";
const CACHE = SITE + ".cache/demo-wall/";
const BLOG = SITE + "assets/blog/";
const WALL = SITE + "assets/wall/"; // stills the wall uses that no page embeds

const OUT_MP4 = SITE + "assets/pocketjs-demo-wall.mp4";
const OUT_JPG = SITE + "assets/pocketjs-demo-wall.jpg";

const TILE_W = 480; // one PSP screen per tile
const TILE_H = 272;
const COLS = 4;
const ROWS = 4;
const DUR = 24; // seconds — every tile hard-cuts together at the loop point
const FPS = 24;
const CRF = 32; // background texture, not a feature video — bias small

// The Pocket Character desktop-widget capture the blog embeds from R2 (a
// clean screen recording — the only non-repo stream on the wall).
const R2 = "https://pub-ddde9ba138d04a9a9f922aa1fda6f855.r2.dev/pocketjs/";
async function r2(name: string): Promise<string> {
  const path = CACHE + name;
  if (!existsSync(path)) {
    console.log(`  fetch ${name}`);
    const res = await fetch(R2 + name);
    if (!res.ok) throw new Error(`R2 ${name}: HTTP ${res.status}`);
    await Bun.write(path, res);
  }
  return path;
}

// A clip is one video stream, replayed from its start until the wall's cut
// point (sim clips are exactly one wall period long; GIFs loop).
type Clip = { src: string };
const loop = (src: string): Clip => ({ src });
const sim = (app: string): Clip => ({ src: ensureSimClip(app) });

// Three tiles are satellite apps with their own repos (pocket-nexus's
// open-strike, pocket-voxel and pocket-figma), so this script cannot boot
// them the way it boots the in-repo demos. Their tiles are frames those
// runtimes rendered themselves, each held for an equal share of the loop and
// hard-cut into the next — still engine output, sampled instead of recorded.
// Any one of them becomes a sim() clip the day its repo records a headless run.
async function shots(name: string, frames: string[]): Promise<Clip> {
  const out = CACHE + `shots-${name}.mp4`;
  if (!existsSync(out)) {
    const hold = DUR / frames.length;
    const inputs = frames.flatMap((f) => ["-loop", "1", "-t", String(hold), "-i", f]);
    const scaled = frames
      .map(
        (_, i) =>
          `[${i}:v]scale=${TILE_W}:${TILE_H}:force_original_aspect_ratio=increase,` +
          `crop=${TILE_W}:${TILE_H},setsar=1[s${i}]`,
      )
      .join(";");
    const filter = `${scaled};${frames.map((_, i) => `[s${i}]`).join("")}concat=n=${frames.length}:v=1:a=0[v]`;
    await $`ffmpeg -y -v error ${inputs} -filter_complex ${filter} -map [v] -r ${FPS} -c:v libx264 -preset medium -crf 14 -pix_fmt yuv420p ${out}`;
  }
  return { src: out };
}

async function main() {
  mkdirSync(CACHE, { recursive: true });
  const creditResult = ensureMotionCredits();
  if (creditResult.stamped.length > 0) {
    console.log(`  stamped ${creditResult.stamped.length} missing Motion Lab credit(s)`);
  }
  // The widget capture fades into the brand end card at ~10 s; cut before the
  // fade so the looping tile only ever shows the character.
  const characterFull = await r2("pocket-character-widget-c6cf80c4.mp4");
  const character = CACHE + "pocket-character-widget-loop.mp4";
  if (!existsSync(character)) {
    await $`ffmpeg -y -v error -t 9.8 -i ${characterFull} -c:v libx264 -preset medium -crf 14 -an ${character}`;
  }

  // The three satellite tiles: a shooter, a creature-RPG and a design-document
  // viewer, each cutting through three of its own frames across the loop.
  const openStrike = await shots("open-strike", [
    WALL + "openstrike-psp-menu.png", // map select, "O DEPLOY"
    BLOG + "openstrike-psp-dust2.png", // the sunlit dust2 courtyard
    BLOG + "openstrike-psp-fire.png", // muzzle flash, ammo down to 28
  ]);
  const voxel = await shots("pocket-voxel", [
    BLOG + "voxel-psp-bedroom.png", // the bedroom the run starts in
    BLOG + "voxel-psp-pallet-town.png", // the town as a voxel diorama
    BLOG + "voxel-psp-route-1.png", // extruded encounter grass
  ]);
  const figma = await shots("pocket-figma", [
    BLOG + "figma-psp-fit.png", // the Welcome page fit to screen at 8%
    BLOG + "figma-psp-components-fit.png", // 26,000 pixels of canvas at 3%
    BLOG + "figma-sim-calendar.png", // a calendar component at 100%
  ]);

  // Row-major 4x4 grid: eight headless sim recordings of the in-repo demos,
  // four engine-rendered GIF loops, the Pocket Character widget and the three
  // satellite sequences. The two remaining motion-study tiles sit far apart,
  // as do the satellites, so the wall reads as many programs at once.
  const tiles: Clip[] = [
    // row 1
    sim("music-main"), // EVERGREEN grid -> Now Playing, track skips
    sim("zoomlab-main"), // streamed DeepZoom poster -> zoomed concentric rings
    sim("im-main"), // Pocket Talk: thread scroll -> OSK typing -> sent
    loop(ROOT + "assets/screenshots/motions-53.gif"),
    // row 2
    loop(character), // Pocket Character breathing on the desktop
    sim("gallery-main"), // photo pages under the shoulder buttons
    loop(BLOG + "devtools-highlight-glide.gif"),
    openStrike, // OpenStrike on PSP: deploy, dust2, fire
    // row 3
    sim("stats-main"), // Mission Control dashboard tabs
    loop(BLOG + "page-3d.gif"),
    figma, // Pocket Figma: page fit, cover at 59%, component at 100%
    loop(BLOG + "pocket-youtube-journey.gif"),
    // row 4
    sim("library-main"), // Game Library covers and detail pages
    voxel, // Pocket Voxel on PSP: bedroom, town, route
    sim("hero-main"), // "JSX at 60 FPS." counter card
    sim("cafe-main"), // deterministic menu -> order -> confirmation
  ];

  const inputs: string[] = [];
  const filters: string[] = [];
  let idx = 0;
  const addInput = (c: Clip): number => {
    // -t caps the read with margin; tpad+trim below make every stream exactly
    // DUR long so the two xstack layers can never end early or drift.
    inputs.push("-stream_loop", "-1", "-t", String(DUR + 2), "-i", c.src);
    return idx++;
  };
  const norm = (w: number, h: number) =>
    `fps=${FPS},scale=${w}:${h}:force_original_aspect_ratio=increase,crop=${w}:${h},setsar=1,` +
    `tpad=stop_mode=clone:stop_duration=2,trim=duration=${DUR},setpts=PTS-STARTPTS`;

  tiles.forEach((tile, t) => {
    filters.push(`[${addInput(tile)}:v]${norm(TILE_W, TILE_H)}[t${t}]`);
  });
  const layout = tiles.map((_, i) => `${(i % COLS) * TILE_W}_${Math.floor(i / COLS) * TILE_H}`).join("|");
  filters.push(
    `[${tiles.map((_, i) => `t${i}`).join("][")}]xstack=inputs=${COLS * ROWS}:layout=${layout},format=yuv420p[wall]`,
  );

  console.log(`demo wall: ${tiles.length} tiles, ${idx} streams -> ${COLS * TILE_W}x${ROWS * TILE_H} @ ${DUR}s`);
  await $`ffmpeg -y -v error ${inputs} -filter_complex ${filters.join(";")} -map [wall] -r ${FPS} -c:v libx264 -preset slow -crf ${CRF} -movflags +faststart -an ${OUT_MP4}`;
  await $`ffmpeg -y -v error -ss 12 -i ${OUT_MP4} -frames:v 1 -vf scale=1280:-2 -q:v 5 ${OUT_JPG}`;

  for (const out of [OUT_MP4, OUT_JPG]) {
    console.log(`  ${out.slice(SITE.length)}  (${(Bun.file(out).size / 1024 / 1024).toFixed(1)} MiB)`);
  }
}

await main();
