import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { unbake } from "../tools/pocket3d-title.ts";
import { art, FADE_IN, FADE_OUT, level, TICKS } from "../engine/pocket3d/crates/pocket3d-title/web/pocket3d-title.js";

// The Pocket3D title card has three drawers: the Rust crate (PS Vita, PSP),
// a C header (Nintendo 3DS) and a browser module. They read one baked art and
// one timeline; these tests hold them to the frames the crate's own tests record.
const CRATE = resolve("engine/pocket3d/crates/pocket3d-title") + "/";
const rust = readFileSync(CRATE + "src/lib.rs", "utf8");
const header = readFileSync(CRATE + "include/pocket3d_title.h", "utf8");
const full = new Uint8Array(readFileSync(CRATE + "art/full.bin"));
const half = new Uint8Array(readFileSync(CRATE + "art/half.bin"));

const constant = (source: string, pattern: RegExp) => Number(source.match(pattern)![1]);
const fnv = (bytes: Uint8Array) => {
  let hash = 0xcbf29ce484222325n;
  for (const byte of bytes) hash = ((hash ^ BigInt(byte)) * 0x100000001b3n) & 0xffffffffffffffffn;
  return hash;
};

test("the baked art is two palettes of run-length rows on the plum ground", () => {
  for (const [bytes, width, height] of [[full, 624, 192], [half, 312, 96]] as const) {
    expect(String.fromCharCode(...bytes.subarray(0, 4))).toBe("P3T1");
    const view = new DataView(bytes.buffer);
    expect([view.getUint16(4, true), view.getUint16(6, true)]).toEqual([width, height]);
    expect(view.getUint16(8, true)).toBeLessThanOrEqual(256);
    // entry 0 is the ground the consoles fill the screen with
    expect([...bytes.subarray(12, 15)]).toEqual([0x17, 0x12, 0x26]);
    const picture = unbake(bytes);
    expect(picture.rgba.length).toBe(width * height * 4);
    // the four corners are ground, and the art covers a fifth of the picture or more
    for (const corner of [0, width - 1, (height - 1) * width, height * width - 1]) {
      expect([...picture.rgba.subarray(corner * 4, corner * 4 + 3)]).toEqual([0x17, 0x12, 0x26]);
    }
    let inked = 0;
    for (let i = 0; i < width * height; i++) if (picture.rgba[i * 4] !== 0x17 || picture.rgba[i * 4 + 2] !== 0x26) inked++;
    expect(inked / (width * height)).toBeGreaterThan(0.2);
  }
  // both stay small enough to sit in a console binary and in this repository
  expect(full.length + half.length).toBeLessThan(64 * 1024);
});

test("the generated C array and the browser module carry the baked bytes", () => {
  const array = readFileSync(CRATE + "include/pocket3d_title_art.h", "utf8");
  const values = array.slice(array.indexOf("{") + 1, array.lastIndexOf("}")).split(",").map((value) => Number(value.trim()));
  expect(values).toEqual([...half]);
  expect(array).toContain(`pocket3d_title_art_half[${half.length}]`);
  const web = readFileSync(CRATE + "web/art.js", "utf8").match(/FULL = "([^"]+)"/)![1];
  expect(Buffer.from(web, "base64").equals(Buffer.from(full))).toBe(true);
});

test("the three drawers share one timeline", () => {
  const ticks = constant(rust, /pub const TICKS: u32 = (\d+);/);
  const fadeIn = constant(rust, /pub const FADE_IN: u32 = (\d+);/);
  const fadeOut = constant(rust, /pub const FADE_OUT: u32 = (\d+);/);
  expect([TICKS, FADE_IN, FADE_OUT]).toEqual([ticks, fadeIn, fadeOut]);
  expect(constant(header, /#define POCKET3D_TITLE_TICKS (\d+)u/)).toBe(ticks);
  expect(constant(header, /#define POCKET3D_TITLE_FADE_IN (\d+)u/)).toBe(fadeIn);
  expect(constant(header, /#define POCKET3D_TITLE_FADE_OUT (\d+)u/)).toBe(fadeOut);
  // 2.4 seconds at 60 Hz: up from black, a hold at full light, back to black
  expect(ticks).toBe(144);
  expect(level(fadeIn - 1)).toBe(256);
  expect(level(ticks - fadeOut - 1)).toBe(256);
  expect(level(ticks - 1)).toBe(0);
  for (let tick = 1; tick < fadeIn; tick++) expect(level(tick)).toBeGreaterThanOrEqual(level(tick - 1));
});

test("the browser decodes the art to the PS Vita frame the crate records", () => {
  const picture = art();
  expect([picture.width, picture.height, picture.ground]).toEqual([624, 192, [0x17, 0x12, 0x26]]);
  // a held frame is the ground with the art in the middle of 960 x 544
  const frame = new Uint8Array(960 * 544 * 4);
  for (let i = 0; i < 960 * 544; i++) frame.set([0x17, 0x12, 0x26, 255], i * 4);
  for (let y = 0; y < 192; y++) frame.set(picture.rgba.subarray(y * 624 * 4, (y + 1) * 624 * 4), ((176 + y) * 960 + 168) * 4);
  const recorded = BigInt(rust.match(/Layout::Rgba8, 60\)\), (0x[0-9a-f_]+), "PS Vita"/)![1].replaceAll("_", ""));
  expect(fnv(frame)).toBe(recorded);
});

test("the C header draws the Nintendo 3DS frames the crate records", () => {
  const table = rust.slice(rust.indexOf("const NINTENDO_3DS_FRAMES"), rust.indexOf("#[test]\n    fn the_frames_are_the_recorded_ones"));
  const recorded = [...table.matchAll(/\((\d+), (0x[0-9a-f_]+)\)/g)].map((match) => `${match[1]} ${match[2].replaceAll("_", "")}`);
  expect(recorded.length).toBe(5);
  const output = mkdtempSync(join(tmpdir(), "pocket3d-title-"));
  try {
    const binary = join(output, "frames");
    const build = Bun.spawnSync([process.env.CC || "cc", "-std=c99", "-Wall", "-Wextra", "-Werror", "-pedantic",
      "-I", CRATE + "include", resolve("tests/fixtures/pocket3d-title/frames.c"), "-o", binary]);
    expect(build.exitCode, build.stderr.toString()).toBe(0);
    const run = Bun.spawnSync([binary, ...recorded.map((line) => line.split(" ")[0])]);
    expect(run.exitCode, run.stderr.toString()).toBe(0);
    expect(run.stdout.toString().trim().split("\n")).toEqual(recorded);
  } finally { rmSync(output, { recursive: true, force: true }); }
});
