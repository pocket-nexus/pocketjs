// apps/manga/gen-sample.ts — deterministic synthetic manga for testing the
// baker and the reader without shipping copyrighted pages.
//
//   bun apps/manga/gen-sample.ts [--out dist/manga-sample/library] [--pages 6]
//
// Writes one directory per series of PNG pages with panels, speed lines,
// speech bubbles and a page number. Then:
//   bun apps/manga/bake.ts --library dist/manga-sample/library --out dist/manga-sample/packs

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { encodePng } from "./png.ts";

const WIDTH = 800;
const HEIGHT = 1200;

interface Args {
  out: string;
  pages: number;
}

function parseArgs(argv: string[]): Args {
  let out = "dist/manga-sample/library";
  let pages = 6;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === "--out") out = argv[++i]!;
    else if (a === "--pages") pages = Number(argv[++i]);
    else throw new Error(`unknown argument ${a}`);
  }
  if (!Number.isInteger(pages) || pages < 1) throw new Error("--pages must be a positive integer");
  return { out, pages };
}

/** 3x5 digit bitmaps, rows top to bottom, low bit = left column. */
const DIGITS: Record<string, number[]> = {
  "0": [0b111, 0b101, 0b101, 0b101, 0b111],
  "1": [0b010, 0b110, 0b010, 0b010, 0b111],
  "2": [0b111, 0b001, 0b111, 0b100, 0b111],
  "3": [0b111, 0b001, 0b111, 0b001, 0b111],
  "4": [0b101, 0b101, 0b111, 0b001, 0b001],
  "5": [0b111, 0b100, 0b111, 0b001, 0b111],
  "6": [0b111, 0b100, 0b111, 0b101, 0b111],
  "7": [0b111, 0b001, 0b010, 0b010, 0b010],
  "8": [0b111, 0b101, 0b111, 0b101, 0b111],
  "9": [0b111, 0b101, 0b111, 0b001, 0b111],
};

class Canvas {
  readonly pixels: Uint8Array;
  constructor(readonly width: number, readonly height: number, r = 255, g = 255, b = 255) {
    this.pixels = new Uint8Array(width * height * 3);
    this.fillRect(0, 0, width, height, r, g, b);
  }
  set(x: number, y: number, r: number, g: number, b: number) {
    if (x < 0 || y < 0 || x >= this.width || y >= this.height) return;
    const at = (y * this.width + x) * 3;
    this.pixels[at] = r;
    this.pixels[at + 1] = g;
    this.pixels[at + 2] = b;
  }
  fillRect(x: number, y: number, w: number, h: number, r: number, g: number, b: number) {
    for (let iy = y; iy < y + h; iy++) for (let ix = x; ix < x + w; ix++) this.set(ix, iy, r, g, b);
  }
  strokeRect(x: number, y: number, w: number, h: number, t: number, r: number, g: number, b: number) {
    this.fillRect(x, y, w, t, r, g, b);
    this.fillRect(x, y + h - t, w, t, r, g, b);
    this.fillRect(x, y, t, h, r, g, b);
    this.fillRect(x + w - t, y, t, h, r, g, b);
  }
  line(x0: number, y0: number, x1: number, y1: number, t: number, r: number, g: number, b: number) {
    const steps = Math.max(Math.abs(x1 - x0), Math.abs(y1 - y0));
    for (let i = 0; i <= steps; i++) {
      const x = Math.round(x0 + ((x1 - x0) * i) / steps);
      const y = Math.round(y0 + ((y1 - y0) * i) / steps);
      this.fillRect(x - t, y - t, t * 2 + 1, t * 2 + 1, r, g, b);
    }
  }
  ellipse(cx: number, cy: number, rx: number, ry: number, r: number, g: number, b: number) {
    for (let y = cy - ry; y <= cy + ry; y++)
      for (let x = cx - rx; x <= cx + rx; x++) {
        const dx = (x - cx) / rx;
        const dy = (y - cy) / ry;
        if (dx * dx + dy * dy <= 1) this.set(x, y, r, g, b);
      }
  }
  strokeEllipse(cx: number, cy: number, rx: number, ry: number, t: number, r: number, g: number, b: number) {
    this.ellipse(cx, cy, rx, ry, r, g, b);
    this.ellipse(cx, cy, rx - t, ry - t, 255, 255, 255);
  }
  text(text: string, x: number, y: number, scale: number, r: number, g: number, b: number) {
    let cursor = x;
    for (const ch of text) {
      const glyph = DIGITS[ch];
      if (glyph) {
        for (let row = 0; row < 5; row++)
          for (let col = 0; col < 3; col++)
            if (glyph[row]! & (1 << (2 - col)))
              this.fillRect(cursor + col * scale, y + row * scale, scale, scale, r, g, b);
      }
      cursor += 4 * scale;
    }
  }
}

function page(index: number, total: number): Uint8Array {
  const c = new Canvas(WIDTH, HEIGHT);
  const ink = 20;
  // Page frame.
  c.strokeRect(24, 24, WIDTH - 48, HEIGHT - 48, 4, ink, ink, ink);

  // Header title block.
  c.fillRect(60, 60, 420, 26, ink, ink, ink);
  c.fillRect(60, 100, 300, 12, 120, 120, 120);

  // Top wide panel with a horizon and speed lines.
  c.strokeRect(60, 150, 680, 360, 5, ink, ink, ink);
  c.line(80, 470, 720, 260, 2, 90, 90, 90);
  for (let i = 0; i < 18; i++) c.line(80 + i * 12, 480, 300 + i * 16, 190, 1, 180, 180, 180);

  // Bottom-left panel with a speech bubble.
  c.strokeRect(60, 540, 330, 360, 5, ink, ink, ink);
  c.ellipse(200, 690, 95, 70, 255, 255, 255);
  c.strokeEllipse(200, 690, 95, 70, 4, ink, ink, ink);
  c.line(160, 750, 140, 800, 4, ink, ink, ink);
  c.line(150, 760, 120, 805, 3, ink, ink, ink);
  c.fillRect(140, 660, 120, 10, ink, ink, ink);
  c.fillRect(155, 685, 90, 10, ink, ink, ink);
  c.fillRect(150, 710, 100, 10, ink, ink, ink);

  // Bottom-right panel with a subject.
  c.strokeRect(410, 540, 330, 360, 5, ink, ink, ink);
  c.ellipse(575, 700, 70, 95, 210, 210, 210);
  c.ellipse(575, 640, 46, 46, 235, 235, 235);
  c.strokeEllipse(575, 640, 46, 46, 4, ink, ink, ink);
  c.fillRect(548, 632, 10, 10, ink, ink, ink);
  c.fillRect(592, 632, 10, 10, ink, ink, ink);
  c.line(560, 662, 590, 662, 3, ink, ink, ink);

  // Page number, bottom right.
  const label = `${index + 1}`;
  c.text(label, WIDTH - 70 - label.length * 26, HEIGHT - 84, 6, ink, ink, ink);
  c.text(`/${total}`, WIDTH - 70 - 3 * 12, HEIGHT - 60, 3, 120, 120, 120);
  return encodePng(WIDTH, HEIGHT, (x, y) => {
    const at = (y * WIDTH + x) * 3;
    return [c.pixels[at]!, c.pixels[at + 1]!, c.pixels[at + 2]!];
  });
}

function main(args: Args) {
  const series: [string, number][] = [
    ["Demo Manga", args.pages],
    ["Second Story", Math.max(2, args.pages - 2)],
  ];
  for (const [name, count] of series) {
    const dir = join(args.out, name);
    mkdirSync(dir, { recursive: true });
    for (let i = 0; i < count; i++) {
      const file = join(dir, `page-${String(i + 1).padStart(3, "0")}.png`);
      writeFileSync(file, page(i, count));
    }
    console.log(`  ${name}: ${count} pages -> ${dir}`);
  }
  console.log(`\nnow bake: bun apps/manga/bake.ts --library ${args.out} --out dist/manga-sample/packs`);
}

if (import.meta.main) main(parseArgs(process.argv.slice(2)));

export { page, Canvas };
