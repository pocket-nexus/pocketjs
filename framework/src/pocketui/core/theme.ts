// PocketUI core/theme.ts — what a theme is.
//
// An application written with PocketUI says what its interface is: a pane
// with a bar, rows, a selected row, a default button, a field, a menu. It
// names no colour, no border and no font. A Theme answers, for each of those
// semantic PARTS in each STATE, with a Paint; with the metrics that size the
// parts; with the type ramp; with the marks (a close box, a check, a
// chevron); and with TRAITS, the arrangement choices that differ between
// interface traditions (is there a title bar and where are its controls, do
// commands sit in a menu bar or a toolbar, is a scroll bar a strip with
// arrows or a thumb that fades, does the default button come last).
//
// The same tree, the same state and the same focus are painted by whichever
// theme is active; changing it (ui.setTheme) relays out and repaints in
// place. Nothing in an application or in the kit asks which theme it is.
//
// The type ramp is short on purpose. PocketJS bakes one atlas per font slot a
// bundle names, at the target's raster density, and an applet's pack is at
// most 3 MiB: at density 3 a 12 px slot is about 220 KiB, so five baked slots
// are about 1.1 MiB. Text from the network in other scripts draws from two
// run-time slots a glyph service fills (ui/runtimetext.ts).

/** A face: the font slot and the line it sets. */
export interface Face {
  slot: number;
  /** nominal size in points */
  size: number;
  /** distance between baselines */
  line: number;
  bold?: boolean;
  mono?: boolean;
}

export type TextRole = "body" | "strong" | "title" | "caption" | "mono";

// The class literals below make the compiler bake each slot the ramp names
// (framework/compiler/tailwind.ts fontSlotFor): 12 px, 12 px bold, 14 px
// bold, 12 px monospace and 10 px.
const BAKED = ["text-xs", "text-xs font-bold", "text-sm font-bold", "text-xs font-mono", "text-2xs"];
void BAKED;

export const FACES: Readonly<Record<TextRole, Face>> = {
  body: { slot: 0, size: 12, line: 17 },
  strong: { slot: 7, size: 12, line: 17, bold: true },
  title: { slot: 8, size: 14, line: 20, bold: true },
  caption: { slot: 19, size: 10, line: 13 },
  mono: { slot: 16, size: 12, line: 16, mono: true },
};

/** The pixel face (tools/pixel-font.ts): an 8-point bitmap sans, one font
 *  pixel to a logical pixel, regular in slot 20 and bold in slot 23. It is
 *  in an application's pack only when its pak.json names the two atlases
 *  (README, "The pixel face"); a theme takes it through `withFaces`. Code
 *  stays in the baked monospace. */
export const PIXEL_FACES: Readonly<Record<TextRole, Face>> = {
  body: { slot: 20, size: 11, line: 14 },
  strong: { slot: 23, size: 11, line: 14, bold: true },
  title: { slot: 23, size: 11, line: 14, bold: true },
  caption: { slot: 20, size: 11, line: 13 },
  mono: FACES.mono,
};

/** The run-time faces: any script, 13 px, loaded by ui/runtimetext.ts. */
export const RICH_FACE: Face = { slot: 21, size: 13, line: 18 };
export const RICH_BOLD_FACE: Face = { slot: 22, size: 13, line: 18, bold: true };

// ---------------------------------------------------------------------------
// Colour
// ---------------------------------------------------------------------------

/** What a text or a mark means, not what colour it is: the part it sits in
 *  and the theme decide that (a muted line on a selected row is not the
 *  muted line of the pane). */
export type Tone = "plain" | "muted" | "faint" | "accent" | "good" | "warn" | "bad" | "note";

/** The colours of content, by meaning. A part may replace any of them for what is inside it. */
export interface Ink {
  text: string;
  muted: string;
  faint: string;
  accent: string;
  good: string;
  warn: string;
  bad: string;
  note: string;
}

/** A theme's content colours: the ink of a plain pane, and the grounds content is set on. */
export interface Palette extends Ink {
  /** the surface behind everything */
  canvas: string;
  /** a pane, a bar */
  surface: string;
  /** a card, a field, a pressed row */
  raised: string;
  /** a selected row */
  selected: string;
  line: string;
  accentFill: string;
  onAccent: string;
  /** behind a sheet */
  scrim: string;
  /** code and diffs */
  codeSurface: string;
  addFill: string;
  delFill: string;
  /** selected text in a field */
  selection: string;
  caret: string;
}

// ---------------------------------------------------------------------------
// Paint
// ---------------------------------------------------------------------------

/** Two nested rings, each light on the top and left and dark on the bottom
 *  and right: the edge of period chrome. `width` is each ring's. */
export interface Bevel {
  outerLight: string;
  outerDark: string;
  innerLight?: string;
  innerDark?: string;
  width?: number;
}

/** What fills a rectangle. */
export interface Fill {
  fill?: string;
  /** top to bottom unless `gradientDir` says otherwise; three colours put the middle one at `gradientMid` (default 0.5) */
  gradient?: readonly [string, string] | readonly [string, string, string];
  gradientDir?: "down" | "up" | "left" | "right";
  gradientMid?: number;
  border?: string;
  borderWidth?: number;
  bevel?: Bevel;
  radius?: number;
  opacity?: number;
}

/** A rectangle painted under a part's content: a highlight strip, a gloss, a
 *  second ring. Each side given is a distance from that edge of the part; a
 *  side left out is free, and then `w` or `h` sizes it. `hFrac` sizes it as a
 *  share of the part's height instead (a gloss over the top half). */
export interface Layer extends Fill {
  l?: number;
  t?: number;
  r?: number;
  b?: number;
  w?: number;
  h?: number;
  hFrac?: number;
}

/** What a part looks like in one state. */
export interface Paint extends Fill {
  shadow?: 0 | 1 | 2 | 3;
  /** painted over the fill and under the content, first to last */
  under?: readonly Layer[];
  /** the ink of what is inside, where it differs from the theme's */
  ink?: Partial<Ink>;
  /** the face a Text inside takes when it names none */
  text?: TextRole;
  /** the room between the part's edge and its content, when the element gives none: all sides, [vertical, horizontal] or [top, right, bottom, left] */
  pad?: number | readonly [number, number] | readonly [number, number, number, number];
  /** the content moved by this much: a pressed button's label sinks with it */
  nudge?: readonly [number, number];
  /** this paint shows that the part has the focus: the focus ring stays away */
  showsFocus?: boolean;
}

/** The semantic parts a theme paints. */
export const PARTS = [
  // grounds
  "canvas",
  "pane",
  "pane.detail",
  "sidebar",
  // the application's frame
  "caption",
  "caption.button",
  "menubar",
  "menubar.item",
  "status",
  "status.cell",
  // a pane's own
  "bar",
  "bar.button",
  "row",
  "section",
  "divider",
  // controls
  "button",
  "field",
  "picker",
  "picker.button",
  "check",
  "radio",
  "toggle",
  "toggle.knob",
  "segments",
  "segment",
  "progress",
  "progress.fill",
  // content
  "card",
  "well",
  "bubble",
  "badge",
  "callout",
  "tooltip",
  // what is presented over the application
  "scrim",
  "menu",
  "menu.item",
  "menu.title",
  "separator",
  "dialog",
  "dialog.caption",
  "dialog.body",
  "sheet",
  // scrolling
  "scroll.track",
  "scroll.thumb",
  "scroll.button",
  // marks of state
  "focus",
  "drag",
] as const;
export type Part = (typeof PARTS)[number];

/** The state a part is painted in. */
export interface PartState {
  pressed: boolean;
  focused: boolean;
  /** a pointer rests on it (a surface without a pointer never says so) */
  hovered: boolean;
  disabled: boolean;
  /** the row that is open, the tab that shows, the toggle that is on */
  selected: boolean;
  /** the frame this is part of has the input (a title bar dims without it) */
  active: boolean;
  /** which of a part's kinds: a button's "filled" | "tinted" | "plain", a bubble's "self" | "other", a caption button's "close" */
  variant: string | undefined;
  tone: Tone | undefined;
}

export const REST: PartState = { pressed: false, focused: false, hovered: false, disabled: false, selected: false, active: true, variant: undefined, tone: undefined };

// ---------------------------------------------------------------------------
// Marks
// ---------------------------------------------------------------------------

export const GLYPHS = ["close", "back", "forward", "up", "down", "left", "right", "disclosure", "check", "dot", "more", "menu", "minimize", "zoom", "plus", "grip", "updown"] as const;
export type GlyphName = (typeof GLYPHS)[number];

/** One rectangle of a mark, in the mark's own points. `r` rounds it (half the
 *  side makes a disc), `rot` turns it about its centre, `ring` strokes its
 *  outline that thick instead of filling it. No `color`: the ink it is drawn in. */
export interface GlyphShape {
  x: number;
  y: number;
  w: number;
  h: number;
  r?: number;
  rot?: number;
  ring?: number;
  /** a triangle in place of the rectangle, its three corners in the mark's points: x, y, w, h are then its box */
  tri?: readonly [number, number, number, number, number, number];
  color?: string;
  gradient?: readonly [string, string];
  opacity?: number;
}

export interface GlyphArt {
  w: number;
  h: number;
  shapes: readonly GlyphShape[];
}

// ---------------------------------------------------------------------------
// Metrics and traits
// ---------------------------------------------------------------------------

export interface Metrics {
  /** the smallest thing a finger or a pointer is asked to hit */
  target: number;
  /** a list row's vertical padding */
  rowPad: number;
  /** the gutter inside a pane */
  gutter: number;
  /** a pane's bar */
  bar: number;
  radius: number;
  /** the application's and a dialog's title bar */
  caption: number;
  menubar: number;
  /** the strip at the bottom of the frame */
  status: number;
  /** a push button */
  control: number;
  /** a scroll bar's width where it is a strip */
  scrollbar: number;
  /** a title bar's control: width, height */
  captionButton: readonly [number, number];
  /** the least width of a push button with a label: a row of them reads as a set */
  buttonMin: number;
  /** how far a scroll bar's thumb sits inside its strip, each side */
  thumbInset: number;
  /** an on/off control: a switch's track or a check box, and the knob or the mark inside it */
  toggle: readonly [number, number];
  knob: readonly [number, number];
}

/** The arrangement choices of an interface tradition. */
export interface Traits {
  /** the application's frame has a title bar of its own */
  caption: boolean;
  /** which end of a title bar its controls sit at */
  captionControls: "leading" | "trailing";
  /** a title bar shows all three of close, minimize and zoom, the ones that do nothing here drawn disabled; otherwise only the ones that do something */
  captionTrio: boolean;
  /** where a title bar's and a pane bar's title sits */
  titleAlign: "leading" | "center";
  /** where commands are offered when there is a pointer or a finger: controls in the pane's bar with the rest behind "more", or a menu bar across the frame with the bar's controls beside it */
  commands: "bar" | "menubar";
  /** the title bar and the panes' bars read as one surface: every pane has a bar, all of one height, whether or not it has a title */
  unifiedBars: boolean;
  /** what a task or a dialog does, and the way out of it: a row of push buttons at its foot, or the way out named beside its heading and the thing to do as one wide button under the content */
  actions: "footer" | "heading";
  /** one choice of several: a row that opens the list of them, or its name beside a control that pops the list up */
  picker: "row" | "popup";
  /** how going back is offered in a bar */
  back: "label" | "glyph";
  /** a scroll bar is a thumb over the content that shows while it moves, or a strip beside it */
  scroll: "overlay" | "strip";
  /** a strip has a button at each end */
  scrollButtons: boolean;
  /** a task or a list of choices presented over the application rises from the bottom edge, or opens as a window in the middle */
  sheets: "sheet" | "window";
  /** a dialog has a title bar */
  dialogCaption: boolean;
  /** the button that does the thing comes after Cancel (the trailing end), or before it */
  defaultLast: boolean;
  /** dialogs' buttons sit at the trailing end, or in the middle */
  dialogButtons: "trailing" | "center";
  /** a rule between rows */
  rowRules: boolean;
  /** section headings in capitals */
  sectionCaps: boolean;
  /** the focus shows as a ring over the focused part; parts also get `focused` in their state either way */
  focusRing: boolean;
  /** how one pane replaces another, where the surface can animate */
  motion: "slide" | "cut";
}

export interface Theme {
  id: string;
  label: string;
  scheme: "dark" | "light";
  color: Palette;
  face: Readonly<Record<TextRole, Face>>;
  metric: Metrics;
  /** rows closer and the gutter narrower: a 320 x 240 or 480 x 272 surface */
  compact: Metrics;
  traits: Traits;
  /** What `part` looks like in `state`. A part the theme does not paint returns an empty Paint. */
  paint(part: Part, state: PartState): Paint;
  /** The art of a mark at about `size` points, or null where the theme shows the mark's name instead. */
  glyph(name: GlyphName, size: number, state: PartState): GlyphArt | null;
}

const NOTHING: Paint = {};

/** A theme from a table of parts: each a Paint, or a function of the state. */
export function defineTheme(spec: Omit<Theme, "paint" | "glyph"> & { parts: Partial<Record<Part, Paint | ((state: PartState) => Paint)>>; glyphs?: (name: GlyphName, size: number, state: PartState) => GlyphArt | null }): Theme {
  const { parts, glyphs, ...rest } = spec;
  return {
    ...rest,
    paint(part, state) {
      const entry = parts[part];
      if (!entry) return NOTHING;
      return typeof entry === "function" ? entry(state) : entry;
    },
    glyph: glyphs ?? (() => null),
  };
}

/** `theme` set in other faces: the same parts and traits, another type ramp. */
export function withFaces(theme: Theme, face: Readonly<Record<TextRole, Face>>, as?: { id?: string; label?: string }): Theme {
  return { ...theme, face, id: as?.id ?? theme.id, label: as?.label ?? theme.label };
}

/** The ink for `tone` from a paint's own, else the theme's. */
export function inkOf(tone: Tone | undefined, ink: Partial<Ink> | undefined, palette: Palette): string {
  const key = tone === undefined || tone === "plain" ? "text" : tone;
  return ink?.[key] ?? palette[key];
}
