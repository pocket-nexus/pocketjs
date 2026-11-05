// Pocket Retro content for the playground, generated from a pinned
// pocket-retro commit into .cache/retro/ (gitignored):
//
//   sdk/**                     the SDK; sdk/assets.ts becomes a runtime loader
//   games/<id>/game.ts         game sources
//   public/<id>/               assets.json, images.bin, tilemaps.bin, poster.png
//   public/LICENSE.txt, THIRD_PARTY_NOTICES.md
//   catalog.json               the game list, with the screen size and fps each game sets
//
// The pinned checkout lives in .cache/pocket-retro. POCKET_RETRO_DIR=<checkout>
// uses a local checkout (at its HEAD) instead, and always regenerates.
import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { CACHE, RETRO_OUT } from "./paths.ts";

export const RETRO_REPO = "https://github.com/pocket-nexus/pocket-retro";
export const RETRO_COMMIT = "0d7e94567f0a6e2ef2abf53b7fc3b6b3660b9d19";
// Bump when the generated layout changes, so cached output is rebuilt.
const LAYOUT = 2;

// Playground order. Megaball is left out: its font has no separate license statement.
const GAMES: { id: string; blurb: string; author: string; original?: string; controls: string; script: string }[] = [
  { id: "hello", blurb: "The smallest possible game: shapes, text and a rectangle you move.", author: "Pocket Retro", controls: "←/→ move", script: "120:-" },
  { id: "jump", blurb: "Pyxel's jump game example. Land on floors, eat fruit, avoid falling.", author: "Takashi Kitao", original: "https://kitao.github.io/pyxel/web/showcase/examples/02-jump-game.html", controls: "←/→ move", script: "60:- 60:RIGHT 30:LEFT 90:-" },
  { id: "snake", blurb: "Snake on a 40 × 50 screen.", author: "Marcus Croucher", original: "https://kitao.github.io/pyxel/web/showcase/examples/07-snake.html", controls: "Arrows steer · Enter restarts", script: "30:- 20:UP 20:LEFT 20:DOWN 40:-" },
  { id: "shooter", blurb: "Pyxel's shoot'em up example.", author: "Takashi Kitao", original: "https://kitao.github.io/pyxel/web/showcase/examples/09-shooter.html", controls: "Arrows move · Z fires · Enter starts", script: "60:- 5:START 60:- 20:A 5:- 20:A 60:LEFT 60:RIGHT+A" },
  { id: "platformer", blurb: "Pyxel's platformer example with a scrolling tilemap.", author: "Takashi Kitao", original: "https://kitao.github.io/pyxel/web/showcase/examples/10-platformer.html", controls: "←/→ move · Z jumps", script: "26:- 108:RIGHT 2:RIGHT+A 18:RIGHT 2:RIGHT+A 60:RIGHT" },
  { id: "space_rescue", blurb: "A one-key game: rescue astronauts, dodge meteors.", author: "Takashi Kitao", original: "https://kitao.github.io/pyxel/web/showcase/apps/space-rescue.html", controls: "Z thrusts · Enter starts", script: "60:- 4:START 2:- 38:A 100:-" },
  { id: "draw_api", blurb: "Pyxel's drawing API demo: every primitive, palette swaps and clipping.", author: "Takashi Kitao", controls: "Arrows move the pointer · Z clicks", script: "60:- 30:RIGHT 30:DOWN 60:A 60:-" },
  { id: "mega_wing", blurb: "A shoot'em up with lots of bullets.", author: "Takashi Kitao", original: "https://kitao.github.io/pyxel/web/showcase/apps/mega-wing.html", controls: "Arrows move · Z fires · Enter starts", script: "60:- 5:START 60:- 90:A 60:LEFT+A" },
  { id: "cursed_caverns", blurb: "A platformer: avoid traps and collect gems.", author: "Takashi Kitao", original: "https://kitao.github.io/pyxel/web/showcase/apps/cursed-caverns.html", controls: "←/→ move · Z jumps · Enter starts", script: "200:- 5:START 120:- 30:RIGHT" },
  { id: "daylight", blurb: "30 Seconds of Daylight, the first Pyxel Jam winner. A roguelike.", author: "Adam (helpcomputer)", original: "https://kitao.github.io/pyxel/web/showcase/apps/30sec-of-daylight.html", controls: "Arrows step · Z attacks · Enter starts", script: "60:- 5:START 25:- 6:A+DOWN 6:DOWN 6:A+DOWN 30:-" },
  { id: "laser_jetman", blurb: "An arcade shooter inspired by Defender.", author: "Adam (helpcomputer)", original: "https://kitao.github.io/pyxel/web/showcase/apps/laser-jetman.html", controls: "Arrows fly · Z fires · Enter starts", script: "120:- 5:START 120:- 60:RIGHT+A 60:-" },
];

// The playground's copy of sdk/assets.ts. pocket-retro swaps this module for the
// game's baked assets at build time; here the tables are ES module live
// bindings that loadAssets() fills before the SDK boots.
const ASSETS_MODULE = `import type { i32, u8 } from "@pocketjs/framework/solid/std";

export let IMAGES: readonly u8[] = [];
export let TILEMAPS: readonly u8[] = [];
export let TILEMAP_IMAGES: i32[] = [];
export let COLORS: i32[] = [];
export let SOUNDS: i32[] = [];
export let SOUND_STARTS: i32[] = [];
export let MUSICS: i32[] = [];
export let MUSIC_STARTS: i32[] = [];

export interface BakedAssets {
  images: ArrayLike<u8>;
  tilemaps: ArrayLike<u8>;
  tilemapImages: i32[];
  colors: i32[];
  sounds: i32[];
  soundStarts: i32[];
  musics: i32[];
  musicStarts: i32[];
}

// images and tilemaps arrive as Uint8Array; the SDK only indexes them and reads len().
export function loadAssets(a: BakedAssets): void {
  IMAGES = a.images as readonly u8[];
  TILEMAPS = a.tilemaps as readonly u8[];
  TILEMAP_IMAGES = a.tilemapImages;
  COLORS = a.colors;
  SOUNDS = a.sounds;
  SOUND_STARTS = a.soundStarts;
  MUSICS = a.musics;
  MUSIC_STARTS = a.musicStarts;
}
`;

const git = (dir: string, ...args: string[]) =>
  execFileSync("git", ["-C", dir, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();

function checkout(): string {
  const dir = join(CACHE, "pocket-retro");
  if (!existsSync(join(dir, ".git"))) {
    mkdirSync(dir, { recursive: true });
    git(dir, "init", "-q");
    git(dir, "remote", "add", "origin", `${RETRO_REPO}.git`);
  }
  let head = "";
  try {
    head = git(dir, "rev-parse", "HEAD");
  } catch {}
  if (head !== RETRO_COMMIT) {
    console.log(`pocket-retro: fetching ${RETRO_COMMIT.slice(0, 12)}`);
    git(dir, "fetch", "-q", "--depth=1", "origin", RETRO_COMMIT);
    git(dir, "-c", "advice.detachedHead=false", "checkout", "-q", "--force", RETRO_COMMIT);
  }
  return dir;
}

/** Generates .cache/retro/ unless it already holds this commit's output. */
export async function prepareRetro(): Promise<{ commit: string }> {
  const local = process.env.POCKET_RETRO_DIR;
  const repo = local ? resolve(local) : checkout();
  const commit = git(repo, "rev-parse", "HEAD");
  const stampFile = join(RETRO_OUT, "stamp.json");
  const stamp = JSON.stringify({ commit, layout: LAYOUT });
  if (!local && existsSync(stampFile) && readFileSync(stampFile, "utf8") === stamp) return { commit };

  console.log(`pocket-retro @ ${commit.slice(0, 12)} → ${RETRO_OUT}`);
  rmSync(RETRO_OUT, { recursive: true, force: true });
  const pub = join(RETRO_OUT, "public");
  mkdirSync(pub, { recursive: true });

  cpSync(join(repo, "sdk"), join(RETRO_OUT, "sdk"), { recursive: true });
  writeFileSync(join(RETRO_OUT, "sdk/assets.ts"), ASSETS_MODULE);

  const { readManifest } = await import(join(repo, "tools/lib/manifest.ts"));
  const { bakeAssets } = await import(join(repo, "tools/lib/assets.ts"));
  const tableOf = (module: string, name: string): number[] => {
    const m = module.match(new RegExp(`export const ${name}: [a-z0-9]+\\[\\] = \\[([^\\]]*)\\];`));
    if (!m) throw new Error(`asset table ${name} not found`);
    return m[1]!.trim() ? m[1]!.split(",").map((v) => Number(v.trim())) : [];
  };

  const games = [];
  for (const game of GAMES) {
    const dir = join(repo, "games", game.id);
    const manifest = readManifest(dir);
    const source = readFileSync(join(dir, manifest.entry), "utf8");
    mkdirSync(join(RETRO_OUT, "games", game.id), { recursive: true });
    writeFileSync(join(RETRO_OUT, "games", game.id, "game.ts"), source);

    const tmp = mkdtempSync(join(tmpdir(), `retro-${game.id}-`));
    const module: string = bakeAssets(manifest, dir, tmp);
    const out = join(pub, game.id);
    mkdirSync(out, { recursive: true });
    const files: Record<string, string | null> = { images: null, tilemaps: null };
    for (const kind of ["images", "tilemaps"] as const) {
      if (!module.includes(`embedBytes(${JSON.stringify(join(tmp, `${kind}.bin`))})`)) continue;
      cpSync(join(tmp, `${kind}.bin`), join(out, `${kind}.bin`));
      files[kind] = `${kind}.bin`;
    }
    const assets = {
      images: files.images,
      tilemaps: files.tilemaps,
      tilemapImages: tableOf(module, "TILEMAP_IMAGES"),
      colors: tableOf(module, "COLORS"),
      sounds: tableOf(module, "SOUNDS"),
      soundStarts: tableOf(module, "SOUND_STARTS"),
      musics: tableOf(module, "MUSICS"),
      musicStarts: tableOf(module, "MUSIC_STARTS"),
    };
    writeFileSync(join(out, "assets.json"), JSON.stringify(assets));
    rmSync(tmp, { recursive: true, force: true });

    // One process per game: the SDK keeps module-level state.
    const proc = Bun.spawnSync([process.execPath, join(import.meta.dir, "retro-poster.ts"), repo, game.id, game.script], {
      stdout: "pipe",
      stderr: "pipe",
    });
    if (proc.exitCode !== 0) throw new Error(`pocket-retro ${game.id}: headless run failed\n${proc.stderr.toString()}`);
    const run = JSON.parse(proc.stdout.toString().trim().split("\n").pop()!);
    console.log(`  ${game.id.padEnd(16)} ${run.width}×${run.height} @${run.fps}fps  ${run.frames} frames  ${run.colorsUsed} colors`);

    games.push({
      id: game.id,
      title: manifest.title as string,
      blurb: game.blurb,
      author: game.author,
      original: game.original ?? null,
      controls: game.controls,
      lines: source.split("\n").length,
      width: run.width as number,
      height: run.height as number,
      fps: run.fps as number,
    });
  }

  // The game sources and assets ship with the site; the license texts ship next to them.
  cpSync(join(repo, "LICENSE"), join(pub, "LICENSE.txt"));
  cpSync(join(repo, "THIRD_PARTY_NOTICES.md"), join(pub, "THIRD_PARTY_NOTICES.md"));
  writeFileSync(
    join(RETRO_OUT, "catalog.json"),
    JSON.stringify({ repo: "pocket-nexus/pocket-retro", commit, games }, null, 2) + "\n",
  );
  writeFileSync(stampFile, stamp);
  console.log(`pocket-retro: ${games.length} games`);
  return { commit };
}
