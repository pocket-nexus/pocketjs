// PocketUI themes/aqua.ts — Aqua: the desktop of 2005. A pale grey window
// whose title bar and toolbar shade into one another, three gel lights at
// the leading end of the title, a centred title, capsule buttons with a
// gloss over the top half, a blue gel for the default one, a soft blue halo
// for the focus, and a source list with a blue selection.
//
// Original drawing in PocketJS primitives (gradients under a gloss layer,
// capsules by corner radius); no artwork of any operating system.
import { NO_GLYPH } from "../core/glyphs.ts";
import { defineTheme, FACES, type GlyphArt, type GlyphName, type Layer, type Metrics, type Paint, type Palette, type PartState, type Tone } from "../core/theme.ts";

const WINDOW = "#ececec";
const WHITE = "#ffffff";
const BLUE = "#3875d7";

const c: Palette = {
  canvas: WINDOW,
  surface: WHITE,
  raised: "#f2f2f2",
  selected: BLUE,
  line: "#b8b8b8",
  text: "#000000",
  muted: "#5e5e5e",
  faint: "#8a8a8a",
  accent: "#1558c8",
  accentFill: BLUE,
  onAccent: WHITE,
  good: "#2a8a2a",
  warn: "#b06e00",
  bad: "#c8281c",
  note: "#7a3fb0",
  scrim: "#00000030",
  codeSurface: "#f7f7f7",
  addFill: "#dcf3d8",
  delFill: "#f9dcd9",
  selection: "#b5d5ff",
  caret: "#000000",
};

const ON_BLUE = { text: WHITE, muted: "#dce8f9", faint: "#c3d6f2", accent: WHITE, good: "#d6ffd0", warn: "#fff2b8", bad: "#ffd6d0", note: "#efdcff" };

/** A gel: a capsule of coloured glass lit from above. Its body shades from a
 *  paler top through its deepest tone to a paler foot; over that, light
 *  gathers along the foot (the glow) and a bright band lies across the top
 *  half (the gloss). The two layers are inset from the rim, so the rim reads
 *  as the glass's edge. `radius` is the capsule's: half its height. */
interface Gel {
  body: readonly [string, string, string];
  rim: string;
  glow: string;
}
const CLEAR: Gel = { body: ["#fbfbfb", "#dcdcdc", "#ececec"], rim: "#8c8c8c", glow: "#ffffffd8" };
const CLEAR_DOWN: Gel = { body: ["#d9d9d9", "#b9b9b9", "#cdcdcd"], rim: "#6f6f6f", glow: "#ffffff90" };
const BLUE_GLASS: Gel = { body: ["#9ccdf8", "#3b8ce6", "#58a8f0"], rim: "#2b58a4", glow: "#bfeeffd8" };
const BLUE_DOWN: Gel = { body: ["#78b3ec", "#2670cc", "#408fe0"], rim: "#214a8e", glow: "#a8dcffb0" };
const GRAPHITE: Gel = { body: ["#7c7c7c", "#585858", "#6a6a6a"], rim: "#3e3e3e", glow: "#ffffff48" };

function gel(glass: Gel, radius: number): Paint {
  // The two lights are rounded boxes of their own, each less than half the
  // part's height, so each one's corner radius is at most a quarter of that
  // height: far squarer than the capsule's. Set near the rim, their corners
  // reach across it and paint the rim out on the four diagonals. So they are
  // inset: by `side` from the ends, where a square corner still clears the
  // capsule's inner arc, and by 2 from the top and the foot.
  const side = Math.max(3, Math.round(radius * 0.46));
  const round = Math.max(1, Math.round(radius * 0.45));
  return {
    gradient: glass.body,
    gradientMid: 0.52,
    border: glass.rim,
    radius,
    under: [
      { b: 2, l: side, r: side, hFrac: 0.38, radius: round, gradient: ["#ffffff00", glass.glow] },
      { t: 2, l: side, r: side, hFrac: 0.4, radius: round, gradient: ["#fffffff0", "#ffffff30"] },
    ],
  };
}
/** the gloss alone, for a ground that is not a capsule (a bubble): inset from its rounded corners for the same reason */
const gloss = (radius: number): Layer => ({ t: 2, l: Math.max(3, Math.round(radius * 0.5)), r: Math.max(3, Math.round(radius * 0.5)), hFrac: 0.4, radius: Math.min(5, radius), gradient: ["#ffffffe0", "#ffffff28"] });

const BLUE_GEL = BLUE_GLASS.body;

// The title bar and the panes' bars are one sheet of brushed light grey: the
// title bar's shade ends in the tone the bars' shade starts from, and no
// line is drawn between them (traits.unifiedBars).
const SHEET = ["#ececec", "#d6d6d6", "#bcbcbc"] as const;

const captionPaint = (s: PartState): Paint => ({
  gradient: s.active ? [SHEET[0], SHEET[1]] : ["#f5f5f5", "#e6e6e6"],
  under: [{ t: 0, h: 1, fill: "#fafafa" }],
  pad: [0, 8],
  text: "body",
  ink: { text: s.active ? "#1e1e1e" : "#8a8a8a" },
});

const LIGHTS: Record<string, readonly [string, string, string]> = {
  close: ["#ff8f84", "#e2463c", "#b1362e"],
  minimize: ["#ffdc80", "#e9ab3a", "#b98a2c"],
  zoom: ["#a5e58a", "#4dba3a", "#3b962d"],
};

/** A push button is a capsule the height of a control: 22 points, so its radius is 11. */
const CAPSULE = 11;

function button(s: PartState): Paint {
  if (s.variant === "plain") return { fill: s.pressed ? "#00000018" : undefined, radius: 5, pad: [0, 10], text: "body", ink: { text: s.disabled ? "#9c9c9c" : s.tone === "bad" ? c.bad : c.accent }, opacity: 1 };
  // a button that cannot be pressed is clear glass with grey lettering, whatever it would be
  if (s.disabled) return { ...gel({ ...CLEAR, rim: "#b4b4b4" }, CAPSULE), pad: [0, 16], text: "body", ink: { text: "#9c9c9c" }, opacity: 1 };
  // the blue glass is for the thing to do; one that destroys is clear glass lettered in red, so it is never the button that beckons
  const glass = s.pressed ? BLUE_DOWN : s.variant === "filled" && s.tone !== "bad" ? BLUE_GLASS : CLEAR;
  const paint: Paint = { ...gel(glass, CAPSULE), pad: [0, 16], text: "body", ink: { text: s.tone === "bad" && !s.pressed ? c.bad : "#000000" } };
  return s.variant === "pill" ? { ...paint, shadow: 1, pad: [0, 12] } : paint;
}

function badgeFill(tone: Tone | undefined): string {
  switch (tone) {
    case "warn": return "#a86a08";
    case "bad": return "#d0473c";
    case "good": return "#3a8a32";
    case "accent": return BLUE;
    case "note": return "#8e5cc2";
    default: return "#8b9cb5";
  }
}
const ALL_WHITE = { text: WHITE, muted: WHITE, faint: WHITE, accent: WHITE, good: WHITE, warn: WHITE, bad: WHITE, note: WHITE };

function glyphs(name: GlyphName, _size: number, state: PartState): GlyphArt | null {
  // the lights carry no mark, a capsule thumb no ridges
  if (state.variant === "caption" || name === "grip") return NO_GLYPH;
  return null;
}

const METRICS: Metrics = { target: 26, rowPad: 5, gutter: 10, bar: 32, radius: 5, caption: 22, menubar: 22, status: 20, control: 22, scrollbar: 15, captionButton: [12, 12], buttonMin: 70, thumbInset: 2, toggle: [14, 14], knob: [14, 14] };

export const AQUA_THEME = defineTheme({
  id: "aqua",
  label: "Aqua",
  scheme: "light",
  color: c,
  face: { ...FACES, title: FACES.strong },
  metric: METRICS,
  compact: { ...METRICS, target: 22, rowPad: 4, bar: 26 },
  traits: {
    caption: true,
    captionControls: "leading",
    captionTrio: true,
    titleAlign: "center",
    commands: "bar",
    unifiedBars: true,
    actions: "footer",
    picker: "popup",
    back: "glyph",
    scroll: "overlay",
    scrollButtons: false,
    sheets: "window",
    dialogCaption: false,
    defaultLast: true,
    dialogButtons: "trailing",
    rowRules: true,
    sectionCaps: true,
    focusRing: true,
    motion: "slide",
  },
  parts: {
    canvas: { fill: WINDOW },
    pane: { fill: WHITE },
    "pane.detail": { fill: WHITE },
    // as a column, the pale blue of a source list; over another pane, a panel of the window's own grey with an edge and a shadow
    sidebar: (s) => (s.variant === "panel" ? { fill: WINDOW, shadow: 3, under: [{ l: 0, w: 1, fill: "#8e8e8e" }], pad: [0, 0, 0, 1] } : { fill: "#e3e9f1", ink: { muted: "#5c6a7c", faint: "#7c8a9c" } }),
    caption: captionPaint,
    "caption.button": (s) => {
      const live = !s.disabled && s.active;
      const stops = live ? (LIGHTS[s.variant ?? "close"] ?? LIGHTS.close!) : (["#f2f2f2", "#cfcfcf", "#a6a6a6"] as const);
      return { gradient: [stops[0], stops[1]], border: stops[2], radius: 6, opacity: s.pressed ? 0.75 : 1, under: [{ t: 2, l: 4, r: 4, h: 3, radius: 1.5, gradient: ["#ffffffd0", "#ffffff20"] }] };
    },
    menubar: { gradient: ["#f6f6f6", "#e2e2e2"], pad: [0, 6] },
    "menubar.item": (s) => ({ gradient: s.selected || s.pressed || s.hovered ? ["#5f93e8", "#2d66d0"] : undefined, pad: [3, 8], ink: s.selected || s.pressed || s.hovered ? ON_BLUE : undefined }),
    status: { gradient: ["#e9e9e9", "#d6d6d6"], pad: [0, 10], under: [{ t: 0, h: 1, fill: "#a9a9a9" }, { t: 1, h: 1, fill: "#f6f6f6" }], ink: { text: "#3c3c3c" } },
    "status.cell": {},
    bar: (s) => (s.variant === "footer" ? { fill: "#e4e4e4", under: [{ t: 0, h: 1, fill: "#bdbdbd" }] } : { gradient: [SHEET[1], SHEET[2]], pad: [0, 8], under: [{ b: 0, h: 1, fill: "#7f7f7f" }], ink: { muted: "#3f3f3f" } }),
    "bar.button": (s) => {
      if (s.disabled) return { ...gel({ ...CLEAR, rim: "#aeaeae" }, CAPSULE), pad: [0, 11], ink: { accent: "#9c9c9c", bad: "#9c9c9c", text: "#9c9c9c" }, opacity: 1 };
      if (s.selected) return { ...gel(GRAPHITE, CAPSULE), pad: [0, 11], ink: { accent: WHITE, bad: WHITE, text: WHITE } };
      return { ...gel(s.pressed ? CLEAR_DOWN : CLEAR, CAPSULE), pad: [0, 11], ink: { accent: "#1c1c1c", bad: c.bad, text: "#1c1c1c" } };
    },
    row: (s) => (s.selected ? { gradient: ["#5d94d6", "#2f6fc4"], pad: [5, 10], ink: ON_BLUE, under: [{ t: 0, h: 1, fill: "#76a4de" }] } : { fill: s.pressed ? "#dfe9fa" : s.hovered ? "#eef3fb" : undefined, pad: [5, 10] }),
    section: (s) => (s.variant === "panel" ? { gradient: ["#e9e9e9", "#d5d5d5"], pad: [4, 8, 4, 10], text: "strong", ink: { text: "#2a2a2a" }, under: [{ b: 0, h: 1, fill: "#a2a2a2" }] } : { fill: "#f1f4f8", pad: [6, 10, 3, 10], text: "caption", ink: { text: "#62707f", faint: "#8a96a4" } }),
    // between rows a hair; between panes the edge of a column, which crosses the bars
    divider: (s) => ({ fill: s.variant === "panes" ? "#9d9d9d" : "#e0e0e0" }),
    button,
    field: (s) => ({ fill: WHITE, border: s.tone === "good" ? c.good : s.selected ? "#5b96dd" : "#9d9d9d", radius: 3, pad: [4, 6], under: [{ t: 1, l: 1, r: 1, h: 1, fill: "#dcdcdc" }] }),
    picker: (s) => ({ ...gel(s.pressed ? CLEAR_DOWN : s.disabled ? { ...CLEAR, rim: "#b4b4b4" } : CLEAR, CAPSULE), pad: [0, 0, 0, 11], ink: s.disabled ? { text: "#9c9c9c" } : undefined, opacity: 1 }),
    // the popup's cap: a bead of blue glass at its trailing end, with one soft light on its crown
    "picker.button": (s) => ({ fill: s.disabled ? "#5a5a5a" : "#2b58a4", radius: CAPSULE - 1, ink: { text: WHITE }, under: [{ l: 1, t: 1, r: 1, b: 1, radius: CAPSULE - 2, gradient: s.disabled ? ["#a8a8a8", "#6c6c6c", "#8a8a8a"] : ["#8cc4f7", "#3a8ae4", "#62b0f2"], gradientMid: 0.5 }, { l: 5, r: 5, t: 2, h: 5, radius: 3, gradient: ["#ffffffd8", "#ffffff18"] }] }),
    toggle: (s) => gel(s.selected ? BLUE_GLASS : CLEAR, 3),
    "toggle.knob": {},
    segments: {},
    segment: (s) => (s.selected ? { ...gel(BLUE_GLASS, 5), pad: [0, 12], ink: { text: "#000000" } } : { ...gel(s.pressed ? CLEAR_DOWN : CLEAR, 5), pad: [0, 12] }),
    progress: { fill: "#e6e6e6", border: "#8f8f8f", radius: 6, pad: 1 },
    "progress.fill": { gradient: BLUE_GEL, radius: 5 },
    card: (s) => ({ fill: s.pressed ? "#e4e4e4" : "#f1f1f1", border: s.tone === "warn" ? "#dba036" : "#cbcbcb", radius: 6, pad: [6, 9] }),
    well: (s) => ({ fill: "#f7f7f7", border: "#c6c6c6", radius: 3, pad: s.variant === "table" ? 1 : [5, 7] }),
    bubble: (s) =>
      s.variant === "self"
        ? { gradient: ["#d9eaff", "#a9cdfb"], border: "#7daee9", radius: 11, pad: [5, 11], under: [gloss(9)] }
        : { gradient: ["#f7f7f7", "#dedede"], border: "#b4b4b4", radius: 11, pad: [5, 11], under: [gloss(9)] },
    badge: (s) => ({ fill: badgeFill(s.tone), radius: 8, pad: [0, 6], text: "caption", ink: ALL_WHITE }),
    callout: (s) => ({ fill: s.pressed ? "#ececec" : undefined, radius: 4 }),
    tooltip: (s) => ({ fill: "#ffffc8", border: "#c8c890", shadow: 2, pad: [3, 9], ink: { text: s.tone === "bad" ? c.bad : "#000000" } }),
    // behind a dialog the window dims a little; behind a menu that popped up nothing does
    scrim: (s) => (s.variant === "popover" ? {} : { fill: c.scrim }),
    menu: { fill: "#fffffff4", border: "#b0b0b0", radius: 5, shadow: 3, pad: [4, 0] },
    "menu.item": (s) => ({ gradient: s.focused || s.pressed || s.selected || s.hovered ? ["#5f93e8", "#2d66d0"] : undefined, pad: [5, 14, 5, 8], ink: s.focused || s.pressed || s.selected || s.hovered ? ON_BLUE : undefined, showsFocus: true }),
    "menu.title": (s) => (s.variant === "menu" ? { pad: [7, 12, 4, 12], text: "caption", ink: { text: "#62707f" } } : { pad: [13, 18, 2, 18], text: "strong" }),
    separator: { fill: "#d4d4d4" },
    dialog: { fill: WINDOW, border: "#8e8e8e", radius: 6, shadow: 3 },
    "dialog.caption": captionPaint,
    "dialog.body": {},
    sheet: { fill: WINDOW, border: "#9a9a9a", shadow: 3 },
    "scroll.track": { gradient: ["#d2d2d2", "#eeeeee", "#fbfbfb"], gradientDir: "right", gradientMid: 0.3, under: [{ l: 0, w: 1, fill: "#a9a9a9" }] },
    // a grey bar over the content that shows while it moves and takes no room; the capsule in a channel is the strip's
    "scroll.thumb": (s) => (s.variant === "overlay" ? { fill: "#00000078", radius: 3 } : { gradient: ["#a9cef7", "#4288e0", "#79b2f0"], gradientDir: "right", gradientMid: 0.55, border: "#3a66ad", radius: 6 }),
    "scroll.button": {},
    focus: { border: "#6ea5e8", borderWidth: 3, pad: 2 },
    drag: { gradient: ["#5f93e8", "#2d66d0"], radius: 10, shadow: 2, pad: [3, 10], ink: ON_BLUE },
  },
  glyphs,
});
