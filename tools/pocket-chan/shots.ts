// tools/pocket-chan/shots.ts — capture Pocket Chan from the real PSP host.
//
//   bun tools/pocket-chan/shots.ts [out-dir]
//
// Builds the capture EBOOT with a baked input script (the same mechanism
// tests/e2e/ppsspp.ts uses), runs PPSSPPHeadless on the software renderer and
// decodes the named frames to PNG. The frame index is the Rust frame counter,
// so each shot is a pure function of its index.

import { $ } from "bun";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { homedir } from "node:os";

const ROOT = new URL("../../", import.meta.url).pathname;
const headless = process.env.PPSSPP_HEADLESS || `${homedir()}/ppsspp-src/build/PPSSPPHeadless`;
const dccap = `${homedir()}/.ppsspp/dc_cap`;
const eboot = `${ROOT}hosts/psp/target/mipsel-sony-psp/debug/EBOOT.PBP`;
const out = Bun.argv[2] ?? `${ROOT}.pocket-build/validation/pocket-chan/shots`;

// RIGHT 0x20, DOWN 0x40, CIRCLE 0x2000, TRIANGLE 0x1000, SQUARE 0x8000
const INPUT = [
  "0:0",
  "40:0x20", "44:0",           // next pose
  "60:0x2000", "64:0",         // next line
  "80:0x1000", "84:0",         // language -> ja
  "100:0x40", "104:0",         // next set
  "120:0x1000", "124:0",       // language -> zh
  "150:0x8000", "154:0",       // palette sheet
].join(",");
const CAP_START = 30;
const CAP_N = 140;
const SHOTS = [
  { name: "01-boot-en", frame: 34 },
  { name: "02-pose-en", frame: 54 },
  { name: "03-line-en", frame: 74 },
  { name: "04-ja", frame: 94 },
  { name: "05-actions-ja", frame: 118 },
  { name: "06-zh", frame: 140 },
  { name: "07-sheet-zh", frame: 166 },
];

if (!existsSync(headless)) {
  console.error(`PPSSPPHeadless not found at ${headless} (set PPSSPP_HEADLESS)`);
  process.exit(2);
}
mkdirSync(out, { recursive: true });

console.log("# build capture EBOOT");
await $`bun tools/psp.ts pocket-chan --capture`.cwd(ROOT).env({
  ...process.env,
  POCKETJS_CAPTURE_INPUT: INPUT,
  POCKETJS_CAP_START: String(CAP_START),
  POCKETJS_CAP_N: String(CAP_N),
}).quiet();

console.log("# PPSSPPHeadless (software renderer)");
rmSync(dccap, { recursive: true, force: true });
const timeout = Number(process.env.SHOT_TIMEOUT || 120);
const run = await $`${headless} --graphics=software --timeout=${timeout} ${eboot}`.cwd("/tmp").nothrow().quiet();
const produced = existsSync(dccap) ? readdirSync(dccap).filter((f) => /^f\d{4}\.raw$/.test(f)).length : 0;
console.log(`frames dumped: ${produced}/${CAP_N}`);
if (produced === 0) {
  console.error(run.stdout.toString() + run.stderr.toString());
  process.exit(1);
}

for (const shot of SHOTS) {
  const idx = shot.frame - CAP_START;
  if (idx < 0 || idx >= produced) {
    console.log(`skip ${shot.name}: frame ${shot.frame} outside the captured window`);
    continue;
  }
  const raw = `${dccap}/f${String(idx).padStart(4, "0")}.raw`;
  const png = `${out}/${shot.name}.png`;
  await $`magick -size 512x272 -depth 8 RGBA:${raw} -alpha off -crop 480x272+0+0 +repage -depth 8 -define png:exclude-chunks=date,time PNG24:${png}`.quiet();
  const buf = readFileSync(raw);
  const px = new Uint32Array(buf.buffer, buf.byteOffset, buf.length / 4);
  const distinct = new Set<number>();
  for (let y = 0; y < 272 && distinct.size < 8; y++) for (let x = 0; x < 480; x++) distinct.add(px[y * 512 + x]);
  console.log(`${shot.name}: frame ${shot.frame}, ${distinct.size >= 8 ? "8+" : distinct.size} distinct colours -> ${png}`);
}
