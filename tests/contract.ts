// Spec drift guard — run with `bun run contract` (exit 0 = green).
//
//  (a) Regenerates engine/core/src/spec.rs and
//      engine/crates/pocket-relay/src/generated.rs IN-MEMORY from
//      contracts/spec/spec.ts and byte-compares against the committed files:
//      TS and Rust constants can never drift. Fix = `bun contracts/spec/gen-rust.ts` + commit.
//  (b) Round-trips the styles.bin encoder/decoder over a table exercising
//      every feature (variants, transition, all three value kinds).
//  (c) Regenerates package.json's exports block from the subpath registry
//      (framework/compiler/subpaths.ts) and byte-compares: the npm surface
//      can never drift from the one declaration. Fix = `bun tools/gen-exports.ts`.
//  (d) Regenerates contracts/generated/pocket_spec.h (the C input constants native
//      hosts include) from spec.ts and byte-compares. Fix = `bun contracts/spec/gen-c.ts`.

import { generateC } from "../contracts/spec/gen-c.ts";
import { generateRelayRust, generateRust } from "../contracts/spec/gen-rust.ts";
import { withGeneratedExports } from "../tools/gen-exports.ts";
import { relayConstantsSnapshot } from "../contracts/spec/relay.ts";
import {
  abgr,
  animBit,
  ANIM_FILL_BACKWARDS,
  ANIM_FILL_FORWARDS,
  decodeStyleTable,
  encodeStyleTable,
  ENUMS,
  f32Bits,
  PROP,
  TRANSITION_MASK_ALL,
  type AnimTimeline,
  type StyleRecord,
} from "../contracts/spec/spec.ts";

let failed = false;
function check(ok: boolean, label: string, detail = "") {
  if (ok) {
    console.log(`  ok   ${label}`);
  } else {
    failed = true;
    console.error(`  FAIL ${label}${detail ? ` — ${detail}` : ""}`);
  }
}

// ---- (a) generated spec.rs is in sync ---------------------------------------

const specRsPath = new URL("../engine/core/src/spec.rs", import.meta.url).pathname;
const committed = await Bun.file(specRsPath).text().catch(() => null);
const expected = generateRust();
check(
  committed !== null && committed === expected,
  "engine/core/src/spec.rs matches spec.ts",
  "run `bun contracts/spec/gen-rust.ts` and commit the result",
);

// ---- (d) generated pocket_spec.h is in sync -----------------------------------

const specHPath = new URL("../contracts/generated/pocket_spec.h", import.meta.url).pathname;
const committedHeader = await Bun.file(specHPath).text().catch(() => null);
check(
  committedHeader !== null && committedHeader === generateC(),
  "contracts/generated/pocket_spec.h matches spec.ts",
  "run `bun contracts/spec/gen-c.ts` and commit the result",
);

// ---- (e) relay constants: spec.ts, constants.json and generated spec.rs -----
//
// The TS/C/Rust frame layers share one byte-level vector set. The committed
// tests/fixtures/relay/constants.json is the snapshot C and Rust compare
// against; regenerate it together with the vectors via
// `bun tests/fixtures/relay/generate.ts`.

const relayJsonPath = new URL("../tests/fixtures/relay/constants.json", import.meta.url).pathname;
const relayJsonText = await Bun.file(relayJsonPath).text().catch(() => null);
check(
  relayJsonText !== null && relayJsonText === JSON.stringify(relayConstantsSnapshot(), null, 2) + "\n",
  "tests/fixtures/relay/constants.json matches contracts/spec/relay.ts",
  "run `bun tests/fixtures/relay/generate.ts` and commit the result",
);
// The relay constants reach Rust twice from the same emitter: the desktop
// core's spec.rs (byte-guarded by check (a) above) and the no_std frame crate
// engine/crates/pocket-relay, which hosts/psp builds without pulling in
// pocketjs-core. Guard the second file the same way.

const relayRsPath = new URL("../engine/crates/pocket-relay/src/generated.rs", import.meta.url).pathname;
const committedRelayRs = await Bun.file(relayRsPath).text().catch(() => null);
check(
  committedRelayRs !== null && committedRelayRs === generateRelayRust(),
  "engine/crates/pocket-relay/src/generated.rs matches contracts/spec/relay.ts",
  "run `bun contracts/spec/gen-rust.ts` and commit the result",
);

// ---- (c) package.json exports match the subpath registry ---------------------

const pkgPath = new URL("../package.json", import.meta.url).pathname;
const pkgText = await Bun.file(pkgPath).text();
check(
  withGeneratedExports(pkgText) === pkgText,
  "package.json exports match framework/compiler/subpaths.ts",
  "run `bun tools/gen-exports.ts` and commit the result",
);

// ---- (b) style table encoder/decoder round-trip ------------------------------

const table: StyleRecord[] = [
  // full-feature record: all variants + transition + all three value kinds
  {
    base: [
      { prop: PROP.width, value: f32Bits(120) },
      { prop: PROP.bgColor, value: abgr(30, 41, 59) },
      { prop: PROP.gradVia, value: abgr(59, 130, 246) },
      { prop: PROP.gradViaPos, value: f32Bits(0.5) },
      { prop: PROP.flexDir, value: ENUMS.FlexDir.Col },
    ],
    focus: [{ prop: PROP.bgColor, value: abgr(129, 140, 248) }],
    active: [{ prop: PROP.scale, value: f32Bits(0.95) }],
    transition: {
      mask: (1 << animBit("bgColor")) | (1 << animBit("scale")),
      durMs: 150,
      delayMs: 16,
      easing: ENUMS.Easing.EaseOut,
    },
  },
  // base-only record
  { base: [{ prop: PROP.opacity, value: f32Bits(0.5) }] },
  // bevel rings: base raised + active pressed inversion (Win98 chrome)
  {
    base: [
      { prop: PROP.bevelOuterLight, value: abgr(255, 255, 255) },
      { prop: PROP.bevelOuterDark, value: abgr(0, 0, 0) },
      { prop: PROP.bevelInnerLight, value: abgr(0xdf, 0xdf, 0xdf) },
      { prop: PROP.bevelInnerDark, value: abgr(0x80, 0x80, 0x80) },
      { prop: PROP.bevelWidth, value: f32Bits(2) },
    ],
    active: [
      { prop: PROP.bevelOuterLight, value: abgr(0, 0, 0) },
      { prop: PROP.bevelOuterDark, value: abgr(255, 255, 255) },
    ],
  },
  // transition-all, no base (focus-only)
  {
    focus: [{ prop: PROP.translateX, value: f32Bits(8) }],
    transition: { mask: TRANSITION_MASK_ALL, durMs: 300, delayMs: 0, easing: ENUMS.Easing.Spring },
  },
  // animated record: baked-timeline refs + whole-choreography loop
  {
    base: [{ prop: PROP.width, value: f32Bits(64) }],
    animation: { anims: [0, 1], loopFrames: 240 },
  },
  // empty record (valid: flags = 0)
  {},
];

const anims: AnimTimeline[] = [
  // two-track timeline, plain easing + a cubic-bezier segment
  {
    delayFrames: 12,
    periodFrames: 36,
    iterations: 1,
    fill: ANIM_FILL_BACKWARDS | ANIM_FILL_FORWARDS,
    tracks: [
      {
        prop: PROP.translateY,
        segments: [
          { t0: 0, t1: 22, from: f32Bits(60), to: f32Bits(-3), easing: ENUMS.Easing.CubicBezier, bezier: [0.42, 0, 0.58, 1] },
          { t0: 22, t1: 36, from: f32Bits(-3), to: f32Bits(0), easing: ENUMS.Easing.Linear },
        ],
      },
      {
        prop: PROP.bgColor,
        segments: [
          { t0: 0, t1: 36, from: abgr(119, 119, 119), to: abgr(204, 204, 204), easing: ENUMS.Easing.EaseInOut },
        ],
      },
    ],
  },
  // infinite spin
  {
    delayFrames: 0,
    periodFrames: 60,
    iterations: 0,
    fill: 0,
    tracks: [
      {
        prop: PROP.rotate,
        segments: [{ t0: 0, t1: 60, from: f32Bits(0), to: f32Bits(360), easing: ENUMS.Easing.Linear }],
      },
    ],
  },
];

// Key order differs between literal input and decoder output; compare a
// canonical projection instead of raw JSON.
function canon(t: StyleRecord[], a: AnimTimeline[]) {
  return JSON.stringify([
    t.map((s) => ({
      base: s.base ?? null,
      focus: s.focus ?? null,
      active: s.active ?? null,
      transition: s.transition ?? null,
      animation: s.animation ?? null,
    })),
    a.map((tl) => ({
      ...tl,
      tracks: tl.tracks.map((tr) => ({
        prop: tr.prop,
        segments: tr.segments.map((seg) => ({
          t0: seg.t0,
          t1: seg.t1,
          from: seg.from,
          to: seg.to,
          easing: seg.easing,
          // bezier params travel as f32 bits — fround the f64 input side too
          bezier: seg.bezier ? seg.bezier.map(Math.fround) : null,
        })),
      })),
    })),
  ]);
}

try {
  const bytes = encodeStyleTable(table, anims);
  const back = decodeStyleTable(bytes);
  check(
    canon(back.styles, back.anims) === canon(table, anims),
    "styles.bin encode/decode round-trip",
    "decoded table differs from input",
  );
  // spot-check the pinned header bytes
  const dv = new DataView(bytes.buffer);
  check(dv.getUint32(0, true) === 0x54534344, "styles.bin magic bytes 'DCST'");
  check(dv.getUint16(4, true) === 2, "styles.bin version 2");
  check(dv.getUint16(6, true) === table.length, "styles.bin styleCount");
  check(dv.getUint16(8, true) === anims.length, "styles.bin animCount");
} catch (e) {
  check(false, "styles.bin encode/decode round-trip", String(e));
}

if (failed) {
  console.error("\ncontract: FAILED");
  process.exit(1);
}
console.log("\ncontract: all green");
