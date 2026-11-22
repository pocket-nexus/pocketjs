// PocketUI ui/caption.ts — a title bar: of the application's frame, where
// the theme's tradition gives it one, and of a dialog.
//
// What it holds is semantic: a title, and controls that each do one thing
// (close this). Where the title sits, which end the controls are at, what a
// control looks like and whether the ones that do nothing here are drawn at
// all are the theme's (theme.ts Traits). A control that does nothing is
// drawn disabled or not drawn; it is never a decoration that takes a press.
import { element, HSTACK, ZSTACK, type UIElement, type UINode } from "./engine.ts";
import { GLYPH } from "./glyph.ts";
import type { UI } from "./mount.ts";
import { TEXT } from "./textview.ts";
import type { GlyphName, Part } from "./theme.ts";

export interface CaptionOptions {
  part: "caption" | "dialog.caption";
  title: () => string;
  /** the frame has the input (default true) */
  active?: () => boolean;
  /** what the close control does now, or undefined while there is nothing to close: the control is drawn disabled then. Left out: the bar has no close control (a theme that always shows all three draws it disabled) */
  close?: () => (() => void) | undefined;
  /** shown between the title and the controls: a status, a count */
  accessory?: UINode;
}

const TRIO: readonly { variant: "close" | "minimize" | "zoom"; glyph: GlyphName }[] = [
  { variant: "close", glyph: "close" },
  { variant: "minimize", glyph: "minimize" },
  { variant: "zoom", glyph: "zoom" },
];

/** A title bar for the active theme. Its children are made again when the theme changes: it holds no state. */
export function caption(ui: UI, options: CaptionOptions): UIElement {
  const active = () => options.active?.() !== false;
  const control = (variant: "close" | "minimize" | "zoom", glyph: GlyphName, run: (() => (() => void) | undefined) | undefined): UIElement => {
    const [w, h] = ui.theme.metric.captionButton;
    const dead = () => run?.() === undefined;
    return element(ZSTACK, {
      name: `caption.${variant}`,
      part: "caption.button" as Part,
      variant,
      width: w,
      height: h,
      get disabled() {
        return dead();
      },
      // a title bar's controls are the pointer's; the pad has Back
      focusable: false,
      onPress: () => run?.()?.(),
      get active() {
        return active();
      },
      children: element(GLYPH, { glyph, size: Math.min(w, h) - 6, anchor: "center", get state() { return { variant: "caption", disabled: dead() }; } }) as UINode,
    });
  };
  return element(HSTACK, {
    name: options.part,
    part: options.part,
    get height() {
      return ui.metric().caption;
    },
    get active() {
      return active();
    },
    get children() {
      const traits = ui.theme.traits;
      const controls: UIElement[] = [];
      if (traits.captionTrio) {
        for (const entry of TRIO) controls.push(control(entry.variant, entry.glyph, entry.variant === "close" ? options.close : undefined));
      } else if (options.close) controls.push(control("close", "close", options.close));
      const cluster = controls.length > 0 ? element(HSTACK, { spacing: traits.captionTrio ? 6 : 2, children: controls as UINode }) : null;
      const width = controls.length * ui.theme.metric.captionButton[0] + Math.max(0, controls.length - 1) * (traits.captionTrio ? 6 : 2);
      const title = element(TEXT, {
        grow: 1,
        lines: 1,
        align: traits.titleAlign === "center" ? "center" : "left",
        get value() {
          return options.title();
        },
      });
      // a centred title stays on the bar's midline: the room the controls take at one end is matched at the other
      const balance = traits.titleAlign === "center" && width > 0 ? element(HSTACK, { width }) : null;
      const row: (UIElement | null | UINode)[] =
        traits.captionControls === "leading" ? [cluster, title, options.accessory ?? balance] : [options.accessory ? null : balance, title, options.accessory, cluster];
      return row.filter((entry) => entry != null) as UINode;
    },
  });
}
