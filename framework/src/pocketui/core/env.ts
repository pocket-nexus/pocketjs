// PocketUI core/env.ts — what a surface can do, and which idiom each of an
// application's semantics takes there.
//
// An application says what it is made of: panes that relate as list and
// detail, commands, a feed that grows, a place to compose text, things that
// can be moved onto other things. It does not say "three columns", "a
// toolbar", "drag". Those are idioms, and a surface gets the idiom it can
// carry out in full:
//
//   a 618 x 304 window with a trackpad, a gamepad and a keyboard on the
//   panel below shows list and detail side by side, moves a thing by
//   dragging it and types in place;
//   a 480 x 272 screen with a d-pad and six buttons shows one pane at a
//   time, names every command in a legend, moves a thing by picking it up
//   with a button and putting it down, and composes on a keyboard it draws;
//   a 320 x 240 touch panel does the same with taps, in tighter rows.
//
// The rule for choosing is completeness, not resemblance: an idiom is picked
// only when every step of it has an input on that surface. A surface without
// a pointer never gets a control that needs hovering; one without a keyboard
// never gets a command that exists only as a shortcut.
//
// Environment is facts (derived from PocketJS's modality and the surface's
// size). Idioms is choices (derived from Environment by `resolveIdioms`, and
// an application may override a choice for itself).

/** Horizontal room: how many panes fit side by side. */
export type WidthClass = "compact" | "regular" | "expanded" | "wide";
export type HeightClass = "compact" | "regular";

export interface Environment {
  /** the surface, in points */
  surface: { width: number; height: number };
  size: { width: WidthClass; height: HeightClass };
  input: {
    /** contacts land on the surface (a finger, or a pointer the host turns into contacts) */
    touch: boolean;
    /** a pointer that hovers: a mouse, a trackball */
    pointer: boolean;
    /** a d-pad and face buttons */
    buttons: boolean;
    /** analog sticks */
    analog: number;
    /** physical keys that type */
    keyboard: boolean;
  };
  /** Where typed text comes from: `keyboard` keys under the fingers; `host`
   *  a keyboard the host shows off the surface while a field is open (a
   *  handheld's lower panel, a phone's own); `osk` a keyboard the app draws
   *  on its own surface and gives up room for. */
  text: "keyboard" | "host" | "osk";
  /** scripts beyond the baked faces can be drawn (a glyphs service answers) */
  glyphs: "baked" | "runtime";
  /** what a changed frame costs: every frame, a repaint, or a still panel */
  motion: "composited" | "repaint" | "still";
  /** how much the realm can hold and compute: a microcontroller, a 2005
   *  handheld, or a phone-class processor */
  tier: "micro" | "retro" | "full";
}

export interface SurfaceFacts {
  width: number;
  height: number;
  touch: boolean;
  buttons: boolean;
  pointer: boolean;
  keyboard: boolean;
  analog: number;
  /** PocketJS's target form */
  form?: string;
  /** the host shows a keyboard of its own while a text session is open */
  hostKeyboard?: boolean;
  motion?: Environment["motion"];
  tier?: Environment["tier"];
  glyphs?: Environment["glyphs"];
}

export const WIDTH_BREAKS = { regular: 420, expanded: 560, wide: 840 } as const;
export const HEIGHT_BREAK = 288;

export function widthClass(width: number): WidthClass {
  if (width >= WIDTH_BREAKS.wide) return "wide";
  if (width >= WIDTH_BREAKS.expanded) return "expanded";
  if (width >= WIDTH_BREAKS.regular) return "regular";
  return "compact";
}

export function deriveEnvironment(facts: SurfaceFacts): Environment {
  const motion = facts.motion ?? "composited";
  // a still or repainting panel, or a 320 x 240 surface, is the small end
  const tier = facts.tier ?? (motion === "still" ? "micro" : facts.width * facts.height <= 480 * 272 ? "retro" : "full");
  return {
    surface: { width: facts.width, height: facts.height },
    size: { width: widthClass(facts.width), height: facts.height >= HEIGHT_BREAK ? "regular" : "compact" },
    input: { touch: facts.touch, pointer: facts.pointer, buttons: facts.buttons, analog: facts.analog, keyboard: facts.keyboard },
    text: facts.keyboard ? "keyboard" : facts.hostKeyboard ? "host" : "osk",
    glyphs: facts.glyphs ?? "baked",
    motion,
    tier,
  };
}

// ---------------------------------------------------------------------------
// Idioms
// ---------------------------------------------------------------------------

export interface Idioms {
  /** Panes: `stack` one at a time with a way back; `split` list beside
   *  detail; `triple` list, detail and an inspector. */
  panes: "stack" | "split" | "triple";
  /** The d-pad moves a focus and a ring shows where it is. */
  focus: boolean;
  /** Commands:
   *   `legend`     a strip naming what each button does now
   *   `bar`        visible controls in the pane's bar
   *   `shortcuts`  key chords, listed in the menu beside their commands
   *   `menu`       where the commands that are not on screen are listed:
   *                a sheet from the bottom edge, a popover beside its button */
  commands: { legend: boolean; bar: boolean; shortcuts: boolean; menu: "sheet" | "popover" };
  /** Composing text: `inline` the field stays where it is and takes the
   *  keys; `dock` the field and a keyboard the app draws take the bottom of
   *  the surface while it is open. */
  compose: "inline" | "dock";
  /** Moving a thing onto another: `drag` follow the contact from a long
   *  press and drop on release; `carry` pick up with a button, move the
   *  focus, put down with the same button. Both end in the same drop. */
  transfer: "drag" | "carry";
  /** A change of pane: `follow` tracks the contact and can be let go either
   *  way; `animate` plays and can be reversed by the opposite command while
   *  it plays; `cut` is the next frame. */
  transition: "follow" | "animate" | "cut";
  /** Rows and gutters. */
  density: "compact" | "regular";
  /** How many feed rows are kept mounted around the window, in screens. */
  overscan: number;
  /** Rich content: `full` code blocks, tables and diffs drawn as such;
   *  `plain` their text, in the body face. */
  content: "full" | "plain";
}

export function resolveIdioms(env: Environment): Idioms {
  const { input, size } = env;
  const direct = input.touch || input.pointer;
  return {
    panes: size.width === "wide" ? "triple" : size.width === "expanded" ? "split" : "stack",
    focus: input.buttons,
    commands: {
      // a legend names buttons, so it needs buttons, and room: where touch is
      // the way in and the surface is short, the bar's controls say it all
      legend: input.buttons && !(direct && size.height === "compact" && size.width === "compact"),
      bar: direct,
      shortcuts: input.keyboard,
      menu: input.pointer && size.width !== "compact" ? "popover" : "sheet",
    },
    compose: env.text === "osk" ? "dock" : "inline",
    transfer: direct ? "drag" : "carry",
    transition: env.motion !== "composited" ? "cut" : direct ? "follow" : "animate",
    density: size.width === "compact" || size.height === "compact" ? "compact" : "regular",
    overscan: env.tier === "full" ? 1 : 0.5,
    content: env.tier === "micro" ? "plain" : "full",
  };
}
