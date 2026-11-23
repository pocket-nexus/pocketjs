// PocketUI themes/pocket.ts — the Pocket theme: PocketUI's own look, dark,
// flat, made for a handheld's panel held close. Controls are grounds without
// edges, the focus is a ring, a menu rises from the bottom edge and a scroll
// bar is a thumb that shows while the content moves.
import { NO_GLYPH } from "../core/glyphs.ts";
import { defineTheme, FACES, type Metrics, type Paint, type Palette, type PartState, type Tone } from "../core/theme.ts";

export const DARK: Palette = {
  canvas: "#0c0e11",
  surface: "#13161a",
  raised: "#1b1f25",
  selected: "#232a36",
  line: "#272c34",
  text: "#e7e9ec",
  muted: "#98a1ad",
  faint: "#5f6772",
  accent: "#7fb0ff",
  accentFill: "#2f5fb3",
  onAccent: "#ffffff",
  good: "#5fcb8a",
  warn: "#e5b84a",
  bad: "#f2707a",
  note: "#b79bf2",
  scrim: "#000000b0",
  codeSurface: "#0f1216",
  addFill: "#12301f",
  delFill: "#3a1a1f",
  selection: "#2f5fb3",
  caret: "#7fb0ff",
};

const c = DARK;

export const REGULAR_METRICS: Metrics = { target: 32, rowPad: 7, gutter: 10, bar: 30, radius: 6, caption: 26, menubar: 24, status: 20, control: 26, scrollbar: 0, captionButton: [22, 22], buttonMin: 0, thumbInset: 0, toggle: [30, 18], knob: [14, 14] };
/** a 320 x 240 or 480 x 272 surface: rows closer, the gutter narrower */
export const COMPACT_METRICS: Metrics = { ...REGULAR_METRICS, target: 26, rowPad: 5, gutter: 8, bar: 24, radius: 4, control: 22 };

const toneOf = (tone: Tone | undefined, fallback: string): string => (tone === undefined || tone === "plain" ? fallback : c[tone]);

function button(s: PartState): Paint {
  if (s.variant === "filled") {
    return { fill: s.pressed ? (s.tone === "bad" ? "#a63a44" : "#3d74d1") : s.tone === "bad" ? "#8f2f38" : c.accentFill, radius: 6, pad: [3, 10], text: "strong", ink: { text: c.onAccent } };
  }
  if (s.variant === "pill") return { fill: s.pressed ? c.selected : c.raised, border: c.line, radius: 12, shadow: 2, pad: [4, 10], text: "caption" };
  if (s.variant === "plain") return { fill: s.pressed ? c.selected : undefined, radius: 6, pad: [3, 10], text: "strong", ink: { text: toneOf(s.tone, c.accent) } };
  return { fill: s.pressed ? c.selected : c.raised, radius: 6, pad: [3, 10], text: "strong", ink: { text: toneOf(s.tone, c.accent) } };
}

export const POCKET_THEME = defineTheme({
  id: "pocket",
  label: "Pocket",
  scheme: "dark",
  color: c,
  face: FACES,
  metric: REGULAR_METRICS,
  compact: COMPACT_METRICS,
  traits: {
    caption: false,
    captionControls: "trailing",
    captionTrio: false,
    titleAlign: "leading",
    commands: "bar",
    unifiedBars: false,
    actions: "heading",
    picker: "row",
    back: "label",
    scroll: "overlay",
    scrollButtons: false,
    sheets: "sheet",
    dialogCaption: false,
    defaultLast: true,
    dialogButtons: "trailing",
    rowRules: false,
    sectionCaps: true,
    focusRing: true,
    motion: "slide",
  },
  parts: {
    canvas: { fill: c.canvas },
    pane: { fill: c.surface },
    "pane.detail": { fill: c.canvas },
    sidebar: (s) => (s.variant === "panel" ? { fill: c.surface, shadow: 3, under: [{ l: 0, w: 1, fill: c.line }], pad: [0, 0, 0, 1] } : { fill: c.surface }),
    caption: { fill: c.surface, pad: [0, 8], text: "strong" },
    "caption.button": (s) => ({ fill: s.pressed ? c.selected : undefined, radius: 6 }),
    menubar: { fill: c.surface, pad: [0, 4] },
    "menubar.item": (s) => ({ fill: s.selected || s.pressed ? c.selected : undefined, radius: 4, pad: [3, 8], text: "strong" }),
    status: { fill: c.surface, pad: [0, 10], under: [{ t: 0, h: 1, fill: c.line }], ink: { text: c.muted } },
    "status.cell": {},
    bar: { fill: c.surface, pad: [0, 6, 0, 10] },
    "bar.button": (s) => ({ fill: s.pressed || s.selected ? c.selected : s.hovered && !s.disabled ? c.raised : undefined, radius: 6, pad: [5, 7], text: "strong", ink: s.disabled ? { accent: c.faint, bad: c.faint } : undefined, opacity: 1 }),
    row: (s) => ({
      fill: s.focused ? (s.selected ? "#2c3a52" : c.raised) : s.pressed ? c.raised : s.selected ? c.selected : s.hovered ? "#171b20" : undefined,
      pad: [7, 10],
      showsFocus: true,
    }),
    section: { fill: c.surface, pad: [6, 10, 3, 10], text: "caption", ink: { text: c.muted } },
    divider: { fill: c.line },
    button,
    field: (s) => ({ fill: c.canvas, border: s.tone === "good" ? c.good : s.selected ? c.accent : c.line, radius: 6, pad: [5, 8] }),
    picker: {},
    "picker.button": {},
    toggle: (s) => ({ fill: s.selected ? c.accentFill : c.raised, border: s.selected ? c.accentFill : c.line, radius: 9, pad: 2 }),
    "toggle.knob": (s) => ({ fill: s.selected ? "#ffffff" : c.muted, radius: 7 }),
    segments: { fill: c.raised, radius: 6, pad: 2 },
    segment: (s) => ({ fill: s.selected ? c.selected : s.pressed ? c.surface : undefined, radius: 4, pad: [3, 10], text: "strong", ink: { text: s.selected ? c.text : c.muted } }),
    progress: { fill: c.raised, radius: 3 },
    "progress.fill": { fill: c.accentFill, radius: 3 },
    card: (s) => ({ fill: s.pressed ? c.raised : c.surface, border: s.tone === "warn" ? c.warn : c.line, radius: 6, pad: [5, 8] }),
    well: (s) => ({ fill: c.codeSurface, border: c.line, radius: 4, pad: s.variant === "table" ? 1 : [5, 7] }),
    bubble: { fill: c.raised, radius: 8, pad: [6, 10] },
    badge: { fill: c.raised, radius: 3, pad: [1, 5], text: "caption" },
    callout: (s) => ({ fill: s.pressed ? c.surface : undefined, radius: 4 }),
    tooltip: (s) => ({ fill: s.tone === "bad" ? "#5a1f26" : c.raised, border: s.tone === "bad" ? c.bad : c.line, radius: 6, shadow: 2, pad: [5, 12], text: "strong" }),
    scrim: (s) => (s.variant === "popover" ? {} : { fill: c.scrim }),
    menu: { fill: c.surface, border: c.line, radius: 8, shadow: 3, pad: [4, 0] },
    "menu.item": (s) => ({ fill: s.focused || s.selected || s.hovered ? c.selected : s.pressed ? c.raised : undefined, pad: [8, 10], text: "strong", showsFocus: true }),
    "menu.title": (s) => (s.variant === "menu" ? { pad: [7, 10, 5, 10], text: "caption", ink: { text: c.muted } } : { pad: s.variant === "dialog" ? [12, 14, 0, 14] : [8, 10, 6, 10] }),
    separator: { fill: c.line },
    dialog: { fill: c.surface, border: c.line, radius: 8, shadow: 3 },
    "dialog.caption": { fill: c.surface, pad: [0, 8], text: "strong" },
    "dialog.body": {},
    sheet: { fill: c.surface, border: c.line, shadow: 3 },
    "scroll.track": {},
    "scroll.thumb": { fill: "#aab4c0a0", radius: 2 },
    "scroll.button": {},
    focus: { border: c.accent, borderWidth: 2, pad: 1 },
    drag: { fill: c.accentFill, radius: 6, shadow: 3, pad: [4, 9], text: "strong", ink: { text: c.onAccent } },
  },
  // a switch says "on" by where its knob is
  glyphs: (name, _size, state) => (name === "check" && state.variant === "toggle" ? NO_GLYPH : null),
});
