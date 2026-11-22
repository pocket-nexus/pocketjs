// PocketUI themes/luna.ts — Luna: the desktop of 2001. A warm paper face,
// a deep blue title bar that shades top to bottom, controls with rounded
// corners under a dark blue line, an orange ring for the keyboard's focus
// and a blue one for the default button, white lists with a blue selection.
//
// Original drawing in PocketJS primitives (three-stop gradients, rounded
// boxes, 1-point strips); no artwork of any operating system.
import { stockGlyph, stroke } from "../core/glyphs.ts";
import { defineTheme, FACES, type GlyphArt, type GlyphName, type Metrics, type Paint, type Palette, type PartState } from "../core/theme.ts";

const FACE = "#ece9d8";
const WHITE = "#ffffff";
const BLUE = "#316ac5";
const EDGE = "#7f9db9";
const RULE = "#d6d2bf";
const ORANGE = "#f0a52c";

const c: Palette = {
  canvas: FACE,
  surface: WHITE,
  raised: "#f5f4ea",
  selected: BLUE,
  line: "#aca899",
  text: "#000000",
  muted: "#55534a",
  faint: "#8f8c7c",
  accent: "#0f4cc0",
  accentFill: BLUE,
  onAccent: WHITE,
  good: "#2a7a22",
  warn: "#a35f00",
  bad: "#b4261a",
  note: "#6a3d9a",
  scrim: "#00000000",
  codeSurface: "#fbfaf5",
  addFill: "#dff3d8",
  delFill: "#f8dcd8",
  selection: "#b9d1f5",
  caret: "#000000",
};

const ON_BLUE = { text: WHITE, muted: "#d9e5fa", faint: "#bfd2f4", accent: WHITE, good: "#d2ffcc", warn: "#fff0b0", bad: "#ffd2cc", note: "#ecd9ff" };

const captionPaint = (s: PartState): Paint => ({
  gradient: s.active ? ["#2f8bff", "#0453e0", "#0a44c8"] : ["#a3b9ef", "#7c97df", "#738bd6"],
  gradientMid: 0.2,
  under: [{ t: 0, h: 1, fill: s.active ? "#59a5ff" : "#b9caf3" }, { b: 0, h: 1, fill: s.active ? "#0738b0" : "#6a80c8" }],
  pad: [0, 4, 0, 7],
  text: "strong",
  ink: { text: WHITE },
});

/** the gel every push control shares: white running to the paper colour, a darker lip at the foot */
const GEL: readonly [string, string, string] = ["#ffffff", "#f3f1e7", "#d9d5c3"];
const GEL_DOWN: readonly [string, string, string] = ["#d6d2c2", "#e6e3d6", "#f1efe6"];

function button(s: PartState): Paint {
  if (s.disabled) return { fill: "#f5f4ea", border: "#c9c7ba", radius: 3, pad: [4, 14], text: "body", ink: { text: "#aca899" }, opacity: 1 };
  const ink = { text: s.tone === "bad" ? c.bad : "#000000" };
  const base: Paint = { gradient: s.pressed ? GEL_DOWN : GEL, gradientMid: 0.8, border: "#003c74", radius: 3, pad: [4, 14], text: "body", ink };
  if (s.variant === "plain") return { fill: s.pressed ? "#e2dfd0" : undefined, radius: 3, pad: [4, 10], text: "body", ink: { text: s.tone === "bad" ? c.bad : c.accent } };
  if (s.variant === "pill") return { ...base, radius: 10, shadow: 1, pad: [3, 11] };
  // the focus is an orange ring inside the edge, the default button a blue one
  if (s.focused || (s.hovered && !s.pressed)) return { ...base, under: [{ l: 1, t: 1, r: 1, b: 1, radius: 2, border: ORANGE, borderWidth: 2 }], showsFocus: true };
  if (s.variant === "filled" && !s.pressed) return { ...base, under: [{ l: 1, t: 1, r: 1, b: 1, radius: 2, border: "#8fb2ec", borderWidth: 2 }] };
  return base;
}

function glyphs(name: GlyphName, size: number, state: PartState): GlyphArt | null {
  if (name === "grip") {
    // four short ridges across a scroll thumb
    const shapes = [];
    for (let i = 0; i < 4; i++) shapes.push({ x: 1, y: i * 2, w: 6, h: 1, color: i % 2 === 0 ? "#eef4fe" : "#8ca6dc" });
    return { w: 8, h: 8, shapes };
  }
  if (state.variant === "caption") {
    const s = size;
    const t = 2;
    if (name === "close") return { w: s, h: s, shapes: [stroke(s / 2, s / 2, s * 1.1, t, 45), stroke(s / 2, s / 2, s * 1.1, t, -45)] };
    return null;
  }
  if (name === "updown") return stockGlyph("down", size);
  // a check box's mark is green
  if (name === "check" && state.variant === "toggle") return { w: size, h: size, shapes: [{ ...stroke(size * 0.28, size * 0.66, size * 0.42, 2, 45), color: "#21a121" }, { ...stroke(size * 0.63, size * 0.5, size * 0.8, 2, -51), color: "#21a121" }] };
  return null;
}

const METRICS: Metrics = { target: 26, rowPad: 4, gutter: 8, bar: 28, radius: 3, caption: 26, menubar: 21, status: 21, control: 23, scrollbar: 17, captionButton: [21, 21], buttonMin: 72, thumbInset: 0, toggle: [13, 13], knob: [13, 13] };

export const LUNA_THEME = defineTheme({
  id: "luna",
  label: "XP",
  scheme: "light",
  color: c,
  face: { ...FACES, title: FACES.strong },
  metric: METRICS,
  compact: { ...METRICS, target: 22, rowPad: 3, bar: 24, caption: 22 },
  traits: {
    caption: true,
    captionControls: "trailing",
    captionTrio: false,
    titleAlign: "leading",
    commands: "menubar",
    unifiedBars: false,
    actions: "footer",
    picker: "popup",
    back: "label",
    scroll: "overlay",
    scrollButtons: true,
    sheets: "window",
    dialogCaption: true,
    defaultLast: false,
    dialogButtons: "trailing",
    rowRules: false,
    sectionCaps: false,
    focusRing: true,
    motion: "slide",
  },
  parts: {
    canvas: { fill: FACE },
    pane: { fill: WHITE, border: EDGE, pad: 1 },
    "pane.detail": { fill: WHITE, border: EDGE, pad: 1 },
    sidebar: (s) => ({ gradient: ["#e4ebfa", "#d3def6"], border: s.variant === "panel" ? "#3f6bc4" : EDGE, shadow: s.variant === "panel" ? 2 : 0, pad: 1, ink: { muted: "#3f5d9c", faint: "#6b83b8", accent: "#215dc6" } }),
    caption: captionPaint,
    "caption.button": (s) => {
      const red = s.variant === "close";
      const stops: readonly [string, string, string] = s.pressed ? (red ? ["#a3260c", "#c23c1c", "#d9603f"] : ["#1a3fae", "#2a5fd8", "#4f8bf2"]) : red ? ["#f0a48b", "#d8492a", "#b93011"] : ["#6fa8fb", "#2c63de", "#1c48bd"];
      return { gradient: stops, gradientMid: 0.45, border: WHITE, radius: 3, ink: { text: WHITE }, opacity: s.disabled ? 0.55 : 1 };
    },
    menubar: { fill: FACE, pad: [1, 3], under: [{ b: 0, h: 1, fill: RULE }] },
    "menubar.item": (s) => ({ fill: s.selected || s.pressed || s.hovered ? BLUE : undefined, pad: [3, 7], ink: s.selected || s.pressed || s.hovered ? ON_BLUE : undefined }),
    status: { fill: FACE, pad: [2, 4, 1, 4], under: [{ t: 0, h: 1, fill: "#c5c2b2" }, { t: 1, h: 1, fill: WHITE }] },
    "status.cell": { pad: [1, 4] },
    bar: { gradient: ["#fdfcf8", "#ebe8d7"], pad: [2, 5, 2, 8], under: [{ b: 0, h: 1, fill: RULE }], ink: { muted: c.muted } },
    "bar.button": (s) => {
      const ink = { accent: s.disabled ? "#aca899" : "#000000", bad: s.disabled ? "#aca899" : c.bad, text: "#000000" };
      if (s.selected) return { fill: WHITE, border: BLUE, radius: 3, pad: [4, 8], ink, opacity: 1 };
      return { gradient: s.pressed ? ["#dcd9c9", "#eeece2"] : ["#ffffff", "#ebe8d8"], border: s.pressed ? "#9d9a8a" : "#cdcabb", radius: 3, pad: [4, 8], ink, opacity: 1 };
    },
    row: (s) => ({ fill: s.selected ? BLUE : s.pressed ? "#dfe8f8" : s.hovered ? "#f1f5fc" : undefined, pad: [4, 8], ink: s.selected ? ON_BLUE : undefined }),
    section: { fill: WHITE, pad: [7, 8, 3, 8], text: "strong", ink: { text: "#0c3dab", faint: "#6b83b8" }, under: [{ b: 0, l: 8, r: 8, h: 1, gradient: ["#7a9be0", "#ffffff"], gradientDir: "right" }] },
    divider: { fill: RULE },
    button,
    field: (s) => ({ fill: s.disabled ? "#f5f4ea" : WHITE, border: s.tone === "good" ? c.good : EDGE, pad: [4, 6], opacity: 1 }),
    picker: (s) => ({ fill: s.disabled ? "#f5f4ea" : WHITE, border: EDGE, pad: [1, 1, 1, 6], opacity: 1 }),
    "picker.button": (s) => ({ gradient: s.pressed ? ["#a9bef0", "#bdcff7"] : ["#cfdcfe", "#b6c9f6"], border: "#ffffff", radius: 2, ink: { text: "#4d6185" } }),
    toggle: { gradient: ["#dcdcd5", "#ffffff"], gradientDir: "right", border: "#1c5180" },
    "toggle.knob": {},
    segments: {},
    segment: (s) =>
      s.selected
        ? { fill: WHITE, border: "#919b9c", radius: 3, pad: [3, 10], under: [{ t: 0, l: 1, r: 1, h: 2, fill: "#e68b2c" }] }
        : { gradient: s.pressed ? GEL_DOWN : ["#ffffff", "#ece9d8"], border: "#919b9c", radius: 3, pad: [3, 10] },
    progress: { fill: WHITE, border: "#686868", radius: 3, pad: 1 },
    "progress.fill": { gradient: ["#b7ec9f", "#35b825", "#6fd75c"], radius: 2 },
    card: (s) => ({ fill: s.pressed ? "#efeee4" : "#fbfaf5", border: s.tone === "warn" ? "#e0a030" : "#d0d0bf", radius: 4, pad: [6, 9] }),
    well: (s) => ({ fill: WHITE, border: "#aca899", pad: s.variant === "table" ? 1 : [5, 7] }),
    bubble: (s) => (s.variant === "self" ? { gradient: ["#eef4fe", "#dbe7fb"], border: "#a7c0ee", radius: 6, pad: [5, 9] } : { fill: WHITE, border: "#d0d0bf", radius: 6, pad: [5, 9] }),
    badge: { fill: "#f1efe2", border: "#d0d0bf", radius: 2, pad: [0, 5], text: "caption" },
    callout: (s) => ({ fill: s.pressed ? "#efeee4" : undefined, radius: 3 }),
    tooltip: (s) => ({ fill: "#ffffe1", border: "#000000", shadow: 1, pad: [3, 8], ink: { text: s.tone === "bad" ? c.bad : "#000000" } }),
    scrim: {},
    menu: { fill: WHITE, border: "#aca899", shadow: 2, pad: 2 },
    "menu.item": (s) => ({ fill: s.focused || s.pressed || s.selected || (s.hovered && !s.disabled) ? BLUE : undefined, pad: [5, 10, 5, 6], ink: s.focused || s.pressed || s.selected || (s.hovered && !s.disabled) ? ON_BLUE : s.disabled ? { text: "#aca899" } : undefined, showsFocus: true, opacity: 1 }),
    "menu.title": { pad: [4, 8], text: "strong" },
    separator: { fill: "#aca899" },
    // the window's frame is the title bar's blue, three points of it around the body
    dialog: { fill: "#0a52de", radius: 6, shadow: 3, pad: [0, 3, 3, 3] },
    "dialog.caption": (s) => ({ ...captionPaint(s), pad: [0, 2, 0, 5] }),
    "dialog.body": { fill: FACE },
    sheet: { fill: "#0a52de", shadow: 3, pad: [0, 3, 3, 3] },
    "scroll.track": { gradient: ["#f0efe8", "#fdfdfa"], gradientDir: "right" },
    "scroll.thumb": (s) => s.variant === "overlay" ? { fill: "#1d4fa8a8", radius: 2 } : ({ gradient: s.pressed ? ["#a9bef0", "#bdcff7"] : ["#cfdcfe", "#b6c9f6"], gradientDir: "right", border: "#ffffff", radius: 2, under: [{ l: 0, t: 0, r: 0, b: 0, radius: 3, border: "#9fb5e6" }] }),
    "scroll.button": (s) => ({ gradient: s.pressed ? ["#a9bef0", "#bdcff7"] : ["#cfdcfe", "#b6c9f6"], gradientDir: "right", border: "#ffffff", radius: 2, ink: { text: s.disabled ? "#aebbd8" : "#4d6185" }, opacity: 1, under: [{ l: 0, t: 0, r: 0, b: 0, radius: 3, border: "#9fb5e6" }] }),
    focus: { border: ORANGE, borderWidth: 2, pad: 1 },
    drag: { fill: "#ffffe1", border: "#000000", shadow: 1, pad: [3, 8] },
  },
  glyphs,
});
