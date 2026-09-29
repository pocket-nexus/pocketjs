// Unit tests for the Tailwind-subset token parser (framework/compiler/tailwind.ts).
// Run: bun test tests/tailwind.test.ts   (wired into `bun run test`).

import { describe, expect, test } from "bun:test";
import {
  DEFAULT_FONT_SLOT,
  compileClasses,
  fontSlotFor,
  paletteColor,
  parseClassLiteral,
} from "../framework/compiler/tailwind.ts";
import {
  ANIM_FILL_BACKWARDS,
  ANIM_FILL_FORWARDS,
  ENUMS,
  PROP,
  SIZE_FULL,
  TRANSITION_MASK_ALL,
  abgr,
  animBit,
  bitsF32,
  decodeStyleTable,
  f32Bits,
  type StyleProp,
  type StyleRecord,
} from "../contracts/spec/spec.ts";
import {
  bakedTimelines,
  registerAnimationTheme,
  resetAnimationBake,
  setAnimationTickRate,
} from "../framework/compiler/animation.ts";

function props(rec: StyleRecord | null, variant: "base" | "focus" | "active" = "base"): Map<number, number> {
  expect(rec).not.toBeNull();
  const list: StyleProp[] = rec![variant] ?? [];
  return new Map(list.map((p) => [p.prop, p.value]));
}

const f32Of = (m: Map<number, number>, prop: number): number => {
  expect(m.has(prop)).toBeTrue();
  return bitsF32(m.get(prop)!);
};

describe("palette", () => {
  test("known colors", () => {
    expect(paletteColor("white")).toBe(abgr(255, 255, 255));
    expect(paletteColor("black")).toBe(abgr(0, 0, 0));
    expect(paletteColor("transparent")).toBe(0);
    expect(paletteColor("slate-900")).toBe(abgr(0x0f, 0x17, 0x2a));
    expect(paletteColor("indigo-500")).toBe(abgr(0x63, 0x66, 0xf1));
    expect(paletteColor("emerald-400")).toBe(abgr(0x34, 0xd3, 0x99));
    expect(paletteColor("rose-950")).toBe(abgr(0x4c, 0x05, 0x19));
  });
  test("rejections", () => {
    expect(paletteColor("slate-901")).toBeNull();
    expect(paletteColor("mauve-500")).toBeNull();
    expect(paletteColor("slate")).toBeNull();
  });
});

describe("spacing / box", () => {
  test("p-2 = 8px on all four sides", () => {
    const m = props(parseClassLiteral("p-2"));
    for (const p of [PROP.paddingT, PROP.paddingR, PROP.paddingB, PROP.paddingL]) {
      expect(bitsF32(m.get(p)!)).toBe(8);
    }
  });
  test("px-3 / mt-1.5 axis and fractional scale", () => {
    const m = props(parseClassLiteral("px-3 mt-1.5"));
    expect(bitsF32(m.get(PROP.paddingL)!)).toBe(12);
    expect(bitsF32(m.get(PROP.paddingR)!)).toBe(12);
    expect(m.has(PROP.paddingT)).toBeFalse();
    expect(bitsF32(m.get(PROP.marginT)!)).toBe(6);
  });
  test("w-16 h-full and arbitrary values", () => {
    const m = props(parseClassLiteral("w-16 h-full"));
    expect(f32Of(m, PROP.width)).toBe(64);
    expect(f32Of(m, PROP.height)).toBe(SIZE_FULL);
    const a = props(parseClassLiteral("w-[123px] h-[45]"));
    expect(f32Of(a, PROP.width)).toBe(123);
    expect(f32Of(a, PROP.height)).toBe(45);
  });
  test("min/max, inset, z, absolute", () => {
    const m = props(parseClassLiteral("absolute inset-0 top-2 min-w-10 max-h-20 z-5"));
    expect(m.get(PROP.posType)).toBe(ENUMS.PosType.Absolute);
    expect(f32Of(m, PROP.insetT)).toBe(8); // inset-0 then top-2 (last wins)
    expect(f32Of(m, PROP.insetB)).toBe(0);
    expect(f32Of(m, PROP.minW)).toBe(40);
    expect(f32Of(m, PROP.maxH)).toBe(80);
    expect(m.get(PROP.zIndex)).toBe(5);
  });
  test("hidden / overflow-hidden", () => {
    const m = props(parseClassLiteral("hidden overflow-hidden"));
    expect(m.get(PROP.display)).toBe(ENUMS.Display.None);
    expect(m.get(PROP.overflow)).toBe(ENUMS.Overflow.Hidden);
  });
});

describe("flex", () => {
  test("full flex row", () => {
    const m = props(parseClassLiteral("flex flex-row justify-between items-center gap-4 flex-wrap"));
    expect(m.get(PROP.display)).toBe(ENUMS.Display.Flex);
    expect(m.get(PROP.flexDir)).toBe(ENUMS.FlexDir.Row);
    expect(m.get(PROP.justify)).toBe(ENUMS.Justify.Between);
    expect(m.get(PROP.align)).toBe(ENUMS.Align.Center);
    expect(f32Of(m, PROP.gap)).toBe(16);
    expect(m.get(PROP.flexWrap)).toBe(1);
  });
  test("flex-1 expands to grow/shrink/basis", () => {
    const m = props(parseClassLiteral("flex-1"));
    expect(f32Of(m, PROP.grow)).toBe(1);
    expect(f32Of(m, PROP.shrink)).toBe(1);
    expect(f32Of(m, PROP.basis)).toBe(0);
  });
  test("grow-0 shrink-0 basis-8", () => {
    const m = props(parseClassLiteral("grow-0 shrink-0 basis-8"));
    expect(f32Of(m, PROP.grow)).toBe(0);
    expect(f32Of(m, PROP.shrink)).toBe(0);
    expect(f32Of(m, PROP.basis)).toBe(32);
  });
});

describe("visual", () => {
  test("bg + gradient + border + shadow + opacity + rounded", () => {
    const m = props(
      parseClassLiteral("bg-slate-900 bg-gradient-to-b from-indigo-500 via-[#4263eb] to-transparent border border-white shadow-md opacity-50 rounded-lg"),
    );
    expect(m.get(PROP.bgColor)).toBe(abgr(0x0f, 0x17, 0x2a));
    expect(m.get(PROP.gradDir)).toBe(ENUMS.GradDir.ToBottom);
    expect(m.get(PROP.gradFrom)).toBe(abgr(0x63, 0x66, 0xf1));
    expect(m.get(PROP.gradVia)).toBe(abgr(0x42, 0x63, 0xeb));
    expect(f32Of(m, PROP.gradViaPos)).toBe(0.5);
    expect(m.get(PROP.gradTo)).toBe(0);
    expect(f32Of(m, PROP.borderWidth)).toBe(1);
    expect(m.get(PROP.borderColor)).toBe(abgr(255, 255, 255));
    expect(m.get(PROP.shadow)).toBe(2);
    expect(f32Of(m, PROP.opacity)).toBe(0.5);
    expect(f32Of(m, PROP.radius)).toBe(8);
  });
  test("rounded-full bakes radius from pinned w/h", () => {
    const m = props(parseClassLiteral("w-12 h-8 rounded-full"));
    expect(f32Of(m, PROP.radius)).toBe(16); // min(48,32)/2
  });
  test("rounded-full without pinned size throws [R]", () => {
    expect(() => parseClassLiteral("rounded-full bg-white")).toThrow(/rounded-full/);
    expect(() => parseClassLiteral("w-12 rounded-full")).toThrow(/rounded-full/);
    expect(() => parseClassLiteral("w-full h-full rounded-full")).toThrow(/rounded-full/);
  });
});

describe("bevel", () => {
  test("two-color form sets the outer ring only", () => {
    const m = props(parseClassLiteral("bevel-[#fff,#000]"));
    expect(m.get(PROP.bevelOuterLight)).toBe(abgr(255, 255, 255));
    expect(m.get(PROP.bevelOuterDark)).toBe(abgr(0, 0, 0));
    expect(m.has(PROP.bevelInnerLight)).toBeFalse();
    expect(m.has(PROP.bevelInnerDark)).toBeFalse();
  });
  test("four-color form sets both rings (Win98 raised order)", () => {
    const m = props(parseClassLiteral("bevel-[#ffffff,#000000,#dfdfdf,#808080] bevel-w-[2]"));
    expect(m.get(PROP.bevelOuterLight)).toBe(abgr(255, 255, 255));
    expect(m.get(PROP.bevelOuterDark)).toBe(abgr(0, 0, 0));
    expect(m.get(PROP.bevelInnerLight)).toBe(abgr(0xdf, 0xdf, 0xdf));
    expect(m.get(PROP.bevelInnerDark)).toBe(abgr(0x80, 0x80, 0x80));
    expect(f32Of(m, PROP.bevelWidth)).toBe(2);
  });
  test("active: inversion folds into the active variant", () => {
    const rec = parseClassLiteral("bevel-[#fff,#000] active:bevel-[#000,#fff]");
    expect(props(rec).get(PROP.bevelOuterLight)).toBe(abgr(255, 255, 255));
    expect(props(rec, "active").get(PROP.bevelOuterLight)).toBe(abgr(0, 0, 0));
    expect(props(rec, "active").get(PROP.bevelOuterDark)).toBe(abgr(255, 255, 255));
  });
  test("malformed bevel values reject the literal (all-or-nothing)", () => {
    expect(parseClassLiteral("bevel-[#fff]")).toBeNull(); // 1 color
    expect(parseClassLiteral("bevel-[#fff,#000,#ccc]")).toBeNull(); // 3 colors
    expect(parseClassLiteral("bevel-[white,black]")).toBeNull(); // not hex
    expect(parseClassLiteral("bevel-w-2")).toBeNull(); // arbitrary-only width
    expect(parseClassLiteral("bevel-w-[0]")).toBeNull(); // width must be > 0
  });
  test("bevel + rounded* is a loud error", () => {
    expect(() => parseClassLiteral("bevel-[#fff,#000] rounded")).toThrow(/square-only/);
    expect(() => parseClassLiteral("bevel-[#fff,#000] rounded-lg")).toThrow(/square-only/);
    expect(() => parseClassLiteral("bevel-w-[2] rounded-[3]")).toThrow(/square-only/);
    expect(() => parseClassLiteral("active:bevel-[#fff,#000] rounded-sm")).toThrow(/square-only/);
    expect(() => parseClassLiteral("w-8 h-8 rounded-full bevel-[#fff,#000]")).toThrow(/square-only/);
  });
});

describe("text", () => {
  test("size + weight combine into one font slot", () => {
    const m = props(parseClassLiteral("text-2xl font-bold text-white"));
    expect(m.get(PROP.fontSlot)).toBe(fontSlotFor(24, true));
    expect(m.get(PROP.textColor)).toBe(abgr(255, 255, 255));
  });
  test("appends 54px regular and bold slots without renumbering legacy slots", () => {
    expect(fontSlotFor(36, true)).toBe(13);
    expect(fontSlotFor(54, false)).toBe(14);
    expect(fontSlotFor(54, true)).toBe(15);
    expect(props(parseClassLiteral("text-5xl font-bold")).get(PROP.fontSlot)).toBe(15);
  });
  test("font-bold alone defaults to 16px bold", () => {
    const m = props(parseClassLiteral("font-bold"));
    expect(m.get(PROP.fontSlot)).toBe(fontSlotFor(16, true));
  });
  test("align / leading / tracking", () => {
    const m = props(parseClassLiteral("text-center leading-6 tracking-wide text-lg"));
    expect(m.get(PROP.textAlign)).toBe(ENUMS.TextAlign.Center);
    expect(f32Of(m, PROP.lineHeight)).toBe(24);
    expect(f32Of(m, PROP.tracking)).toBeCloseTo(0.025 * 18, 5);
    expect(m.get(PROP.fontSlot)).toBe(fontSlotFor(18, false));
  });
});

describe("transform", () => {
  test("translate/scale/rotate", () => {
    const m = props(parseClassLiteral("translate-x-2 translate-y-[10px] scale-95 scale-x-50 scale-y-125 rotate-45"));
    expect(f32Of(m, PROP.translateX)).toBe(8);
    expect(f32Of(m, PROP.translateY)).toBe(10);
    expect(f32Of(m, PROP.scale)).toBeCloseTo(0.95, 5);
    expect(f32Of(m, PROP.scaleX)).toBeCloseTo(0.5, 5);
    expect(f32Of(m, PROP.scaleY)).toBeCloseTo(1.25, 5);
    expect(f32Of(m, PROP.rotate)).toBe(45);
  });
});

describe("variants", () => {
  test("focus:/active: fold into the same record", () => {
    const rec = parseClassLiteral("bg-indigo-500 focus:bg-indigo-300 active:scale-95");
    expect(props(rec).get(PROP.bgColor)).toBe(abgr(0x63, 0x66, 0xf1));
    expect(props(rec, "focus").get(PROP.bgColor)).toBe(abgr(0xa5, 0xb4, 0xfc));
    expect(bitsF32(props(rec, "active").get(PROP.scale)!)).toBeCloseTo(0.95, 5);
  });
  test("hover: is a loud error in an otherwise-valid literal", () => {
    expect(() => parseClassLiteral("p-2 hover:bg-white")).toThrow(/hover/);
  });
});

describe("motion", () => {
  test("transition-colors duration-150", () => {
    const rec = parseClassLiteral("bg-indigo-500 transition-colors duration-150")!;
    expect(rec.transition).toBeDefined();
    expect(rec.transition!.durMs).toBe(150);
    expect(rec.transition!.delayMs).toBe(0);
    expect(rec.transition!.easing).toBe(ENUMS.Easing.EaseInOut);
    const mask = rec.transition!.mask;
    expect(mask & (1 << animBit("bgColor"))).not.toBe(0);
    expect(mask & (1 << animBit("translateX"))).toBe(0);
  });
  test("transition-all + ease-spring + delay", () => {
    const rec = parseClassLiteral("transition-all duration-300 ease-spring delay-16")!;
    expect(rec.transition!.mask).toBe(TRANSITION_MASK_ALL);
    expect(rec.transition!.durMs).toBe(300);
    expect(rec.transition!.delayMs).toBe(16);
    expect(rec.transition!.easing).toBe(ENUMS.Easing.Spring);
  });
  test("plain transition covers colors+opacity+transform", () => {
    const rec = parseClassLiteral("transition")!;
    const mask = rec.transition!.mask;
    for (const p of ["bgColor", "textColor", "opacity", "scale", "scaleX", "scaleY", "rotate"] as const) {
      expect(mask & (1 << animBit(p))).not.toBe(0);
    }
    for (const p of ["width", "gap", "radius"] as const) {
      expect(mask & (1 << animBit(p))).toBe(0);
    }
  });
  test("duration/ease/delay WITHOUT a transition utility default to mask ALL (CSS initial transition-property: all)", () => {
    const rec = parseClassLiteral("w-20 duration-300")!;
    expect(rec.transition).toBeDefined();
    expect(rec.transition!.mask).toBe(TRANSITION_MASK_ALL);
    expect(rec.transition!.durMs).toBe(300);
    const d = parseClassLiteral("delay-100 ease-out w-20")!;
    expect(d.transition!.mask).toBe(TRANSITION_MASK_ALL);
    expect(d.transition!.delayMs).toBe(100);
    expect(d.transition!.easing).toBe(ENUMS.Easing.EaseOut);
  });
});

describe("all-or-nothing rejection [R]", () => {
  const rejected = [
    "Press Circle", // ordinary text
    "Count:", // colon, not a variant
    "logo.png", // asset name
    "p-2 unknown-utility", // one bad token poisons the literal
    "p-2 hover", // bare non-utility word
    "60", // bare number
    "p-", // dangling dash
    "bg-slate-901", // bad shade
    "text-3xl", // size not in the pinned slot list
    "w--4", // negative-ish garbage
    "p-[4rem]", // unsupported arbitrary unit
    "justify-evenly", // not in the v1 enum
    "focus:", // empty variant body
    "sm:p-2", // responsive variants unsupported
    "", // empty string
    "   ", // whitespace only
  ];
  for (const lit of rejected) {
    test(`rejects ${JSON.stringify(lit)}`, () => {
      expect(parseClassLiteral(lit)).toBeNull();
    });
  }
});

describe("compileClasses", () => {
  test("assigns ids, dedupes identical records, encodes styles.bin", () => {
    const c = compileClasses([
      "p-2 bg-white",
      "Press Circle", // ignored
      "bg-white p-2", // same record as the first -> same id
      "p-4",
    ]);
    expect(c.records.length).toBe(2);
    expect(c.ids["p-2 bg-white"]).toBe(c.ids["bg-white p-2"]);
    expect(c.ids["p-4"]).not.toBe(c.ids["p-2 bg-white"]);
    expect("Press Circle" in c.ids).toBeFalse();

    const decoded = decodeStyleTable(c.bin);
    expect(decoded.styles.length).toBe(2);
    const m = new Map(decoded.styles[c.ids["p-4"]].base!.map((p) => [p.prop, p.value]));
    expect(bitsF32(m.get(PROP.paddingT)!)).toBe(16);
  });
  test("always includes the default font slot", () => {
    const c = compileClasses(["p-2"]);
    expect(c.usedFontSlots).toContain(DEFAULT_FONT_SLOT);
  });
  test("used font slots follow the records", () => {
    const c = compileClasses(["text-2xl font-bold"]);
    expect(c.usedFontSlots).toContain(fontSlotFor(24, true));
  });
  test("f32 payloads round-trip exactly", () => {
    const c = compileClasses(["opacity-50"]);
    const rec = c.records[c.ids["opacity-50"]];
    expect(rec.base![0].value).toBe(f32Bits(0.5));
  });
});

describe("3D + arc utilities", () => {
  test("perspective-[N] and 3D rotations parse (arbitrary, signed)", () => {
    const m = props(parseClassLiteral("perspective-[380] rotate-x-[-40] rotate-y-[90] translate-z-[-12]"));
    expect(bitsF32(m.get(PROP.perspective)!)).toBe(380);
    expect(bitsF32(m.get(PROP.rotateX)!)).toBe(-40);
    expect(bitsF32(m.get(PROP.rotateY)!)).toBe(90);
    expect(bitsF32(m.get(PROP.translateZ)!)).toBe(-12);
  });
  test("arc utilities parse", () => {
    const m = props(parseClassLiteral("arc-start-[45] arc-sweep-[-315] arc-width-[5]"));
    expect(bitsF32(m.get(PROP.arcStart)!)).toBe(45);
    expect(bitsF32(m.get(PROP.arcSweep)!)).toBe(-315);
    expect(bitsF32(m.get(PROP.arcWidth)!)).toBe(5);
  });
  test("skew-x-[deg] parses and keyframes bake skewX()", () => {
    const m = props(parseClassLiteral("skew-x-[-12]"));
    expect(bitsF32(m.get(PROP.skewX)!)).toBe(-12);
    registerAnimationTheme({
      keyframes: { lean: { from: { transform: "skewX(0deg)" }, to: { transform: "skewX(14deg) scaleY(0.9)" } } },
      animation: { lean: "lean 300ms linear" },
    });
    const tl = bakedTimelines()[parseClassLiteral("animate-lean")!.animation!.anims[0]];
    const skew = tl.tracks.find((t) => t.prop === PROP.skewX)!;
    expect(skew.segments[0].to).toBe(f32Bits(14));
    registerAnimationTheme(undefined);
  });
  test("non-arbitrary 3D values reject the literal", () => {
    expect(parseClassLiteral("rotate-x-40")).toBeNull();
    expect(parseClassLiteral("perspective-400")).toBeNull();
  });
  test("keyframes animate rotateY / arcSweep (timeline-only props)", () => {
    registerAnimationTheme({
      keyframes: {
        flip3d: { from: { rotateY: 110, opacity: 0 }, to: { rotateY: 0, opacity: 1 } },
        draw: { from: { arcSweep: 0 }, to: { arcSweep: 315 } },
      },
      animation: { flip3d: "flip3d 1.2s linear", draw: "draw 1s linear" },
    });
    const f = parseClassLiteral("animate-flip3d")!;
    const tlF = bakedTimelines()[f.animation!.anims[0]];
    expect(tlF.tracks.map((t) => t.prop).sort((a, b) => a - b)).toEqual(
      [PROP.opacity, PROP.rotateY].sort((a, b) => a - b),
    );
    const d = parseClassLiteral("animate-draw")!;
    const tlD = bakedTimelines()[d.animation!.anims[0]];
    expect(tlD.tracks[0].prop).toBe(PROP.arcSweep);
    expect(tlD.tracks[0].segments[0].to).toBe(f32Bits(315));
    registerAnimationTheme(undefined);
  });
});

describe("transform origin", () => {
  test("origin-bottom = (0, +0.5) fractions", () => {
    const m = props(parseClassLiteral("origin-bottom"));
    expect(bitsF32(m.get(PROP.originX)!)).toBe(0);
    expect(bitsF32(m.get(PROP.originY)!)).toBe(0.5);
  });
  test("origin-top-left = (-0.5, -0.5)", () => {
    const m = props(parseClassLiteral("origin-top-left"));
    expect(bitsF32(m.get(PROP.originX)!)).toBe(-0.5);
    expect(bitsF32(m.get(PROP.originY)!)).toBe(-0.5);
  });
  test("unknown origin rejects the literal", () => {
    expect(parseClassLiteral("origin-diagonal")).toBeNull();
  });
});

describe("baked keyframe animations", () => {
  test("built-in animate-spin bakes an infinite linear rotate timeline", () => {
    resetAnimationBake();
    const rec = parseClassLiteral("animate-spin");
    expect(rec).not.toBeNull();
    expect(rec!.animation!.anims.length).toBe(1);
    expect(rec!.animation!.loopFrames).toBe(0);
    const tl = bakedTimelines()[rec!.animation!.anims[0]];
    expect(tl.periodFrames).toBe(60);
    expect(tl.iterations).toBe(0); // infinite
    expect(tl.tracks.length).toBe(1);
    expect(tl.tracks[0].prop).toBe(PROP.rotate);
    expect(tl.tracks[0].segments[0].from).toBe(f32Bits(0));
    expect(tl.tracks[0].segments[0].to).toBe(f32Bits(360));
    expect(tl.tracks[0].segments[0].easing).toBe(ENUMS.Easing.Linear);
  });

  test("timelines bake at the declared tick rate", () => {
    try {
      setAnimationTickRate(120);
      const rec = parseClassLiteral("animate-spin");
      const tl = bakedTimelines()[rec!.animation!.anims[0]];
      expect(tl.periodFrames).toBe(120); // 1 s of virtual time is hz frames
      registerAnimationTheme({
        keyframes: { fade: { from: { opacity: 0 }, to: { opacity: 1 } } },
        animation: { fade: { value: "fade 0.5s linear 0.25s", loop: "2s" } },
      });
      const fade = parseClassLiteral("animate-fade")!;
      const ftl = bakedTimelines()[fade.animation!.anims[0]];
      expect(ftl.periodFrames).toBe(60); // 0.5 s
      expect(ftl.delayFrames).toBe(30); // 0.25 s
      expect(fade.animation!.loopFrames).toBe(240); // 2 s
      expect(() => setAnimationTickRate(59.94)).toThrow(/integer from 1 through 240/);
    } finally {
      registerAnimationTheme(undefined);
      setAnimationTickRate(60);
    }
  });

  test("theme keyframes bake per-prop segments with frame-exact stops", () => {
    registerAnimationTheme({
      keyframes: {
        pop: {
          from: { transform: "translateY(40px) scale(0.8)", opacity: 0 },
          "60%": { transform: "translateY(-3px) scale(1.05)", opacity: 1 },
          to: { transform: "translateY(0px) scale(1)", opacity: 1 },
        },
      },
      animation: { pop: "pop 0.5s ease-in-out 0.2s both" },
    });
    const rec = parseClassLiteral("animate-pop");
    expect(rec).not.toBeNull();
    const tl = bakedTimelines()[rec!.animation!.anims[0]];
    expect(tl.delayFrames).toBe(12); // 0.2s
    expect(tl.periodFrames).toBe(30); // 0.5s
    expect(tl.fill).toBe(ANIM_FILL_BACKWARDS | ANIM_FILL_FORWARDS);
    // transform decomposes into translateY + scaleX + scaleY; opacity rides along
    const propsAnimated = tl.tracks.map((t) => t.prop).sort((a, b) => a - b);
    expect(propsAnimated).toEqual(
      [PROP.opacity, PROP.translateY, PROP.scaleX, PROP.scaleY].sort((a, b) => a - b),
    );
    const ty = tl.tracks.find((t) => t.prop === PROP.translateY)!;
    expect(ty.segments.length).toBe(2);
    expect(ty.segments[0].t0).toBe(0);
    expect(ty.segments[0].t1).toBe(18); // 60% of 30
    expect(ty.segments[1].t1).toBe(30);
    // named CSS easings bake to their canonical bezier params
    expect(ty.segments[0].easing).toBe(ENUMS.Easing.CubicBezier);
    expect(ty.segments[0].bezier).toEqual([0.42, 0, 0.58, 1]);
    registerAnimationTheme(undefined);
  });

  test("comma lists + loop bake multiple timeline refs on one record", () => {
    registerAnimationTheme({
      keyframes: {
        "in": { from: { opacity: 0 }, to: { opacity: 1 } },
        "out": { from: { opacity: 1 }, to: { opacity: 0 } },
      },
      animation: { blink: "in 0.3s linear both, out 0.3s linear 1s forwards" },
    });
    const rec = parseClassLiteral("animate-blink animate-loop-[2s]");
    expect(rec).not.toBeNull();
    expect(rec!.animation!.anims.length).toBe(2);
    expect(rec!.animation!.loopFrames).toBe(120);
    const [a, b] = rec!.animation!.anims.map((id) => bakedTimelines()[id]);
    expect(a.delayFrames).toBe(0);
    expect(b.delayFrames).toBe(60);
    expect(b.fill).toBe(ANIM_FILL_FORWARDS);
    registerAnimationTheme(undefined);
  });

  test("direction: reverse bakes flipped segments", () => {
    registerAnimationTheme({
      keyframes: { slide: { from: { translateX: 0 }, "75%": { translateX: 30 }, to: { translateX: 40 } } },
      animation: { slideBack: "slide 1s linear reverse" },
    });
    const rec = parseClassLiteral("animate-slideBack");
    const tl = bakedTimelines()[rec!.animation!.anims[0]];
    const segs = tl.tracks[0].segments;
    expect(segs[0].t0).toBe(0);
    expect(segs[0].t1).toBe(15); // reversed 75%..100% -> 0%..25%
    expect(segs[0].from).toBe(f32Bits(40));
    expect(segs[0].to).toBe(f32Bits(30));
    expect(segs[1].from).toBe(f32Bits(30));
    expect(segs[1].to).toBe(f32Bits(0));
    registerAnimationTheme(undefined);
  });

  test("unknown animation name rejects the literal (prose safety)", () => {
    expect(parseClassLiteral("animate-imagination")).toBeNull();
  });

  test("percentage keyframe values are a hard error (bake-ability rule)", () => {
    registerAnimationTheme({
      keyframes: { bad: { from: { transform: "translateX(-50%)" }, to: { transform: "translateX(0%)" } } },
      animation: { bad: "bad 1s linear" },
    });
    expect(() => parseClassLiteral("animate-bad")).toThrow(/percentages are not bakeable/);
    registerAnimationTheme(undefined);
  });

  test("a prop missing at from/to is a hard error", () => {
    registerAnimationTheme({
      keyframes: { half: { "50%": { opacity: 0.5 }, to: { opacity: 1 }, from: {} } },
      animation: { half: "half 1s linear" },
    });
    expect(() => parseClassLiteral("animate-half")).toThrow(/pinned at BOTH/);
    registerAnimationTheme(undefined);
  });

  test("animate-loop without an animation is a hard error", () => {
    expect(() => parseClassLiteral("animate-loop-[2s]")).toThrow(/needs an `animate-<name>`/);
  });

  test("identical timelines dedupe in the ANIM TABLE", () => {
    registerAnimationTheme({
      keyframes: { fade: { from: { opacity: 0 }, to: { opacity: 1 } } },
      animation: { fadeA: "fade 1s linear", fadeB: "fade 1s linear" },
    });
    const a = parseClassLiteral("animate-fadeA")!;
    const b = parseClassLiteral("animate-fadeB")!;
    expect(a.animation!.anims[0]).toBe(b.animation!.anims[0]);
    registerAnimationTheme(undefined);
  });
});
