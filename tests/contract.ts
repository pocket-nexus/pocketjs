// Contract codec checks — run with `bun run contract`.

import {
abgr,
ANIM_FILL_BACKWARDS,
ANIM_FILL_FORWARDS,
animBit,
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
