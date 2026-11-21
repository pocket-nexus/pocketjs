// tools/pocket3d-title.ts — bake the art of the Pocket3D title card.
//
//   bun tools/pocket3d-title.ts            write the art
//   bun tools/pocket3d-title.ts --preview  also write PNGs to .pocket-build/pocket3d-title/
//
// site/pocket3d/title-card.html draws the mark and the wordmark on the plum
// ground. This opens it in headless Chrome at 624 x 192 and at 312 x 96,
// reduces each capture to a palette of at most 256 colours, and writes it in
// the form the title card reads on a console:
//
//   engine/pocket3d/crates/pocket3d-title/art/full.bin    PS Vita
//   engine/pocket3d/crates/pocket3d-title/art/half.bin    PSP, Nintendo 3DS
//   engine/pocket3d/crates/pocket3d-title/include/pocket3d_title_art.h
//                                                         half.bin as a C array
//   engine/pocket3d/crates/pocket3d-title/web/art.js      full.bin as base64
//
// The file layout (little-endian) is the one src/lib.rs and pocket3d_title.h
// decode:
//
//   "P3T1"  u16 width  u16 height  u16 colours  u16 0
//   colours x (r, g, b)
//   height x u32      offset of each row inside the row data
//   rows              (run - 1, palette index) pairs, run 1..=256
//
// Palette entry 0 is the ground, so a console fills the screen with it and
// copies the art into the middle. The page loads Fredoka from Google Fonts,
// so the command needs a network; the outputs are committed.

import { mkdirSync, writeFileSync } from "node:fs";
import { HeadlessChrome } from "./headless-chrome.ts";
import { medianCut } from "./median-cut.ts";
import { decodePNG, encodePNG } from "./png.ts";

const ROOT = new URL("..", import.meta.url).pathname;
const PAGE = `${ROOT}site/pocket3d/title-card.html`;
const CRATE = `${ROOT}engine/pocket3d/crates/pocket3d-title/`;
const GROUND = [0x17, 0x12, 0x26];
const SIZES = [
  { name: "full", scale: 1, width: 624, height: 192 },
  { name: "half", scale: 0.5, width: 312, height: 96 },
];

function bake(rgba: Uint8Array, width: number, height: number): Uint8Array {
  const key = (r: number, g: number, b: number) => (r << 16) | (g << 8) | b;
  const ground = key(GROUND[0], GROUND[1], GROUND[2]);
  const counts = new Map<number, number>();
  for (let i = 0; i < width * height; i++) {
    const k = key(rgba[i * 4], rgba[i * 4 + 1], rgba[i * 4 + 2]);
    counts.set(k, (counts.get(k) ?? 0) + 1);
  }
  if (!counts.has(ground)) throw new Error("the capture has no pixel of the ground colour");
  counts.delete(ground);
  const colours = [...counts].map(([k, count]) => ({ r: k >> 16, g: (k >> 8) & 255, b: k & 255, count }));
  const boxes = medianCut(colours, 255);
  const entries: number[][] = [GROUND];
  const index = new Map<number, number>([[ground, 0]]);
  for (const box of boxes) {
    const total = box.reduce((sum, colour) => sum + colour.count, 0);
    entries.push(["r", "g", "b"].map((c) => Math.round(box.reduce((sum, colour) => sum + colour[c as "r"] * colour.count, 0) / total)));
    for (const colour of box) index.set(key(colour.r, colour.g, colour.b), entries.length - 1);
  }

  const rows: number[][] = [];
  for (let y = 0; y < height; y++) {
    const row: number[] = [];
    let run = 0, last = -1;
    for (let x = 0; x < width; x++) {
      const at = (y * width + x) * 4;
      const value = index.get(key(rgba[at], rgba[at + 1], rgba[at + 2]))!;
      if (value === last && run < 256) run++;
      else { if (run) row.push(run - 1, last); run = 1; last = value; }
    }
    row.push(run - 1, last);
    rows.push(row);
  }

  const head = 12 + entries.length * 3 + height * 4;
  const out = new Uint8Array(head + rows.reduce((sum, row) => sum + row.length, 0));
  const view = new DataView(out.buffer);
  out.set([0x50, 0x33, 0x54, 0x31]); // "P3T1"
  view.setUint16(4, width, true);
  view.setUint16(6, height, true);
  view.setUint16(8, entries.length, true);
  entries.forEach((entry, i) => out.set(entry, 12 + i * 3));
  let offset = 0;
  rows.forEach((row, y) => {
    view.setUint32(12 + entries.length * 3 + y * 4, offset, true);
    out.set(row, head + offset);
    offset += row.length;
  });
  return out;
}

/** Decode baked art back to RGBA, the way the consoles do, for the preview. */
export function unbake(art: Uint8Array): { rgba: Uint8Array; width: number; height: number } {
  const view = new DataView(art.buffer, art.byteOffset, art.byteLength);
  const width = view.getUint16(4, true), height = view.getUint16(6, true), colours = view.getUint16(8, true);
  const rowsAt = 12 + colours * 3, dataAt = rowsAt + height * 4;
  const rgba = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y++) {
    let at = dataAt + view.getUint32(rowsAt + y * 4, true);
    for (let x = 0; x < width; ) {
      const run = art[at] + 1, value = art[at + 1];
      at += 2;
      for (let i = 0; i < run; i++, x++) {
        rgba.set([art[12 + value * 3], art[12 + value * 3 + 1], art[12 + value * 3 + 2], 255], (y * width + x) * 4);
      }
    }
  }
  return { rgba, width, height };
}

function header(name: string, art: Uint8Array): string {
  const lines: string[] = [];
  for (let i = 0; i < art.length; i += 20) lines.push("  " + Array.from(art.subarray(i, i + 20)).join(","));
  return `/* Generated by tools/pocket3d-title.ts from site/pocket3d/title-card.html: the
   bytes of art/${name}.bin. Do not edit. */
#ifndef POCKET3D_TITLE_ART_H
#define POCKET3D_TITLE_ART_H
static const unsigned char pocket3d_title_art_${name}[${art.length}] = {
${lines.join(",\n")}
};
#endif
`;
}

if (import.meta.main) {
  const preview = process.argv.includes("--preview");
  mkdirSync(CRATE + "art", { recursive: true });
  mkdirSync(CRATE + "include", { recursive: true });
  mkdirSync(CRATE + "web", { recursive: true });
  const chrome = await HeadlessChrome.start({ port: 9412, profile: `${process.env.TMPDIR ?? "/tmp/"}pocket3d-title` });
  try {
    for (const size of SIZES) {
      await chrome.viewport(size.width, size.height);
      await chrome.navigate("about:blank");
      await chrome.navigate(`file://${PAGE}#${size.scale}`);
      const ready = await chrome.evaluate(`(async () => {
        await document.fonts.ready;
        await Promise.all([...document.images].map((image) => image.decode()));
        await new Promise((r) => setTimeout(r, 300));
        return document.fonts.check("600 80px Fredoka", "Pocket3D");
      })()`);
      if (ready !== true) throw new Error("Fredoka did not load");
      const shot = decodePNG(await chrome.screenshot());
      if (shot.w !== size.width || shot.h !== size.height) throw new Error(`${size.name}: captured ${shot.w}x${shot.h}`);
      const art = bake(shot.rgba, size.width, size.height);
      writeFileSync(`${CRATE}art/${size.name}.bin`, art);
      if (size.name === "half") writeFileSync(`${CRATE}include/pocket3d_title_art.h`, header(size.name, art));
      else writeFileSync(`${CRATE}web/art.js`, `// Generated by tools/pocket3d-title.ts from site/pocket3d/title-card.html: the\n// bytes of art/full.bin as base64. Do not edit.\nexport const FULL = "${Buffer.from(art).toString("base64")}";\n`);
      console.log(`  art/${size.name}.bin  ${size.width}x${size.height}  ${new DataView(art.buffer).getUint16(8, true)} colours  ${(art.length / 1024).toFixed(1)} KiB`);
      if (preview) {
        const out = `${ROOT}.pocket-build/pocket3d-title/`;
        mkdirSync(out, { recursive: true });
        const back = unbake(art);
        writeFileSync(`${out}${size.name}.png`, encodePNG(back.rgba, back.width, back.height));
      }
    }
  } finally {
    chrome.stop();
  }
}
