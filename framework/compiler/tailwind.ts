// framework/compiler/tailwind.ts — the build-time Tailwind-subset compiler.
//
// A candidate string literal compiles to a style record IFF every
// whitespace-separated token parses as a supported utility [R]; otherwise the
// literal is ignored (it was ordinary text, not a class string). The build
// knows which literals sit in a `class` attribute, so it reports those that
// did not compile: `unknownUtilities` names the tokens at fault.
// The ONE exception: `rounded-full` in an otherwise-valid literal that does
// not pin both `w-N` and `h-N` is a HARD compile error [R] (the radius must
// be build-time bakeable).
//
// Utility set = docs/DESIGN.md "Tailwind subset (v1)" with Tailwind default value
// scales: spacing N = N*4 px (p-2 = 8px), the default color palette, variants
// focus:/active: folded into the same record, transition-*/duration/ease/delay
// folded into the record's transition block, and `w-[123px]` / `w-[123]`
// arbitrary pixel values for every numeric utility.
//
// Output: encodeStyleTable(records) -> styles.bin bytes + the generated TS
// module (STYLE_IDS + font-slot metadata) the renderer imports.

import {
  ENUMS,
  PROP,
  SIZE_FULL,
  TRANSITION_MASK_ALL,
  abgr,
  animBit,
  encodeStyleTable,
  f32Bits,
  type AnimTimeline,
  type PropName,
  type StyleAnimation,
  type StyleProp,
  type StyleRecord,
  type StyleTransition,
} from "../../contracts/spec/spec.ts";
import { bakedTimelines, loopToFrames, resolveAnimation } from "./animation.ts";

// ---------------------------------------------------------------------------
// Font slots (build-assigned, pinned here — bake-font.ts uses the same table)
// ---------------------------------------------------------------------------

/** Legacy baked px sizes, index-aligned with slots 0..6 and 7..13. */
export const FONT_PX = [12, 14, 16, 18, 20, 24, 36] as const;
const LARGE_FONT_PX = 54;
const LARGE_FONT_REGULAR_SLOT = 14;
const LARGE_FONT_BOLD_SLOT = 15;
/** Monospace sizes (`font-mono`; code spans). Regular weight only — a bold
 *  request under font-mono still lands on the mono slot for its size. */
export const MONO_FONT_PX = [12, 14, 16] as const;
const MONO_SLOT_BASE = 16;
const TEXT_SIZE_PX: Record<string, number> = {
  xs: 12, sm: 14, base: 16, lg: 18, xl: 20, "2xl": 24, "4xl": 36, "5xl": 54,
};

/** Slot index for a (px, weight, family) triple: 0..6 regular, 7..13 bold,
 *  14/15 the 54 px pair, 16..18 monospace. */
export function fontSlotFor(px: number, bold: boolean, mono = false): number {
  if (mono) {
    const i = (MONO_FONT_PX as readonly number[]).indexOf(px);
    if (i < 0) throw new Error(`PocketJS tailwind: no monospace font slot for ${px}px`);
    return MONO_SLOT_BASE + i;
  }
  if (px === LARGE_FONT_PX) {
    return bold ? LARGE_FONT_BOLD_SLOT : LARGE_FONT_REGULAR_SLOT;
  }
  const i = (FONT_PX as readonly number[]).indexOf(px);
  if (i < 0) throw new Error(`PocketJS tailwind: no font slot for ${px}px`);
  return bold ? 7 + i : i;
}

/** (px, bold, mono) for a slot index — inverse of fontSlotFor. */
export function fontSlotInfo(slot: number): { px: number; bold: boolean; mono: boolean } {
  if (slot >= MONO_SLOT_BASE) {
    const px = MONO_FONT_PX[slot - MONO_SLOT_BASE];
    if (px === undefined) throw new Error(`PocketJS tailwind: bad font slot ${slot}`);
    return { px, bold: false, mono: true };
  }
  if (slot === LARGE_FONT_REGULAR_SLOT) return { px: LARGE_FONT_PX, bold: false, mono: false };
  if (slot === LARGE_FONT_BOLD_SLOT) return { px: LARGE_FONT_PX, bold: true, mono: false };
  const bold = slot >= 7;
  const px = FONT_PX[bold ? slot - 7 : slot];
  if (px === undefined) throw new Error(`PocketJS tailwind: bad font slot ${slot}`);
  return { px, bold, mono: false };
}

/** Default text style when no text-size/weight utility applies: 16px regular. */
export const DEFAULT_FONT_SLOT = fontSlotFor(16, false);

// ---------------------------------------------------------------------------
// Palette (Tailwind v3 defaults) — families cheap to include, shades 50..950
// ---------------------------------------------------------------------------

// prettier-ignore
const PALETTE: Record<string, number[]> = {
  //        50        100       200       300       400       500       600       700       800       900       950
  slate:   [0xf8fafc, 0xf1f5f9, 0xe2e8f0, 0xcbd5e1, 0x94a3b8, 0x64748b, 0x475569, 0x334155, 0x1e293b, 0x0f172a, 0x020617],
  gray:    [0xf9fafb, 0xf3f4f6, 0xe5e7eb, 0xd1d5db, 0x9ca3af, 0x6b7280, 0x4b5563, 0x374151, 0x1f2937, 0x111827, 0x030712],
  zinc:    [0xfafafa, 0xf4f4f5, 0xe4e4e7, 0xd4d4d8, 0xa1a1aa, 0x71717a, 0x52525b, 0x3f3f46, 0x27272a, 0x18181b, 0x09090b],
  red:     [0xfef2f2, 0xfee2e2, 0xfecaca, 0xfca5a5, 0xf87171, 0xef4444, 0xdc2626, 0xb91c1c, 0x991b1b, 0x7f1d1d, 0x450a0a],
  orange:  [0xfff7ed, 0xffedd5, 0xfed7aa, 0xfdba74, 0xfb923c, 0xf97316, 0xea580c, 0xc2410c, 0x9a3412, 0x7c2d12, 0x431407],
  amber:   [0xfffbeb, 0xfef3c7, 0xfde68a, 0xfcd34d, 0xfbbf24, 0xf59e0b, 0xd97706, 0xb45309, 0x92400e, 0x78350f, 0x451a03],
  yellow:  [0xfefce8, 0xfef9c3, 0xfef08a, 0xfde047, 0xfacc15, 0xeab308, 0xca8a04, 0xa16207, 0x854d0e, 0x713f12, 0x422006],
  green:   [0xf0fdf4, 0xdcfce7, 0xbbf7d0, 0x86efac, 0x4ade80, 0x22c55e, 0x16a34a, 0x15803d, 0x166534, 0x14532d, 0x052e16],
  emerald: [0xecfdf5, 0xd1fae5, 0xa7f3d0, 0x6ee7b7, 0x34d399, 0x10b981, 0x059669, 0x047857, 0x065f46, 0x064e3b, 0x022c22],
  teal:    [0xf0fdfa, 0xccfbf1, 0x99f6e4, 0x5eead4, 0x2dd4bf, 0x14b8a6, 0x0d9488, 0x0f766e, 0x115e59, 0x134e4a, 0x042f2e],
  cyan:    [0xecfeff, 0xcffafe, 0xa5f3fc, 0x67e8f9, 0x22d3ee, 0x06b6d4, 0x0891b2, 0x0e7490, 0x155e75, 0x164e63, 0x083344],
  sky:     [0xf0f9ff, 0xe0f2fe, 0xbae6fd, 0x7dd3fc, 0x38bdf8, 0x0ea5e9, 0x0284c7, 0x0369a1, 0x075985, 0x0c4a6e, 0x082f49],
  blue:    [0xeff6ff, 0xdbeafe, 0xbfdbfe, 0x93c5fd, 0x60a5fa, 0x3b82f6, 0x2563eb, 0x1d4ed8, 0x1e40af, 0x1e3a8a, 0x172554],
  indigo:  [0xeef2ff, 0xe0e7ff, 0xc7d2fe, 0xa5b4fc, 0x818cf8, 0x6366f1, 0x4f46e5, 0x4338ca, 0x3730a3, 0x312e81, 0x1e1b4b],
  violet:  [0xf5f3ff, 0xede9fe, 0xddd6fe, 0xc4b5fd, 0xa78bfa, 0x8b5cf6, 0x7c3aed, 0x6d28d9, 0x5b21b6, 0x4c1d95, 0x2e1065],
  purple:  [0xfaf5ff, 0xf3e8ff, 0xe9d5ff, 0xd8b4fe, 0xc084fc, 0xa855f7, 0x9333ea, 0x7e22ce, 0x6b21a8, 0x581c87, 0x3b0764],
  fuchsia: [0xfdf4ff, 0xfae8ff, 0xf5d0fe, 0xf0abfc, 0xe879f9, 0xd946ef, 0xc026d3, 0xa21caf, 0x86198f, 0x701a75, 0x4a044e],
  pink:    [0xfdf2f8, 0xfce7f3, 0xfbcfe8, 0xf9a8d4, 0xf472b6, 0xec4899, 0xdb2777, 0xbe185d, 0x9d174d, 0x831843, 0x500724],
  rose:    [0xfff1f2, 0xffe4e6, 0xfecdd3, 0xfda4af, 0xfb7185, 0xf43f5e, 0xe11d48, 0xbe123c, 0x9f1239, 0x881337, 0x4c0519],
};
const SHADES = [50, 100, 200, 300, 400, 500, 600, 700, 800, 900, 950];

/** `slate-900` | `white` | `black` | `transparent` -> u32 ABGR, or null. */
export function paletteColor(name: string): number | null {
  if (name === "white") return abgr(255, 255, 255);
  if (name === "black") return abgr(0, 0, 0);
  if (name === "transparent") return abgr(0, 0, 0, 0);
  const dash = name.lastIndexOf("-");
  if (dash <= 0) return null;
  const fam = PALETTE[name.slice(0, dash)];
  const shade = SHADES.indexOf(Number(name.slice(dash + 1)));
  if (!fam || shade < 0) return null;
  const rgb = fam[shade];
  return abgr((rgb >> 16) & 255, (rgb >> 8) & 255, rgb & 255);
}

/** Arbitrary color value: `[#777]` | `[#8899aa]` | `[#8899aaff]` -> ABGR, or null. */
function arbitraryColor(part: string): number | null {
  const m = /^\[#([0-9a-fA-F]{3}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})\]$/.exec(part);
  if (!m) return null;
  let h = m[1];
  if (h.length === 3) h = h.split("").map((c) => c + c).join("");
  const r = parseInt(h.slice(0, 2), 16);
  const g = parseInt(h.slice(2, 4), 16);
  const b = parseInt(h.slice(4, 6), 16);
  const a = h.length === 8 ? parseInt(h.slice(6, 8), 16) : 255;
  return abgr(r, g, b, a);
}

/** Palette name OR arbitrary hex (`bg-[#888]`-style color utilities). */
function colorValue(part: string): number | null {
  return paletteColor(part) ?? arbitraryColor(part);
}

/** Bare hex inside a comma list: `#fff` | `#8899aa` | `#8899aaff` -> ABGR. */
function bareHexColor(part: string): number | null {
  return arbitraryColor(`[${part}]`);
}

// ---------------------------------------------------------------------------
// Token parser
// ---------------------------------------------------------------------------

/** Spacing-scale token part: `2` -> 8 (N*4 px), `[123px]`/`[123]` -> 123.
 *  Arbitrary values may be negative (`top-[-10px]`), scale steps may not. */
function spacing(part: string): number | null {
  const arb = /^\[(-?\d+(?:\.\d+)?)(?:px)?\]$/.exec(part);
  if (arb) return parseFloat(arb[1]);
  if (/^\d+(?:\.\d+)?$/.test(part)) return parseFloat(part) * 4;
  return null;
}

/** Plain non-negative number token part (opacity-50, z-10, duration-150...). */
function plainNum(part: string): number | null {
  return /^\d+(?:\.\d+)?$/.test(part) ? parseFloat(part) : null;
}

const px = (n: number): number => f32Bits(n);
const int = (n: number): number => n >>> 0;

type Decl = readonly [number, number]; // [propId, u32 value]

/** Per-variant parse accumulator (pseudo-utilities resolved at literal level). */
interface VariantAcc {
  mono?: boolean;
  decls: Decl[];
  sizePx?: number;
  bold?: boolean;
  trackingWide?: boolean;
  roundedFull?: boolean;
  pinnedW?: number;
  pinnedH?: number;
  sawBevel?: boolean;
  sawRounded?: boolean;
}

interface TransitionAcc {
  mask?: number;
  durMs?: number;
  delayMs?: number;
  easing?: number;
}

const maskOf = (props: PropName[]): number => {
  let m = 0;
  for (const p of props) {
    const bit = animBit(p);
    if (bit < 0) throw new Error(`PocketJS tailwind: ${p} not animatable`);
    m |= 1 << bit;
  }
  return m >>> 0;
};
const COLOR_MASK = maskOf(["bgColor", "gradFrom", "gradTo", "borderColor", "textColor"]);
const OPACITY_MASK = maskOf(["opacity"]);
const TRANSFORM_MASK = maskOf(["translateX", "translateY", "scale", "rotate", "scaleX", "scaleY"]);
/** Plain `transition` (Tailwind's default property set, minus what we can't animate). */
const DEFAULT_MASK = (COLOR_MASK | OPACITY_MASK | TRANSFORM_MASK) >>> 0;

const JUSTIFY: Record<string, number> = {
  start: ENUMS.Justify.Start, center: ENUMS.Justify.Center, end: ENUMS.Justify.End,
  between: ENUMS.Justify.Between, around: ENUMS.Justify.Around,
};
const ITEMS: Record<string, number> = {
  start: ENUMS.Align.Start, center: ENUMS.Align.Center,
  end: ENUMS.Align.End, stretch: ENUMS.Align.Stretch,
};
const ROUNDED: Record<string, number> = { sm: 2, md: 6, lg: 8, xl: 12 };
const SHADOWS: Record<string, number> = { shadow: 1, "shadow-md": 2, "shadow-lg": 3 };
const GRAD_DIR: Record<string, number> = {
  t: ENUMS.GradDir.ToTop, b: ENUMS.GradDir.ToBottom,
  l: ENUMS.GradDir.ToLeft, r: ENUMS.GradDir.ToRight,
};
const EASE: Record<string, number> = {
  linear: ENUMS.Easing.Linear, in: ENUMS.Easing.EaseIn, out: ENUMS.Easing.EaseOut,
  "in-out": ENUMS.Easing.EaseInOut, spring: ENUMS.Easing.Spring, "out-back": ENUMS.Easing.OutBack,
};
const TEXT_ALIGN: Record<string, number> = {
  left: ENUMS.TextAlign.Left, center: ENUMS.TextAlign.Center, right: ENUMS.TextAlign.Right,
};
/** `origin-*` -> transform-origin as (x, y) fractions from the node center. */
const ORIGINS: Record<string, [number, number]> = {
  center: [0, 0],
  top: [0, -0.5], bottom: [0, 0.5], left: [-0.5, 0], right: [0.5, 0],
  "top-left": [-0.5, -0.5], "top-right": [0.5, -0.5],
  "bottom-left": [-0.5, 0.5], "bottom-right": [0.5, 0.5],
};

/** Spacing-family prefixes -> prop ids (a single value may fan out to 2/4 props). */
const SPACING_PROPS: Record<string, number[]> = {
  gap: [PROP.gap], basis: [PROP.basis],
  p: [PROP.paddingT, PROP.paddingR, PROP.paddingB, PROP.paddingL],
  px: [PROP.paddingR, PROP.paddingL], py: [PROP.paddingT, PROP.paddingB],
  pt: [PROP.paddingT], pr: [PROP.paddingR], pb: [PROP.paddingB], pl: [PROP.paddingL],
  m: [PROP.marginT, PROP.marginR, PROP.marginB, PROP.marginL],
  mx: [PROP.marginR, PROP.marginL], my: [PROP.marginT, PROP.marginB],
  mt: [PROP.marginT], mr: [PROP.marginR], mb: [PROP.marginB], ml: [PROP.marginL],
  inset: [PROP.insetT, PROP.insetR, PROP.insetB, PROP.insetL],
  top: [PROP.insetT], right: [PROP.insetR], bottom: [PROP.insetB], left: [PROP.insetL],
  "min-w": [PROP.minW], "min-h": [PROP.minH], "max-w": [PROP.maxW], "max-h": [PROP.maxH],
  "translate-x": [PROP.translateX], "translate-y": [PROP.translateY],
};
const SCALE_PROPS: Record<string, number> = {
  "scale-x": PROP.scaleX,
  "scale-y": PROP.scaleY,
};
/** Arbitrary-only f32 utilities (3D transforms + the arc primitive). */
const ARBITRARY_F32_PROPS: Record<string, number> = {
  "rotate-x": PROP.rotateX,
  "rotate-y": PROP.rotateY,
  "translate-z": PROP.translateZ,
  "arc-start": PROP.arcStart,
  "arc-sweep": PROP.arcSweep,
  "arc-width": PROP.arcWidth,
  "skew-x": PROP.skewX,
};

/**
 * Parse ONE utility token (variant prefix already stripped) into the
 * accumulator. Returns false when the token is not a supported utility.
 */
function parseUtility(tok: string, acc: VariantAcc): boolean {
  const D = acc.decls;

  // -- fixed keywords ---------------------------------------------------------
  switch (tok) {
    case "flex": D.push([PROP.display, int(ENUMS.Display.Flex)]); return true;
    case "flex-row": D.push([PROP.flexDir, int(ENUMS.FlexDir.Row)]); return true;
    case "flex-col": D.push([PROP.flexDir, int(ENUMS.FlexDir.Col)]); return true;
    case "flex-wrap": D.push([PROP.flexWrap, int(1)]); return true;
    case "flex-1":
      D.push([PROP.grow, px(1)], [PROP.shrink, px(1)], [PROP.basis, px(0)]);
      return true;
    case "grow": D.push([PROP.grow, px(1)]); return true;
    case "grow-0": D.push([PROP.grow, px(0)]); return true;
    case "shrink-0": D.push([PROP.shrink, px(0)]); return true;
    case "absolute": D.push([PROP.posType, int(ENUMS.PosType.Absolute)]); return true;
    case "relative": D.push([PROP.posType, int(ENUMS.PosType.Relative)]); return true;
    case "hidden": D.push([PROP.display, int(ENUMS.Display.None)]); return true;
    case "overflow-hidden": D.push([PROP.overflow, int(ENUMS.Overflow.Hidden)]); return true;
    case "w-full": D.push([PROP.width, px(SIZE_FULL)]); return true;
    case "h-full": D.push([PROP.height, px(SIZE_FULL)]); return true;
    case "rounded": D.push([PROP.radius, px(4)]); acc.sawRounded = true; return true;
    case "rounded-full": acc.roundedFull = true; acc.sawRounded = true; return true;
    case "border": D.push([PROP.borderWidth, px(1)]); return true;
    case "font-bold": acc.bold = true; return true;
    case "font-mono": acc.mono = true; return true;
    case "tracking-wide": acc.trackingWide = true; return true;
  }
  if (tok in SHADOWS) { D.push([PROP.shadow, int(SHADOWS[tok])]); return true; }

  // -- prefix-value utilities ---------------------------------------------------
  const dash = tok.indexOf("-");
  if (dash <= 0) return false;

  // longest-prefix match over the spacing family (min-w-4, translate-x-[10px]...)
  for (const prefix of Object.keys(SPACING_PROPS)) {
    if (tok.startsWith(prefix + "-")) {
      const v = spacing(tok.slice(prefix.length + 1));
      if (v === null) continue;
      for (const p of SPACING_PROPS[prefix]) D.push([p, px(v)]);
      return true;
    }
  }
  for (const prefix of Object.keys(SCALE_PROPS)) {
    if (tok.startsWith(prefix + "-")) {
      const v = plainNum(tok.slice(prefix.length + 1));
      if (v === null) continue;
      D.push([SCALE_PROPS[prefix], px(v / 100)]);
      return true;
    }
  }
  // 3D rotations / arc utilities: arbitrary (possibly negative) values only —
  // `rotate-x-[N]`, `rotate-y-[N]`, `translate-z-[N]`, `arc-start-[N]`,
  // `arc-sweep-[N]`, `arc-width-[N]`. Checked before the head switch so
  // `rotate-x-…` never falls into the 2D `rotate-N` case.
  for (const prefix of Object.keys(ARBITRARY_F32_PROPS)) {
    if (tok.startsWith(prefix + "-[")) {
      const v = spacing(tok.slice(prefix.length + 1));
      if (v === null) return false;
      D.push([ARBITRARY_F32_PROPS[prefix], px(v)]);
      return true;
    }
  }

  const head = tok.slice(0, dash);
  const rest = tok.slice(dash + 1);

  switch (head) {
    case "w": case "h": {
      const v = spacing(rest);
      if (v === null) return false;
      D.push([head === "w" ? PROP.width : PROP.height, px(v)]);
      if (head === "w") acc.pinnedW = v; else acc.pinnedH = v;
      return true;
    }
    case "justify":
      if (!(rest in JUSTIFY)) return false;
      D.push([PROP.justify, int(JUSTIFY[rest])]);
      return true;
    case "items":
      if (!(rest in ITEMS)) return false;
      D.push([PROP.align, int(ITEMS[rest])]);
      return true;
    case "z": {
      const v = plainNum(rest);
      if (v === null) return false;
      D.push([PROP.zIndex, int(v)]);
      return true;
    }
    case "bg": {
      const grad = /^gradient-to-([tblr])$/.exec(rest);
      if (grad) { D.push([PROP.gradDir, int(GRAD_DIR[grad[1]])]); return true; }
      const c = colorValue(rest);
      if (c === null) return false;
      D.push([PROP.bgColor, c]);
      return true;
    }
    case "from": case "via": case "to": {
      const c = colorValue(rest);
      if (c === null) return false;
      if (head === "from") D.push([PROP.gradFrom, c]);
      else if (head === "via") {
        D.push([PROP.gradVia, c], [PROP.gradViaPos, px(0.5)]);
      } else D.push([PROP.gradTo, c]);
      return true;
    }
    case "rounded": {
      if (rest in ROUNDED) {
        D.push([PROP.radius, px(ROUNDED[rest])]);
        acc.sawRounded = true;
        return true;
      }
      const v = spacing(rest);
      if (v !== null && rest.startsWith("[")) {
        D.push([PROP.radius, px(v)]);
        acc.sawRounded = true;
        return true;
      }
      return false;
    }
    case "bevel": {
      // Classic-chrome bevel rings (spec.ts PROP.bevelOuter*..bevelWidth):
      // `bevel-[#light,#dark]` sets the outer ring, `bevel-[#a,#b,#c,#d]`
      // both rings (order: outerLight,outerDark,innerLight,innerDark), and
      // `bevel-w-[N]` the per-ring width (arbitrary-only, default 1px).
      // Square-only: combining with rounded* is a hard literal-level error.
      if (rest.startsWith("w-")) {
        const w = spacing(rest.slice(2));
        if (w === null || !rest.startsWith("w-[") || w <= 0) return false;
        D.push([PROP.bevelWidth, px(w)]);
        acc.sawBevel = true;
        return true;
      }
      const m = /^\[(.+)\]$/.exec(rest);
      if (!m) return false;
      const parts = m[1].split(",");
      if (parts.length !== 2 && parts.length !== 4) return false;
      const ringProps = [
        PROP.bevelOuterLight, PROP.bevelOuterDark,
        PROP.bevelInnerLight, PROP.bevelInnerDark,
      ];
      const decls: Decl[] = [];
      for (let i = 0; i < parts.length; i++) {
        const c = bareHexColor(parts[i]);
        if (c === null) return false;
        decls.push([ringProps[i], c]);
      }
      D.push(...decls);
      acc.sawBevel = true;
      return true;
    }
    case "opacity": {
      const v = plainNum(rest);
      if (v === null || v > 100) return false;
      D.push([PROP.opacity, px(v / 100)]);
      return true;
    }
    case "border": {
      // Tailwind width steps (border-2/4/8) + arbitrary `border-[5]`;
      // `border-[#...]` is an arbitrary color, not a width.
      if (rest === "2" || rest === "4" || rest === "8") {
        D.push([PROP.borderWidth, px(parseFloat(rest))]);
        return true;
      }
      if (rest.startsWith("[") && !rest.startsWith("[#")) {
        const w = spacing(rest);
        if (w === null) return false;
        D.push([PROP.borderWidth, px(w)]);
        return true;
      }
      const c = colorValue(rest);
      if (c === null) return false;
      D.push([PROP.borderColor, c], [PROP.borderWidth, px(1)]);
      return true;
    }
    case "text": {
      if (rest in TEXT_ALIGN) { D.push([PROP.textAlign, int(TEXT_ALIGN[rest])]); return true; }
      if (rest in TEXT_SIZE_PX) { acc.sizePx = TEXT_SIZE_PX[rest]; return true; }
      const c = colorValue(rest);
      if (c === null) return false;
      D.push([PROP.textColor, c]);
      return true;
    }
    case "leading": {
      const v = spacing(rest);
      if (v === null) return false;
      D.push([PROP.lineHeight, px(v)]);
      return true;
    }
    case "scale": {
      const v = plainNum(rest);
      if (v === null) return false;
      D.push([PROP.scale, px(v / 100)]);
      return true;
    }
    case "rotate": {
      const v = plainNum(rest);
      if (v === null) return false;
      D.push([PROP.rotate, px(v)]);
      return true;
    }
    case "origin": {
      if (!(rest in ORIGINS)) return false;
      const [ox, oy] = ORIGINS[rest];
      D.push([PROP.originX, px(ox)], [PROP.originY, px(oy)]);
      return true;
    }
    case "perspective": {
      // 3D context root: `perspective-[800]` (px distance).
      const v = spacing(rest);
      if (v === null || !rest.startsWith("[") || v <= 0) return false;
      D.push([PROP.perspective, px(v)]);
      return true;
    }
  }
  return false;
}

/** Literal-level animation accumulator (`animate-*` binds to the base style). */
interface AnimAcc {
  ids: number[];
  loopFrames: number;
}

/**
 * Parse an `animate-*` token. `animate-<name>` bakes the theme animation
 * (comma list) into the ANIM TABLE; `animate-loop-[4s]`/`animate-loop-[4000ms]`
 * sets the whole-choreography loop period (PocketJS extension). Unknown names
 * make the literal a non-class string, like every other utility.
 */
function parseAnimation(tok: string, acc: AnimAcc): boolean {
  if (!tok.startsWith("animate-")) return false;
  const rest = tok.slice("animate-".length);
  const loop = /^loop-\[([\d.]+m?s)\]$/.exec(rest);
  if (loop) {
    acc.loopFrames = loopToFrames(loop[1], `\`${tok}\``);
    return true;
  }
  const resolved = resolveAnimation(rest);
  if (resolved === null) return false;
  acc.ids.push(...resolved.anims);
  if (resolved.loopFrames > 0) acc.loopFrames = resolved.loopFrames;
  return true;
}

/** Parse a motion token into the transition accumulator (base variant only). */
function parseMotion(tok: string, tr: TransitionAcc): boolean {
  switch (tok) {
    case "transition": tr.mask = DEFAULT_MASK; return true;
    case "transition-all": tr.mask = TRANSITION_MASK_ALL; return true;
    case "transition-colors": tr.mask = COLOR_MASK; return true;
    case "transition-opacity": tr.mask = OPACITY_MASK; return true;
    case "transition-transform": tr.mask = TRANSFORM_MASK; return true;
  }
  const dash = tok.indexOf("-");
  if (dash <= 0) return false;
  const head = tok.slice(0, dash);
  const rest = tok.slice(dash + 1);
  if (head === "duration" || head === "delay") {
    const v = plainNum(rest);
    if (v === null || v > 0xffff) return false;
    if (head === "duration") tr.durMs = v; else tr.delayMs = v;
    return true;
  }
  if (head === "ease") {
    if (!(rest in EASE)) return false;
    tr.easing = EASE[rest];
    return true;
  }
  return false;
}

/** Dedupe decls last-wins, then order by prop id (canonical — makes records
 *  from token-reordered literals byte-identical, so they share a styleId). */
function dedupe(decls: Decl[]): StyleProp[] {
  const m = new Map<number, number>();
  for (const [p, v] of decls) m.set(p, v);
  return [...m.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([prop, value]) => ({ prop, value }));
}

/** A token's variant prefix and the utility after it; null when the prefix is no variant or nothing follows it. */
function splitVariant(tok: string): { variant: "base" | "focus" | "active"; body: string; hover: boolean } | null {
  let variant: "base" | "focus" | "active" = "base";
  let body = tok;
  let hover = false;
  const colon = tok.indexOf(":");
  if (colon > 0) {
    const prefix = tok.slice(0, colon);
    if (prefix === "focus" || prefix === "active") variant = prefix;
    else if (prefix === "hover") hover = true;
    else return null;
    body = tok.slice(colon + 1);
  }
  return body.length === 0 ? null : { variant, body, hover };
}

/**
 * The tokens of `literal` that are not supported utilities, in source order.
 * Empty for a literal every token of which parses. A token one of the loud
 * rules rejects (`hover:`, a malformed `animate-loop-[..]`) is a known
 * utility: `parseClassLiteral` reports it with its own message.
 */
export function unknownUtilities(literal: string): string[] {
  const unknown: string[] = [];
  for (const tok of literal.trim().split(/\s+/).filter((t) => t.length > 0)) {
    const split = splitVariant(tok);
    let known = false;
    if (split !== null) {
      try {
        known =
          (split.variant === "base" && (parseMotion(split.body, {}) || parseAnimation(split.body, { ids: [], loopFrames: 0 }))) ||
          parseUtility(split.body, { decls: [] });
      } catch {
        known = true;
      }
    }
    if (!known) unknown.push(tok);
  }
  return unknown;
}

/** A token that has the shape of a utility: lower case words joined by hyphens, an optional variant, an optional bracket value. */
const UTILITY_SHAPE = /^(?:(?:focus|active|hover):)?-?[a-z][a-z0-9]*(?:-(?:[a-z0-9.%/]+|\[[^\]\s]+\]))*$/;

/**
 * For a literal that is NOT in a `class` attribute and did not compile: the
 * unsupported tokens when the literal still reads as a class string with a
 * mistake in it, else null. It reads as one when it has at least two tokens,
 * every token has the shape of a utility, and more of them are supported
 * than not. A sentence, a file name or a single word never qualifies.
 */
export function suspectClassLiteral(literal: string): string[] | null {
  const tokens = literal.trim().split(/\s+/).filter((t) => t.length > 0);
  if (tokens.length < 2 || !tokens.every((tok) => UTILITY_SHAPE.test(tok))) return null;
  const unknown = unknownUtilities(literal);
  return unknown.length > 0 && tokens.length - unknown.length > unknown.length ? unknown : null;
}

/**
 * Parse one candidate class literal.
 * Returns the StyleRecord, or null when the literal is NOT a class string
 * (any unsupported token). Throws only for the `rounded-full` [R] rule (and
 * `hover:`, which DESIGN pins as a loud error) in otherwise-valid literals.
 */
export function parseClassLiteral(literal: string): StyleRecord | null {
  const tokens = literal.trim().split(/\s+/).filter((t) => t.length > 0);
  if (tokens.length === 0) return null;

  const acc: Record<"base" | "focus" | "active", VariantAcc> = {
    base: { decls: [] }, focus: { decls: [] }, active: { decls: [] },
  };
  const tr: TransitionAcc = {};
  const anim: AnimAcc = { ids: [], loopFrames: 0 };
  let sawMotion = false;
  let sawHover = false;

  for (const tok of tokens) {
    const split = splitVariant(tok);
    if (split === null) return null; // not a utility (arbitrary text with a colon)
    const { variant, body } = split;
    if (split.hover) sawHover = true; // decided after the rest of the literal parses
    if (variant === "base" && parseMotion(body, tr)) { sawMotion = true; continue; }
    if (variant === "base" && parseAnimation(body, anim)) continue;
    if (!parseUtility(body, acc[variant])) return null;
  }

  // Every token parsed => this IS a class literal; unsupported-by-design
  // pieces now error loudly instead of silently dropping [R].
  if (sawHover) {
    throw new Error(
      `PocketJS tailwind: \`hover:\` is not supported on PSP (no pointer) in "${literal}" — use focus:/active:.`,
    );
  }
  {
    const variants = [acc.base, acc.focus, acc.active];
    const sawBevel = variants.some((v) => v.sawBevel);
    const sawRounded = variants.some((v) => v.sawRounded);
    if (sawBevel && sawRounded) {
      throw new Error(
        `PocketJS tailwind: \`bevel-*\` is square-only and cannot combine with \`rounded*\` ` +
          `in "${literal}" — drop one of them.`,
      );
    }
  }

  // resolve pseudo-utilities per variant (font slot / tracking / rounded-full)
  const base = acc.base;
  for (const name of ["base", "focus", "active"] as const) {
    const v = acc[name];
    const effPx = v.sizePx ?? base.sizePx ?? 16;
    const effBold = v.bold ?? base.bold ?? false;
    const effMono = v.mono ?? base.mono ?? false;
    if (v.sizePx !== undefined || v.bold !== undefined || v.mono !== undefined) {
      v.decls.push([PROP.fontSlot, int(fontSlotFor(effPx, effBold, effMono))]);
    }
    if (v.trackingWide) {
      v.decls.push([PROP.tracking, px(0.025 * effPx)]); // Tailwind tracking-wide = 0.025em
    }
    if (v.roundedFull) {
      const w = v.pinnedW ?? base.pinnedW;
      const h = v.pinnedH ?? base.pinnedH;
      if (w === undefined || h === undefined) {
        throw new Error(
          `PocketJS tailwind: \`rounded-full\` needs build-time known size — add w-N and h-N ` +
            `to the same literal (got "${literal}").`,
        );
      }
      v.decls.push([PROP.radius, px(Math.min(w, h) / 2)]);
    }
  }

  const rec: StyleRecord = {};
  const baseProps = dedupe(acc.base.decls);
  if (baseProps.length > 0) rec.base = baseProps;
  const focusProps = dedupe(acc.focus.decls);
  if (focusProps.length > 0) rec.focus = focusProps;
  const activeProps = dedupe(acc.active.decls);
  if (activeProps.length > 0) rec.active = activeProps;
  if (sawMotion) {
    rec.transition = {
      // A duration/ease/delay-only literal (no transition-property utility)
      // matches CSS's initial `transition-property: all` — DEFAULT_MASK is
      // only the `transition` shorthand's property list.
      mask: tr.mask ?? TRANSITION_MASK_ALL,
      durMs: tr.durMs ?? 150, // Tailwind default duration
      delayMs: tr.delayMs ?? 0,
      easing: tr.easing ?? ENUMS.Easing.EaseInOut,
    } satisfies StyleTransition;
  }
  if (anim.loopFrames > 0 && anim.ids.length === 0) {
    throw new Error(
      `PocketJS tailwind: \`animate-loop-[..]\` needs an \`animate-<name>\` in the same literal ("${literal}").`,
    );
  }
  if (anim.ids.length > 0) {
    rec.animation = { anims: anim.ids, loopFrames: anim.loopFrames } satisfies StyleAnimation;
  }
  if (!rec.base && !rec.focus && !rec.active && !rec.transition && !rec.animation) return null;
  return rec;
}

// ---------------------------------------------------------------------------
// Table compiler
// ---------------------------------------------------------------------------

export interface CompiledStyles {
  /** styleId = index into this list (styles.bin record order). */
  records: StyleRecord[];
  /** Baked keyframe timelines (styles.bin ANIM TABLE; records reference indices). */
  anims: AnimTimeline[];
  /** Raw class literal (as written in source) -> styleId. */
  ids: Record<string, number>;
  /** styles.bin bytes (encodeStyleTable). */
  bin: Uint8Array;
  /** Font slots referenced by any record (always includes DEFAULT_FONT_SLOT). */
  usedFontSlots: number[];
}

/** Compile candidate literals: keep the ones that parse, dedupe identical records. */
export function compileClasses(literals: Iterable<string>): CompiledStyles {
  const records: StyleRecord[] = [];
  const ids: Record<string, number> = {};
  const byCanon = new Map<string, number>();
  const slots = new Set<number>([DEFAULT_FONT_SLOT]);

  for (const lit of literals) {
    if (lit in ids) continue;
    const rec = parseClassLiteral(lit);
    if (rec === null) continue;
    const canon = JSON.stringify(rec);
    let id = byCanon.get(canon);
    if (id === undefined) {
      id = records.length;
      records.push(rec);
      byCanon.set(canon, id);
    }
    ids[lit] = id;
    for (const v of [rec.base, rec.focus, rec.active]) {
      if (!v) continue;
      for (const p of v) if (p.prop === PROP.fontSlot) slots.add(p.value);
    }
  }

  const anims = bakedTimelines();
  return {
    records,
    anims,
    ids,
    bin: encodeStyleTable(records, anims),
    usedFontSlots: [...slots].sort((a, b) => a - b),
  };
}

/** The generated `styles.generated.ts` module source. */
export function generateStylesModule(c: CompiledStyles): string {
  const L: string[] = [];
  L.push("// AUTO-GENERATED by PocketJS framework/compiler/tailwind.ts — DO NOT EDIT.");
  L.push("// Regenerated by every `bun tools/build.ts <app>` run; excluded from");
  L.push("// the pass-1 class/charset scan. Keys are class literals EXACTLY as");
  L.push("// written in source (the renderer looks class attrs up verbatim).");
  L.push("");
  L.push("/** class literal -> styleId (record index in ui:styles / styles.bin). */");
  L.push("export const STYLE_IDS: Record<string, number> = {");
  for (const [lit, id] of Object.entries(c.ids)) {
    L.push(`  ${JSON.stringify(lit)}: ${id},`);
  }
  L.push("};");
  L.push("");
  L.push("/** Number of records in styles.bin (valid styleIds are 0..COUNT-1). */");
  L.push(`export const STYLE_COUNT = ${c.records.length};`);
  L.push("");
  L.push("/** Baked font-atlas slots shipped in the pak: slot -> metrics. */");
  L.push("export const FONT_SLOTS: Record<number, { px: number; bold: boolean }> = {");
  for (const slot of c.usedFontSlots) {
    const { px, bold } = fontSlotInfo(slot);
    L.push(`  ${slot}: { px: ${px}, bold: ${bold} },`);
  }
  L.push("};");
  L.push("");
  L.push("/** Slot for text with no text-size/font-weight utility (16px regular). */");
  L.push(`export const DEFAULT_FONT_SLOT = ${DEFAULT_FONT_SLOT};`);
  L.push("");
  return L.join("\n");
}
