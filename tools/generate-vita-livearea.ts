// Regenerate PocketJS's committed default PS Vita LiveArea artwork from the
// canonical mark. Builds consume the committed PNG/XML files and do not
// require ImageMagick; only intentional artwork updates run this script.

import { createCanvas, loadImage } from "@napi-rs/canvas";
import {
  cpSync,
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const source = join(root, "site/assets/favicon.svg");
const output = join(root, "programs/vita/assets/sce_sys");
const magick = Bun.which("magick");
const args = Bun.argv.slice(2);
const check = args.includes("--check");

for (const argument of args) {
  if (argument !== "--check") throw new Error(`generate-vita-livearea: unknown option ${argument}`);
}

if (!magick) {
  throw new Error("generate-vita-livearea: ImageMagick `magick` is required");
}

const temporary = mkdtempSync(join(tmpdir(), "pocketjs-vita-livearea-"));
const mark = join(temporary, "mark.png");
const generated = join(temporary, "sce_sys");
const assetPaths = [
  "icon0.png",
  "livearea/contents/bg.png",
  "livearea/contents/startup.png",
  "livearea/contents/template.xml",
] as const;

function run(args: string[]): void {
  const result = Bun.spawnSync([magick!, ...args], {
    stdout: "inherit",
    stderr: "pipe",
  });
  if (result.exitCode !== 0) {
    throw new Error(
      `generate-vita-livearea: ImageMagick failed: ${result.stderr.toString().trim()}`,
    );
  }
}

function render(path: string, width: number, height: number, markSize: string): void {
  const destination = join(generated, path);
  mkdirSync(dirname(destination), { recursive: true });
  run([
    "-size",
    `${width}x${height}`,
    "xc:#171226",
    "(",
    mark,
    "-filter",
    "Lanczos",
    "-resize",
    markSize,
    ")",
    "-gravity",
    "center",
    "-composite",
    "-alpha",
    "off",
    "-colors",
    "256",
    "-strip",
    "-define",
    "png:exclude-chunk=date,time",
    "-interlace",
    "none",
    `PNG8:${destination}`,
  ]);
}

try {
  // favicon.svg draws the mark inside its own backing tile. The LiveArea
  // supplies that ground itself, so the tile is dropped and the mark is
  // rasterized on transparency — no floodfill, and no seam where an
  // anti-aliased tile edge would have met the ground.
  //
  // ImageMagick composites and quantises below, but it does NOT rasterize the
  // SVG: its rsvg delegate silently drops `fill="none"` strokes (and
  // objectBoundingBox gradients), which loses the shell outright. resvg, via
  // @napi-rs/canvas, is the same renderer the iOS icon bakers use.
  const bare = readFileSync(source, "utf8").replace(
    /\s*<rect width="32" height="32"[^>]*\/>/,
    "",
  );
  const MARK_PX = 1024;
  const sized = bare.replace("<svg", `<svg width="${MARK_PX}" height="${MARK_PX}"`);
  const rendered = await loadImage(Buffer.from(sized));
  const surface = createCanvas(MARK_PX, MARK_PX);
  surface.getContext("2d").drawImage(rendered, 0, 0, MARK_PX, MARK_PX);
  writeFileSync(mark, surface.toBuffer("image/png"));
  run([mark, "-trim", "+repage", mark]);

  render("icon0.png", 128, 128, "112x74");
  render("livearea/contents/startup.png", 280, 158, "196x118");
  render("livearea/contents/bg.png", 840, 500, "520x320");

  mkdirSync(join(generated, "livearea/contents"), { recursive: true });
  writeFileSync(
    join(generated, "livearea/contents/template.xml"),
    `<?xml version="1.0" encoding="utf-8"?>\n` +
      `<livearea style="a1" format-ver="01.00" content-rev="1">\n` +
      `  <livearea-background>\n` +
      `    <image>bg.png</image>\n` +
      `  </livearea-background>\n` +
      `  <gate>\n` +
      `    <startup-image>startup.png</startup-image>\n` +
      `  </gate>\n` +
      `</livearea>\n`,
  );

  if (check) {
    for (const path of assetPaths) {
      const committed = join(output, path);
      const next = join(generated, path);
      if (!existsSync(committed) || !readFileSync(committed).equals(readFileSync(next))) {
        throw new Error(`generate-vita-livearea: ${path} is stale; run bun run vita:art`);
      }
    }
    console.log("generate-vita-livearea: committed assets are reproducible");
  } else {
    for (const path of assetPaths) {
      const destination = join(output, path);
      mkdirSync(dirname(destination), { recursive: true });
      cpSync(join(generated, path), destination);
    }
    console.log(`generate-vita-livearea: wrote ${output}`);
  }
} finally {
  rmSync(temporary, { recursive: true, force: true });
}
