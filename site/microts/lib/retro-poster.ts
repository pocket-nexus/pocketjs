// Runs one generated Pocket Retro game headless in Bun, on the same JavaScript
// path the playground worker uses, and writes its last frame to
// .cache/retro/public/<id>/poster.png. Prints one JSON line with the screen
// size, fps and frame count. lib/retro.ts runs it once per game.
//
//   bun site/microts/lib/retro-poster.ts <pocket-retro checkout> <id> "<script>"
//
// The script uses the pocket-retro tests/games.test.ts notation: space-separated
// "<vblanks>:<keys>" steps, keys joined with "+" or "-" for none.
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { RETRO_OUT } from "./paths.ts";

const [repo, id, script = "120:-"] = process.argv.slice(2);
if (!repo || !id) throw new Error("usage: retro-poster.ts <pocket-retro checkout> <id> [script]");

const BITS: Record<string, number> = { A: 1, B: 2, SELECT: 4, START: 8, RIGHT: 16, LEFT: 32, UP: 64, DOWN: 128, R: 256, L: 512 };
const sdk = (f: string) => import(join(RETRO_OUT, "sdk", f));

const { loadAssets } = await sdk("assets.ts");
const host = await sdk("host.ts");
const hw = await sdk("hw.ts");
const pub = join(RETRO_OUT, "public", id);
const baked = JSON.parse(readFileSync(join(pub, "assets.json"), "utf8"));
const bin = (f: string | null) => (f ? new Uint8Array(readFileSync(join(pub, f))) : []);
loadAssets({ ...baked, images: bin(baked.images), tilemaps: bin(baked.tilemaps) });
const game = await import(join(RETRO_OUT, "games", id, "game.ts"));
host.boot();
game.setup();

let frames = 0;
let vblank = 0;
for (const step of script.split(" ")) {
  const [n, keys] = step.split(":");
  const mask = keys === "-" ? 0 : keys!.split("+").reduce((m, k) => m | BITS[k]!, 0);
  for (let i = 0; i < Number(n); i++, vblank++) {
    if (vblank % Math.max(1, Math.round(60 / hw.fps))) continue;
    host.beginFrame(mask, 4);
    game.update();
    game.draw();
    host.endFrame();
    hw.voices.length = 0;
    frames++;
  }
}

const { width, height, screen, colors } = hw;
const rgba = new Uint8Array(width * height * 4);
const used = new Set<number>();
for (let i = 0; i < width * height; i++) {
  const c = colors[screen[i]] ?? 0;
  used.add(screen[i]);
  rgba[i * 4] = (c >> 16) & 255;
  rgba[i * 4 + 1] = (c >> 8) & 255;
  rgba[i * 4 + 2] = c & 255;
  rgba[i * 4 + 3] = 255;
}
if (used.size < 2) throw new Error(`${id}: the last frame is a single color`);
const { encodePng } = await import(join(repo, "tools/lib/png.ts"));
const scale = Math.max(1, Math.floor(320 / Math.max(width, height)));
writeFileSync(join(pub, "poster.png"), encodePng(rgba, width, height, scale));
console.log(JSON.stringify({ id, width, height, fps: hw.fps, frames, colorsUsed: used.size }));
