// framework/compiler/animation.ts — the build-time keyframe-animation baker.
//
// Tailwind-config-shaped input (`theme.keyframes` + `theme.animation`, same
// authoring surface as tailwind.config.js) compiles into the styles.bin ANIM
// TABLE (spec.ts): each CSS `animation` shorthand entry becomes per-prop
// SEGMENT lists with frame-precise endpoints at the realm's declared tick
// rate (default 60 Hz; tools/build.ts --hz declares another and the core
// plays one segment frame per tick, so the table must bake at the same rate
// the realm runs). The core never interprets percentages, calc() or easing
// strings at runtime — a timeline is pure data ("prop P: bits A -> bits B
// over frames [t0,t1) under easing E"), which is what keeps playback
// deterministic and byte-exact.
//
// Bake-ability rules ([R], same spirit as `rounded-full`):
//   - keyframe values must be build-time absolute: px numbers, degrees,
//     colors, unitless scalars. Percentages / calc() / var() are hard errors.
//   - every animated prop must be pinned at the first AND last keyframe of
//     its animation (CSS would fall back to the un-knowable computed style).
//
// Supported shorthand grammar (CSS `animation` subset, comma list):
//   <name> <duration> [<easing>] [<delay>] [<iterations>] [<direction>] [<fill>]
//   easing: linear | ease | ease-in | ease-out | ease-in-out |
//           cubic-bezier(x1, y1, x2, y2)      (named ones bake to their
//           canonical CSS bezier params, NOT the core's polynomial ordinals,
//           so keyframe playback matches the browser curve exactly)
//   direction: normal | reverse   (reverse bakes flipped segments)
//   fill: none | forwards | backwards | both
//   iterations: infinite | <n>

import {
  ANIMATABLE,
  ANIM_FILL_BACKWARDS,
  ANIM_FILL_FORWARDS,
  ENUMS,
  PROP,
  abgr,
  f32Bits,
  type AnimSegment,
  type AnimTimeline,
  type AnimTrack,
} from "../../contracts/spec/spec.ts";
import { paletteColor } from "./tailwind.ts";

// ---------------------------------------------------------------------------
// Theme types (mirrors tailwind.config.js `theme.keyframes` / `theme.animation`)
// ---------------------------------------------------------------------------

/** One keyframe's declarations, CSS-in-JS style (`{ opacity: 0.5, transform: "rotate(45deg)" }`). */
export type KeyframeProps = Record<string, string | number>;
/** Selector -> declarations. Selectors: `from`, `to`, `50%`, comma lists (`"from,to"`, `"30%,70%"`). */
export type Keyframes = Record<string, KeyframeProps>;

export interface AnimationTheme {
  keyframes?: Record<string, Keyframes>;
  /** Name -> CSS `animation` shorthand (comma list ok). The object form adds
   *  `loop`: a whole-choreography loop period (PocketJS extension — restarts
   *  the full comma list, delays included, every N ms). */
  animation?: Record<string, string | { value: string; loop?: string | number }>;
}

// ---------------------------------------------------------------------------
// Tailwind built-ins (tailwindcss defaultTheme; bounce's translate-25% is not
// bakeable, so it pins the -25%-of-1.5rem default = -6px)
// ---------------------------------------------------------------------------

const BUILTIN_KEYFRAMES: Record<string, Keyframes> = {
  spin: { from: { transform: "rotate(0deg)" }, to: { transform: "rotate(360deg)" } },
  ping: { "0%": { transform: "scale(1)", opacity: 1 }, "75%,100%": { transform: "scale(2)", opacity: 0 } },
  pulse: { "0%,100%": { opacity: 1 }, "50%": { opacity: 0.5 } },
  bounce: {
    "0%,100%": { transform: "translateY(-6px)" },
    "50%": { transform: "translateY(0px)" },
  },
};

const BUILTIN_ANIMATION: Record<string, string> = {
  spin: "spin 1s linear infinite",
  ping: "ping 1s cubic-bezier(0, 0, 0.2, 1) infinite",
  pulse: "pulse 2s cubic-bezier(0.4, 0, 0.6, 1) infinite",
  bounce: "bounce 1s ease-in-out infinite",
};

// ---------------------------------------------------------------------------
// Registry + bake table
// ---------------------------------------------------------------------------

let themeKeyframes: Record<string, Keyframes> = { ...BUILTIN_KEYFRAMES };
let themeAnimation: Record<string, string | { value: string; loop?: string | number }> = {
  ...BUILTIN_ANIMATION,
};

/** Baked timelines, appended in first-use order; styles reference indices. */
let baked: AnimTimeline[] = [];
const bakedIds = new Map<string, number>();
/** animate-<name> -> { anims, loopFrames } memo (bakes on first use). */
const resolved = new Map<string, { anims: number[]; loopFrames: number } | null>();

/** Install the app's `theme` (build.ts calls this before compileClasses). */
export function registerAnimationTheme(theme: AnimationTheme | undefined): void {
  themeKeyframes = { ...BUILTIN_KEYFRAMES, ...(theme?.keyframes ?? {}) };
  themeAnimation = { ...BUILTIN_ANIMATION, ...(theme?.animation ?? {}) };
  resetAnimationBake();
}

/** The tick rate timelines bake at — one segment frame is one core tick. */
let bakeHz = 60;

/** Declare the realm's tick rate before compileClasses (build.ts passes its
 *  --hz value). Timelines already baked at another rate are dropped: a table
 *  can only ever hold frames counted at one rate. */
export function setAnimationTickRate(hz: number): void {
  if (!Number.isInteger(hz) || hz < 1 || hz > 240) {
    err(`tick rate must be an integer from 1 through 240, got ${hz}`);
  }
  if (hz !== bakeHz) {
    bakeHz = hz;
    resetAnimationBake();
  }
}

/** Drop all baked state (tests / fresh compile passes). */
export function resetAnimationBake(): void {
  baked = [];
  bakedIds.clear();
  resolved.clear();
}

/** Compile one style table without inheriting or changing another build's ids. */
export function withIsolatedAnimationBake<T>(compile: () => T): T {
  const previousBaked = baked;
  const previousIds = new Map(bakedIds);
  const previousResolved = new Map(resolved);
  resetAnimationBake();
  try {
    return compile();
  } finally {
    baked = previousBaked;
    bakedIds.clear();
    for (const [key, value] of previousIds) bakedIds.set(key, value);
    resolved.clear();
    for (const [key, value] of previousResolved) resolved.set(key, value);
  }
}

/** The ANIM TABLE for encodeStyleTable (snapshot; do not mutate). */
export function bakedTimelines(): AnimTimeline[] {
  return baked;
}

// ---------------------------------------------------------------------------
// Value parsing
// ---------------------------------------------------------------------------

function err(msg: string): never {
  throw new Error(`PocketJS animation: ${msg}`);
}

function rejectUnbakeable(value: string, where: string): void {
  if (/calc\(|var\(/.test(value)) err(`${where}: \`${value}\` — calc()/var() is not build-time bakeable; write the resolved value.`);
  if (/%/.test(value)) err(`${where}: \`${value}\` — percentages are not bakeable (the core has no reference box at runtime); write px.`);
}

/** `0.6s` | `250ms` | `.5s` -> ms. */
function parseTime(tok: string): number | null {
  const m = /^(-?\d*\.?\d+)(ms|s)$/.exec(tok);
  if (!m) return null;
  const v = parseFloat(m[1]);
  return m[2] === "s" ? v * 1000 : v;
}

/** ms -> whole frames at the declared tick rate (round-half-up, min 0). */
export function msToFrames(ms: number): number {
  return Math.max(0, Math.round((ms * bakeHz) / 1000));
}

/** px-dimension value: number | "12px" | "12" | "0". */
function parsePx(value: string | number, where: string): number {
  if (typeof value === "number") return value;
  const v = value.trim();
  rejectUnbakeable(v, where);
  const m = /^(-?\d*\.?\d+)(px)?$/.exec(v);
  if (!m) err(`${where}: \`${value}\` is not a px value.`);
  return parseFloat(m[1]);
}

/** unitless scalar (opacity, scale): number | "0.5" | "50%"-for-opacity is rejected. */
function parseScalar(value: string | number, where: string): number {
  if (typeof value === "number") return value;
  const v = value.trim();
  rejectUnbakeable(v, where);
  const n = parseFloat(v);
  if (!/^-?\d*\.?\d+$/.test(v) || Number.isNaN(n)) err(`${where}: \`${value}\` is not a number.`);
  return n;
}

/** `#777` | `#8899aa` | `#8899aaff` | palette name | transparent -> u32 ABGR. */
function parseColor(value: string | number, where: string): number {
  if (typeof value === "number") err(`${where}: colors must be strings.`);
  const v = value.trim();
  const hex = /^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/.exec(v);
  if (hex) {
    let h = hex[1];
    if (h.length === 3) h = h.split("").map((c) => c + c).join("");
    const r = parseInt(h.slice(0, 2), 16);
    const g = parseInt(h.slice(2, 4), 16);
    const b = parseInt(h.slice(4, 6), 16);
    const a = h.length === 8 ? parseInt(h.slice(6, 8), 16) : 255;
    return abgr(r, g, b, a);
  }
  const c = paletteColor(v);
  if (c === null) err(`${where}: unknown color \`${value}\`.`);
  return c;
}

/** deg value: "45deg" | number (degrees). */
function parseDeg(value: string | number, where: string): number {
  if (typeof value === "number") return value;
  const v = value.trim();
  rejectUnbakeable(v, where);
  const m = /^(-?\d*\.?\d+)(deg)?$/.exec(v);
  if (!m) err(`${where}: \`${value}\` is not a degree value.`);
  return parseFloat(m[1]);
}

type Encode = (value: string | number, where: string) => number; // -> u32 bits

const pxBits: Encode = (v, w) => f32Bits(parsePx(v, w));
const scalarBits: Encode = (v, w) => f32Bits(parseScalar(v, w));
const degBits: Encode = (v, w) => f32Bits(parseDeg(v, w));
const colorBits: Encode = (v, w) => parseColor(v, w);

/** Keyframe property -> [prop ids, encoder]. camelCase and kebab-case accepted. */
const KEYFRAME_PROPS: Record<string, [number[], Encode]> = {
  opacity: [[PROP.opacity], scalarBits],
  width: [[PROP.width], pxBits],
  height: [[PROP.height], pxBits],
  top: [[PROP.insetT], pxBits],
  right: [[PROP.insetR], pxBits],
  bottom: [[PROP.insetB], pxBits],
  left: [[PROP.insetL], pxBits],
  inset: [[PROP.insetT, PROP.insetR, PROP.insetB, PROP.insetL], pxBits],
  borderRadius: [[PROP.radius], pxBits],
  backgroundColor: [[PROP.bgColor], colorBits],
  color: [[PROP.textColor], colorBits],
  borderColor: [[PROP.borderColor], colorBits],
  borderWidth: [[PROP.borderWidth], pxBits],
  letterSpacing: [[PROP.tracking], pxBits],
  lineHeight: [[PROP.lineHeight], pxBits],
  gap: [[PROP.gap], pxBits],
  padding: [[PROP.paddingT, PROP.paddingR, PROP.paddingB, PROP.paddingL], pxBits],
  margin: [[PROP.marginT, PROP.marginR, PROP.marginB, PROP.marginL], pxBits],
  translateX: [[PROP.translateX], pxBits],
  translateY: [[PROP.translateY], pxBits],
  rotate: [[PROP.rotate], degBits],
  scale: [[PROP.scale], scalarBits],
  scaleX: [[PROP.scaleX], scalarBits],
  scaleY: [[PROP.scaleY], scalarBits],
  rotateX: [[PROP.rotateX], degBits],
  rotateY: [[PROP.rotateY], degBits],
  translateZ: [[PROP.translateZ], pxBits],
  arcStart: [[PROP.arcStart], degBits],
  arcSweep: [[PROP.arcSweep], degBits],
  arcWidth: [[PROP.arcWidth], pxBits],
};

/** kebab-case -> camelCase (accepts `background-color` next to `backgroundColor`). */
function camel(name: string): string {
  return name.replace(/-([a-z])/g, (_, c: string) => c.toUpperCase());
}

/** Transform-function decomposition: prop id -> f32 value. scale(s) becomes
 *  scaleX+scaleY so mixed scale()/scaleX() keyframes share one prop space. */
function parseTransform(value: string | number, where: string): Map<number, number> {
  if (typeof value === "number") err(`${where}: transform must be a string.`);
  rejectUnbakeable(value, where);
  const out = new Map<number, number>();
  const re = /([a-zA-Z]+)\(([^)]*)\)/g;
  let m: RegExpExecArray | null;
  let matched = 0;
  while ((m = re.exec(value))) {
    matched++;
    const fn = m[1];
    const args = m[2].split(",").map((a) => a.trim());
    const w = `${where} transform ${fn}()`;
    switch (fn) {
      case "translate":
        out.set(PROP.translateX, parsePx(args[0], w));
        out.set(PROP.translateY, args.length > 1 ? parsePx(args[1], w) : 0);
        break;
      case "translateX": out.set(PROP.translateX, parsePx(args[0], w)); break;
      case "translateY": out.set(PROP.translateY, parsePx(args[0], w)); break;
      case "translateZ": out.set(PROP.translateZ, parsePx(args[0], w)); break;
      case "rotate": out.set(PROP.rotate, parseDeg(args[0], w)); break;
      case "rotateX": out.set(PROP.rotateX, parseDeg(args[0], w)); break;
      case "rotateY": out.set(PROP.rotateY, parseDeg(args[0], w)); break;
      case "perspective": break; // context distance is static (perspective-[N] on the root)
      case "scale": {
        const sx = parseScalar(args[0], w);
        const sy = args.length > 1 ? parseScalar(args[1], w) : sx;
        out.set(PROP.scaleX, sx);
        out.set(PROP.scaleY, sy);
        break;
      }
      case "scaleX": out.set(PROP.scaleX, parseScalar(args[0], w)); break;
      case "scaleY": out.set(PROP.scaleY, parseScalar(args[0], w)); break;
      default:
        err(`${w}: unsupported transform function.`);
    }
  }
  if (matched === 0 && value.trim() !== "none") err(`${where}: cannot parse transform \`${value}\`.`);
  return out;
}

const ANIMATABLE_IDS = new Set<number>(ANIMATABLE.map((name) => PROP[name]));

/** Identity value for a transform-decomposed prop (union fill-in). */
const TRANSFORM_IDENTITY = new Map<number, number>([
  [PROP.translateX, 0],
  [PROP.translateY, 0],
  [PROP.translateZ, 0],
  [PROP.rotate, 0],
  [PROP.rotateX, 0],
  [PROP.rotateY, 0],
  [PROP.scaleX, 1],
  [PROP.scaleY, 1],
]);

// ---------------------------------------------------------------------------
// Easing
// ---------------------------------------------------------------------------

interface EasingSpec {
  ordinal: number;
  bezier?: [number, number, number, number];
}

/** Named CSS easings -> canonical bezier params (browser-exact curves). */
const CSS_EASINGS: Record<string, EasingSpec> = {
  linear: { ordinal: ENUMS.Easing.Linear },
  ease: { ordinal: ENUMS.Easing.CubicBezier, bezier: [0.25, 0.1, 0.25, 1] },
  "ease-in": { ordinal: ENUMS.Easing.CubicBezier, bezier: [0.42, 0, 1, 1] },
  "ease-out": { ordinal: ENUMS.Easing.CubicBezier, bezier: [0, 0, 0.58, 1] },
  "ease-in-out": { ordinal: ENUMS.Easing.CubicBezier, bezier: [0.42, 0, 0.58, 1] },
};

function parseEasing(tok: string): EasingSpec | null {
  if (tok in CSS_EASINGS) return CSS_EASINGS[tok];
  const m = /^cubic-bezier\(\s*(-?[\d.]+)\s*,\s*(-?[\d.]+)\s*,\s*(-?[\d.]+)\s*,\s*(-?[\d.]+)\s*\)$/.exec(tok);
  if (m) {
    return {
      ordinal: ENUMS.Easing.CubicBezier,
      bezier: [parseFloat(m[1]), parseFloat(m[2]), parseFloat(m[3]), parseFloat(m[4])],
    };
  }
  return null;
}

/** Time-reverse an easing (for `direction: reverse`). */
function reverseEasing(e: EasingSpec): EasingSpec {
  if (e.bezier) {
    const [x1, y1, x2, y2] = e.bezier;
    return { ordinal: e.ordinal, bezier: [1 - x2, 1 - y2, 1 - x1, 1 - y1] };
  }
  return e; // Linear is symmetric
}

// ---------------------------------------------------------------------------
// Shorthand parsing
// ---------------------------------------------------------------------------

interface ShorthandEntry {
  name: string;
  durMs: number;
  delayMs: number;
  easing: EasingSpec;
  iterations: number; // 0 = infinite
  reverse: boolean;
  fill: number; // ANIM_FILL_* bits
}

/** Split a comma list, but not inside cubic-bezier(...) parens. */
function splitTopLevel(s: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === "(") depth++;
    else if (c === ")") depth--;
    else if (c === "," && depth === 0) {
      out.push(s.slice(start, i));
      start = i + 1;
    }
  }
  out.push(s.slice(start));
  return out.map((p) => p.trim()).filter((p) => p.length > 0);
}

/** Tokenize one shorthand entry, keeping cubic-bezier(...) as one token. */
function tokenize(entry: string): string[] {
  return entry.match(/[a-zA-Z-]+\([^)]*\)|\S+/g) ?? [];
}

function parseShorthand(entry: string, where: string): ShorthandEntry {
  const toks = tokenize(entry);
  let name: string | undefined;
  const times: number[] = [];
  let easing: EasingSpec | undefined;
  let iterations = 1;
  let reverse = false;
  let fill = 0;
  for (const tok of toks) {
    const t = parseTime(tok);
    if (t !== null) { times.push(t); continue; }
    if (tok === "infinite") { iterations = 0; continue; }
    if (/^\d+$/.test(tok)) { iterations = parseInt(tok, 10); continue; }
    if (tok === "normal") continue;
    if (tok === "reverse") { reverse = true; continue; }
    if (tok === "alternate" || tok === "alternate-reverse") {
      err(`${where}: \`${tok}\` is not supported — bake the mirrored keyframes explicitly.`);
    }
    if (tok === "none") continue;
    if (tok === "forwards") { fill |= ANIM_FILL_FORWARDS; continue; }
    if (tok === "backwards") { fill |= ANIM_FILL_BACKWARDS; continue; }
    if (tok === "both") { fill |= ANIM_FILL_FORWARDS | ANIM_FILL_BACKWARDS; continue; }
    const e = parseEasing(tok);
    if (e) { easing = e; continue; }
    if (tok in themeKeyframes && name === undefined) { name = tok; continue; }
    err(`${where}: cannot parse \`${tok}\` in "${entry}" (unknown keyframes name or token).`);
  }
  if (name === undefined) err(`${where}: no keyframes name in "${entry}".`);
  if (times.length === 0) err(`${where}: "${entry}" needs a duration.`);
  if (times.length > 2) err(`${where}: "${entry}" has more than two time values.`);
  return {
    name,
    durMs: times[0],
    delayMs: times[1] ?? 0,
    easing: easing ?? CSS_EASINGS.ease, // CSS initial: ease
    iterations,
    reverse,
    fill,
  };
}

// ---------------------------------------------------------------------------
// Keyframes -> timeline
// ---------------------------------------------------------------------------

/** `from` -> 0, `to`/`100%` -> 100, `62.5%` -> 62.5. */
function parsePct(sel: string, where: string): number {
  if (sel === "from") return 0;
  if (sel === "to") return 100;
  const m = /^(\d*\.?\d+)%$/.exec(sel);
  if (!m) err(`${where}: bad keyframe selector \`${sel}\`.`);
  const p = parseFloat(m[1]);
  if (p < 0 || p > 100) err(`${where}: keyframe selector \`${sel}\` out of range.`);
  return p;
}

/** Per-prop mention list: pct -> u32 bits, from every keyframe that pins it. */
function decomposeKeyframes(name: string, frames: Keyframes): Map<number, Map<number, number>> {
  const where = `keyframes \`${name}\``;
  // prop id -> (pct -> bits)
  const mentions = new Map<number, Map<number, number>>();
  const put = (prop: number, pct: number, bits: number) => {
    let m = mentions.get(prop);
    if (!m) mentions.set(prop, (m = new Map()));
    m.set(pct, bits);
  };
  // Transform union: which decomposed props appear anywhere, and which
  // keyframes (pcts) mention `transform` at all.
  const transformPcts: Array<[number, Map<number, number>]> = [];
  const transformUnion = new Set<number>();

  for (const [sel, props] of Object.entries(frames)) {
    const pcts = sel.split(",").map((s) => parsePct(s.trim(), where));
    for (const pct of pcts) {
      for (const [rawKey, value] of Object.entries(props)) {
        const key = camel(rawKey);
        if (key === "transform") {
          const decomposed = parseTransform(value, where);
          for (const p of decomposed.keys()) transformUnion.add(p);
          transformPcts.push([pct, decomposed]);
          continue;
        }
        const spec = KEYFRAME_PROPS[key];
        if (!spec) err(`${where}: unsupported property \`${rawKey}\`.`);
        const [propIds, encode] = spec;
        for (const prop of propIds) put(prop, pct, encode(value, `${where} ${rawKey}`));
      }
    }
  }
  // Fill transform union: a keyframe that mentions transform pins EVERY
  // decomposed prop (missing functions = identity, matching CSS list interp).
  for (const [pct, decomposed] of transformPcts) {
    for (const prop of transformUnion) {
      const v = decomposed.get(prop) ?? TRANSFORM_IDENTITY.get(prop)!;
      put(prop, pct, f32Bits(v));
    }
  }
  // Every animated prop must be animatable + pinned at 0% and 100%.
  for (const [prop, m] of mentions) {
    if (!ANIMATABLE_IDS.has(prop)) err(`${where}: prop id ${prop} is not animatable.`);
    const pcts = [...m.keys()].sort((a, b) => a - b);
    if (pcts[0] !== 0 || pcts[pcts.length - 1] !== 100) {
      err(
        `${where}: a property must be pinned at BOTH from/0% and to/100% ` +
          `(CSS falls back to the computed style there, which is not bakeable).`,
      );
    }
  }
  return mentions;
}

/** Bake one shorthand entry into an AnimTimeline. */
function bakeEntry(sh: ShorthandEntry, where: string): AnimTimeline {
  const frames = themeKeyframes[sh.name];
  const mentions = decomposeKeyframes(sh.name, frames);
  if (mentions.size === 0) err(`${where}: keyframes \`${sh.name}\` animate nothing.`);
  const periodFrames = Math.max(1, msToFrames(sh.durMs));
  if (periodFrames > 0xffff) err(`${where}: duration too long (max ~18 min).`);
  const delayFrames = msToFrames(sh.delayMs);
  if (delayFrames > 0xffff) err(`${where}: delay too long.`);
  const easing = sh.reverse ? reverseEasing(sh.easing) : sh.easing;

  const tracks: AnimTrack[] = [];
  for (const [prop, m] of [...mentions.entries()].sort((a, b) => a[0] - b[0])) {
    let stops = [...m.entries()].sort((a, b) => a[0] - b[0]);
    if (sh.reverse) stops = stops.map(([pct, bits]) => [100 - pct, bits] as [number, number]).reverse();
    const segments: AnimSegment[] = [];
    for (let i = 0; i + 1 < stops.length; i++) {
      const t0 = Math.round((stops[i][0] / 100) * periodFrames);
      const t1 = Math.round((stops[i + 1][0] / 100) * periodFrames);
      if (t1 <= t0) continue; // zero-length interval: later stop wins via hold rule
      segments.push({
        t0,
        t1,
        from: stops[i][1],
        to: stops[i + 1][1],
        easing: easing.ordinal,
        ...(easing.bezier ? { bezier: easing.bezier } : {}),
      });
    }
    if (segments.length === 0) {
      // Degenerate (e.g. 1-frame animation): a single snap segment.
      segments.push({
        t0: 0,
        t1: periodFrames,
        from: stops[0][1],
        to: stops[stops.length - 1][1],
        easing: ENUMS.Easing.Linear,
      });
    }
    tracks.push({ prop, segments });
  }
  return {
    delayFrames,
    periodFrames,
    iterations: sh.iterations,
    fill: sh.fill,
    tracks,
  };
}

// ---------------------------------------------------------------------------
// Public: animate-<name> resolution
// ---------------------------------------------------------------------------

function bakeTimeline(tl: AnimTimeline): number {
  const canon = JSON.stringify(tl);
  let id = bakedIds.get(canon);
  if (id === undefined) {
    id = baked.length;
    baked.push(tl);
    bakedIds.set(canon, id);
  }
  return id;
}

/** ms-ish loop value: `4s` | `4000ms` | number(ms) -> frames. */
export function loopToFrames(loop: string | number, where: string): number {
  const ms = typeof loop === "number" ? loop : parseTime(String(loop).trim());
  if (ms === null || ms <= 0) err(`${where}: bad loop period \`${loop}\`.`);
  const frames = msToFrames(ms);
  if (frames < 1 || frames > 0xffff) err(`${where}: loop period out of range.`);
  return frames;
}

/**
 * Resolve `animate-<name>`: bake the named animation (comma list) into the
 * ANIM TABLE. Returns null when the name is not in the theme (the literal is
 * then not a class string — consistent with every other utility).
 */
export function resolveAnimation(name: string): { anims: number[]; loopFrames: number } | null {
  const memo = resolved.get(name);
  if (memo !== undefined) return memo;
  const entry = themeAnimation[name];
  if (entry === undefined) {
    resolved.set(name, null);
    return null;
  }
  const where = `animation \`${name}\``;
  const value = typeof entry === "string" ? entry : entry.value;
  const loop = typeof entry === "string" ? undefined : entry.loop;
  const anims = splitTopLevel(value).map((e) => bakeTimeline(bakeEntry(parseShorthand(e, where), where)));
  if (anims.length === 0) err(`${where}: empty animation value.`);
  if (anims.length > 0xff) err(`${where}: too many comma entries.`);
  const result = {
    anims,
    loopFrames: loop === undefined ? 0 : loopToFrames(loop, where),
  };
  resolved.set(name, result);
  return result;
}
