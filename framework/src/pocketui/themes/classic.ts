// PocketUI themes/classic.ts — Classic: the desktop of 1998. One grey face,
// and every edge two rings of light and shadow: raised for what is pressed,
// sunken for what is filled in. A navy title bar, a menu bar under it, a
// status bar of sunken cells, scroll bars with an arrow at each end, and
// marks drawn pixel by pixel.
//
// Original drawing in PocketJS primitives (the core's bevel rings, a
// two-colour gradient, rectangles); no artwork of any operating system.
import { bitmap, NO_GLYPH } from "../core/glyphs.ts";
import { defineTheme, FACES, type Bevel, type GlyphArt, type GlyphName, type Metrics, type Paint, type Palette, type PartState } from "../core/theme.ts";

const FACE = "#c0c0c0";
const WHITE = "#ffffff";
const LIGHT = "#dfdfdf";
const SHADOW = "#808080";
const BLACK = "#000000";
const NAVY = "#000080";
const INFO = "#ffffe1";

const c: Palette = {
  canvas: FACE,
  surface: WHITE,
  raised: FACE,
  selected: NAVY,
  line: SHADOW,
  text: BLACK,
  muted: "#404040",
  faint: SHADOW,
  accent: NAVY,
  accentFill: NAVY,
  onAccent: WHITE,
  good: "#006400",
  warn: "#7a5c00",
  bad: "#a00000",
  note: "#600080",
  scrim: "#00000000",
  codeSurface: WHITE,
  addFill: "#d8f0d8",
  delFill: "#f4d8d8",
  selection: "#a6caf0",
  caret: BLACK,
};

/** a push button at rest */
const RAISED: Bevel = { outerLight: WHITE, outerDark: BLACK, innerLight: LIGHT, innerDark: SHADOW };
/** a push button held down */
const PRESSED: Bevel = { outerLight: BLACK, outerDark: WHITE, innerLight: SHADOW, innerDark: LIGHT };
/** a window's frame, a menu */
const WINDOW: Bevel = { outerLight: LIGHT, outerDark: BLACK, innerLight: WHITE, innerDark: SHADOW };
/** a field, a list: where content is filled in */
const SUNKEN: Bevel = { outerLight: SHADOW, outerDark: WHITE, innerLight: BLACK, innerDark: LIGHT };
/** one ring down: a status cell */
const DENT: Bevel = { outerLight: SHADOW, outerDark: WHITE };
/** one ring up: a tool button, a column heading */
const RIDGE: Bevel = { outerLight: WHITE, outerDark: SHADOW };
/** a line cut into the face: a group's edge */
const ETCHED: Bevel = { outerLight: SHADOW, outerDark: WHITE, innerLight: WHITE, innerDark: SHADOW };

const ON_NAVY = { text: WHITE, muted: "#d0d4ff", faint: "#b0b4e8", accent: WHITE, good: "#c8ffc8", warn: "#ffffa0", bad: "#ffc0c0", note: "#e8c8ff" };
const captionPaint = (s: PartState): Paint => ({
  gradient: s.active ? [NAVY, "#1084d0"] : [SHADOW, "#b5b5b5"],
  gradientDir: "right",
  pad: [0, 2, 0, 4],
  text: "strong",
  ink: { text: s.active ? WHITE : FACE },
});

function button(s: PartState): Paint {
  const ink = { text: s.disabled ? SHADOW : s.tone === "bad" ? c.bad : BLACK };
  const base: Paint = { fill: FACE, bevel: s.pressed ? PRESSED : RAISED, pad: [3, 12], text: "body", ink, nudge: s.pressed ? [1, 1] : undefined, opacity: 1 };
  if (s.variant === "plain") return { ...base, bevel: s.pressed ? DENT : undefined };
  if (s.variant === "pill") return { ...base, pad: [2, 9] };
  // the default button: a black frame around the raised face
  if (s.variant === "filled" && !s.disabled) return { fill: BLACK, pad: [4, 13], text: "body", ink, nudge: base.nudge, under: [{ l: 1, t: 1, r: 1, b: 1, fill: FACE, bevel: s.pressed ? { outerLight: SHADOW, outerDark: SHADOW } : RAISED }] };
  return base;
}

const P: Record<string, readonly string[]> = {
  close: ["##....##", ".##..##.", "..####..", "...##...", "..####..", ".##..##.", "##....##"],
  minimize: ["........", "........", "........", "........", "........", "######..", "######.."],
  zoom: ["#########", "#########", "#.......#", "#.......#", "#.......#", "#.......#", "#.......#", "#########"],
  up: ["...#...", "..###..", ".#####.", "#######"],
  down: ["#######", ".#####.", "..###..", "...#..."],
  left: ["...#", "..##", ".###", "####", ".###", "..##", "...#"],
  right: ["#...", "##..", "###.", "####", "###.", "##..", "#..."],
  check: ["......#", ".....##", "#...###", "##.###.", "#####..", ".###...", "..#...."],
  dot: [".##.", "####", "####", ".##."],
  more: ["##.##.##", "##.##.##"],
  plus: ["...##...", "...##...", "...##...", "########", "########", "...##...", "...##...", "...##..."],
  menu: ["########", "........", "########", "........", "########"],
};

function glyphs(name: GlyphName, _size: number, state: PartState): GlyphArt | null {
  if (name === "grip") return NO_GLYPH;
  const rows = P[name === "back" ? "left" : name === "forward" || name === "disclosure" ? "right" : name === "updown" ? "down" : name];
  if (!rows) return null;
  // a disabled mark is the shadow colour; the others take the ink of where they sit
  return bitmap(rows, 1, state.disabled ? SHADOW : undefined);
}

const METRICS: Metrics = { target: 26, rowPad: 4, gutter: 6, bar: 24, radius: 0, caption: 20, menubar: 21, status: 21, control: 23, scrollbar: 16, captionButton: [16, 14], buttonMin: 72, thumbInset: 0, toggle: [13, 13], knob: [13, 13] };

export const CLASSIC_THEME = defineTheme({
  id: "classic",
  label: "Classic 98",
  scheme: "light",
  color: c,
  face: { ...FACES, title: FACES.strong },
  metric: METRICS,
  compact: { ...METRICS, target: 22, rowPad: 3, bar: 22, caption: 18 },
  traits: {
    caption: true,
    captionControls: "trailing",
    captionTrio: false,
    titleAlign: "leading",
    commands: "menubar",
    unifiedBars: false,
    actions: "footer",
    picker: "popup",
    back: "glyph",
    scroll: "overlay",
    scrollButtons: true,
    sheets: "window",
    dialogCaption: true,
    defaultLast: false,
    dialogButtons: "center",
    rowRules: false,
    sectionCaps: false,
    focusRing: true,
    motion: "cut",
  },
  parts: {
    canvas: { fill: FACE },
    pane: { fill: WHITE, bevel: SUNKEN, pad: 2 },
    "pane.detail": { fill: WHITE, bevel: SUNKEN, pad: 2 },
    // over another pane it is a tool window's body: the raised frame; as a column, a sunken well like the others
    sidebar: (s) => (s.variant === "panel" ? { fill: FACE, bevel: WINDOW, pad: 3 } : { fill: FACE, bevel: SUNKEN, pad: 2 }),
    caption: captionPaint,
    "caption.button": (s) => ({ fill: FACE, bevel: s.pressed ? PRESSED : RAISED, nudge: s.pressed ? [1, 1] : undefined, ink: { text: s.disabled ? SHADOW : BLACK }, opacity: 1 }),
    menubar: { fill: FACE, pad: [1, 2] },
    "menubar.item": (s) => ({ fill: s.selected || s.pressed || s.hovered ? NAVY : undefined, pad: [2, 7], ink: s.selected || s.pressed || s.hovered ? ON_NAVY : undefined }),
    status: { fill: FACE, pad: [2, 1, 1, 1] },
    "status.cell": { bevel: DENT, pad: [1, 5] },
    bar: { fill: FACE, bevel: RIDGE, pad: [2, 4, 2, 6], ink: { muted: "#404040" } },
    "bar.button": (s) => ({
      fill: s.selected ? LIGHT : FACE,
      bevel: s.pressed || s.selected ? DENT : RIDGE,
      pad: [3, 8],
      nudge: s.pressed ? [1, 1] : undefined,
      ink: { accent: s.disabled ? SHADOW : BLACK, bad: s.disabled ? SHADOW : c.bad, text: BLACK },
      opacity: 1,
    }),
    row: (s) => ({ fill: s.selected ? NAVY : s.pressed ? LIGHT : undefined, pad: [4, 6], ink: s.selected ? ON_NAVY : undefined }),
    section: { fill: FACE, bevel: RIDGE, pad: [2, 6], text: "body", ink: { text: BLACK, faint: "#404040" } },
    divider: { fill: SHADOW },
    button,
    field: (s) => ({ fill: s.disabled ? FACE : WHITE, bevel: SUNKEN, pad: [4, 5], opacity: 1, ink: s.disabled ? { faint: SHADOW } : undefined }),
    picker: (s) => ({ fill: s.disabled ? FACE : WHITE, bevel: SUNKEN, pad: [2, 2, 2, 5], opacity: 1 }),
    "picker.button": (s) => ({ fill: FACE, bevel: s.pressed ? DENT : RAISED, ink: { text: BLACK } }),
    toggle: { fill: WHITE, bevel: SUNKEN },
    "toggle.knob": {},
    segments: {},
    segment: (s) => ({ fill: FACE, bevel: s.selected ? PRESSED : RAISED, pad: [3, 10], nudge: s.selected ? [1, 1] : undefined }),
    progress: { fill: FACE, bevel: DENT, pad: 2 },
    "progress.fill": { fill: NAVY },
    card: (s) => ({ fill: s.pressed ? LIGHT : FACE, bevel: ETCHED, pad: [6, 8] }),
    well: (s) => ({ fill: WHITE, bevel: SUNKEN, pad: s.variant === "table" ? 2 : [4, 6] }),
    bubble: (s) => (s.variant === "self" ? { fill: INFO, border: BLACK, pad: [4, 8] } : { fill: WHITE, border: SHADOW, pad: [4, 8] }),
    badge: { fill: FACE, bevel: DENT, pad: [0, 4], text: "caption", ink: { muted: BLACK, faint: BLACK } },
    callout: (s) => ({ fill: s.pressed ? LIGHT : undefined }),
    tooltip: (s) => ({ fill: INFO, border: BLACK, pad: [3, 8], ink: { text: s.tone === "bad" ? c.bad : BLACK } }),
    scrim: {},
    menu: { fill: FACE, bevel: WINDOW, pad: 3 },
    "menu.item": (s) => ({ fill: s.focused || s.pressed || s.selected || (s.hovered && !s.disabled) ? NAVY : undefined, pad: [5, 10, 5, 6], ink: s.focused || s.pressed || s.selected || (s.hovered && !s.disabled) ? ON_NAVY : s.disabled ? { text: SHADOW } : undefined, showsFocus: true, opacity: 1 }),
    "menu.title": { pad: [4, 8], text: "strong" },
    separator: { fill: SHADOW },
    dialog: { fill: FACE, bevel: WINDOW, pad: 3 },
    "dialog.caption": captionPaint,
    "dialog.body": {},
    sheet: { fill: FACE, bevel: WINDOW, pad: 3 },
    // the track is the face and white in a checkerboard; one flat tone between the two stands for it
    "scroll.track": { fill: "#dcdcdc" },
    // the thumb over the content, where the scroll bar is one (traits.scroll); the strip's is the raised face
    "scroll.thumb": (s) => (s.variant === "overlay" ? { fill: "#000000a0" } : { fill: FACE, bevel: RAISED }),
    "scroll.button": (s) => ({ fill: FACE, bevel: s.pressed ? DENT : RAISED, nudge: s.pressed ? [1, 1] : undefined, ink: { text: BLACK }, opacity: 1 }),
    focus: { border: BLACK, borderWidth: 1, pad: 1, radius: 0 },
    drag: { fill: INFO, border: BLACK, pad: [3, 8] },
  },
  glyphs,
});
