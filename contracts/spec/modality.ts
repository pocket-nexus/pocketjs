// PocketJS modality: the interaction structure of a target, read off its
// profile.
//
// A capability id names one framework behavior a host implements. A
// modality is the shape those behaviors add up to on one device: how many
// screens, which of them takes contacts, whether a d-pad and sticks exist,
// where text comes from, how large the primary screen is. Nothing registers
// a modality. `deriveModality` is a pure function of a TargetProfile, so the
// registry stays an inventory of hosts and this file stays a view over it.
//
// Applications consume the modality in two places:
//   - pocket.json `app.presentations[].modality` is a REQUIREMENT the
//     resolver tests against the target's derived modality to pick which
//     presentation (entry module) a build compiles;
//   - `@pocketjs/framework/modality` exposes the resolved description to the
//     chosen presentation for the smaller, in-module adaptations.

import type { JsonSchema } from "./pocket-manifest.ts";
import type { TargetForm, TargetProfile, Viewport } from "./platforms.ts";
import { DYNAMIC_FORMS, TARGET_FORMS } from "./platforms.ts";

export const SCREEN_ROLES = ["primary", "auxiliary"] as const;
export type ScreenRole = (typeof SCREEN_ROLES)[number];

export const ORIENTATIONS = ["landscape", "portrait", "square"] as const;
export type Orientation = (typeof ORIENTATIONS)[number];

/** Which screen reports contacts. One device reports on one screen. */
export const TOUCH_MODALITIES = ["none", "primary", "auxiliary"] as const;
export type TouchModality = (typeof TOUCH_MODALITIES)[number];

/** `cursor` is the framework-synthesized nub pointer (input.cursor);
 *  `pointer` is a real absolute pointer (input.pointer). */
export const POINTER_MODALITIES = ["none", "cursor", "pointer"] as const;
export type PointerModality = (typeof POINTER_MODALITIES)[number];

/** `keyboard` is a hardware text stream (input.text); `osk` means the
 *  system on-screen keyboard is the only text entry. */
export const TEXT_MODALITIES = ["osk", "keyboard"] as const;
export type TextModality = (typeof TEXT_MODALITIES)[number];

/** How the face buttons are labelled on the device shell. */
export const BUTTON_GLYPH_SETS = ["playstation", "letters"] as const;
export type ButtonGlyphSet = (typeof BUTTON_GLYPH_SETS)[number];

export const BUTTON_NAMES = [
  "circle",
  "cross",
  "triangle",
  "square",
  "start",
  "select",
  "ltrigger",
  "rtrigger",
] as const;
export type ButtonName = (typeof BUTTON_NAMES)[number];

/** Shell labels per BTN bit, keyed by the spec's PlayStation-positional
 *  names. A Nintendo host maps A/B/X/Y onto the CIRCLE/CROSS/TRIANGLE/SQUARE
 *  positions (hosts/3ds/src/input.c), so `circle` reads "A" there. */
export const BUTTON_GLYPHS: Readonly<Record<ButtonGlyphSet, Readonly<Record<ButtonName, string>>>> = {
  playstation: {
    circle: "○",
    cross: "×",
    triangle: "△",
    square: "□",
    start: "START",
    select: "SELECT",
    ltrigger: "L",
    rtrigger: "R",
  },
  letters: {
    circle: "A",
    cross: "B",
    triangle: "X",
    square: "Y",
    start: "START",
    select: "SELECT",
    ltrigger: "L",
    rtrigger: "R",
  },
};

export interface ScreenModality {
  readonly role: ScreenRole;
  /** Logical size the target presents on this screen at its raster density.
   *  Dynamic forms report the profile's default window size. */
  readonly logical: Viewport;
  readonly orientation: Orientation;
  /** Contacts are reported in this screen's logical pixels. */
  readonly touch: boolean;
  /** The logical size is a runtime variable (display.viewport.live). */
  readonly resizable: boolean;
}

export interface Modality {
  readonly form: TargetForm;
  /** Primary first, then the auxiliary screen when the target has one. */
  readonly screens: readonly ScreenModality[];
  readonly touch: TouchModality;
  readonly pointer: PointerModality;
  /** A d-pad and face buttons (input.buttons). */
  readonly buttons: boolean;
  /** Analog sticks the host reports (input.analog.left / .right). */
  readonly analog: 0 | 1 | 2;
  readonly text: TextModality;
  readonly glyphs: ButtonGlyphSet;
}

function orientationOf(viewport: Viewport): Orientation {
  if (viewport[0] > viewport[1]) return "landscape";
  if (viewport[0] < viewport[1]) return "portrait";
  return "square";
}

/** The logical size a fixed screen presents at its native density. Falls
 *  back to the profile's first logical viewport when the panel is not an
 *  integer multiple of a logical pixel. */
function nativeLogical(physical: Viewport, rasterDensity: number, logicalViewports: readonly Viewport[]): Viewport {
  const w = physical[0] / rasterDensity;
  const h = physical[1] / rasterDensity;
  if (Number.isInteger(w) && Number.isInteger(h) && w > 0 && h > 0) return [w, h];
  return [logicalViewports[0][0], logicalViewports[0][1]];
}

/** Read a target's modality off its profile. Pure: same profile, same value. */
export function deriveModality(profile: TargetProfile): Modality {
  const has = (id: string): boolean => profile.capabilities.includes(id);
  const resizable = DYNAMIC_FORMS.includes(profile.form);
  const display = profile.display;
  const primaryLogical: Viewport = resizable
    ? [display.logicalViewports[0][0], display.logicalViewports[0][1]]
    : nativeLogical(display.physicalViewport, display.rasterDensity, display.logicalViewports);
  const primaryTouch = has("input.touch");
  const screens: ScreenModality[] = [
    {
      role: "primary",
      logical: primaryLogical,
      orientation: orientationOf(primaryLogical),
      touch: primaryTouch,
      resizable,
    },
  ];
  const auxiliary = display.auxiliary;
  const auxiliaryTouch = has("input.touch.auxiliary");
  if (auxiliary && has("display.auxiliary")) {
    const logical = nativeLogical(auxiliary.physicalViewport, auxiliary.rasterDensity, auxiliary.logicalViewports);
    screens.push({
      role: "auxiliary",
      logical,
      orientation: orientationOf(logical),
      touch: auxiliaryTouch,
      resizable: false,
    });
  }
  const analog = (has("input.analog.left") ? 1 : 0) + (has("input.analog.right") ? 1 : 0);
  return {
    form: profile.form,
    screens,
    touch: primaryTouch ? "primary" : auxiliaryTouch && screens.length > 1 ? "auxiliary" : "none",
    pointer: has("input.pointer") ? "pointer" : has("input.cursor") ? "cursor" : "none",
    buttons: has("input.buttons"),
    analog: analog as 0 | 1 | 2,
    text: has("input.text") ? "keyboard" : "osk",
    glyphs: profile.platform === "psp" || profile.platform === "vita" ? "playstation" : "letters",
  };
}

/**
 * What a presentation asks of a device. Every field is optional; an absent
 * field matches every device. `minScreen`/`maxScreen` bound the PRIMARY
 * screen's logical size on both axes, inclusive.
 */
export interface ModalityRequirement {
  /** Exact screen count. */
  readonly screens?: number;
  readonly touch?: TouchModality | "any";
  readonly pointer?: PointerModality | "any";
  readonly buttons?: boolean;
  /** Minimum number of analog sticks. */
  readonly analog?: number;
  readonly text?: TextModality;
  /** Orientation of the primary screen. */
  readonly orientation?: Orientation;
  readonly minScreen?: Viewport;
  readonly maxScreen?: Viewport;
  readonly form?: readonly TargetForm[];
}

/**
 * The requirement fields a modality fails, in declaration order; an empty
 * array is a match. The resolver reports these names in diagnostics and the
 * runtime answers `supports()` with their absence.
 */
export function modalityMisses(modality: Modality, requirement: ModalityRequirement): readonly string[] {
  const misses: string[] = [];
  const primary = modality.screens[0];
  if (requirement.screens !== undefined && modality.screens.length !== requirement.screens) misses.push("screens");
  if (requirement.touch !== undefined) {
    if (requirement.touch === "any" ? modality.touch === "none" : modality.touch !== requirement.touch) misses.push("touch");
  }
  if (requirement.pointer !== undefined) {
    if (requirement.pointer === "any" ? modality.pointer === "none" : modality.pointer !== requirement.pointer) misses.push("pointer");
  }
  if (requirement.buttons !== undefined && modality.buttons !== requirement.buttons) misses.push("buttons");
  if (requirement.analog !== undefined && modality.analog < requirement.analog) misses.push("analog");
  if (requirement.text !== undefined && modality.text !== requirement.text) misses.push("text");
  if (requirement.orientation !== undefined && primary.orientation !== requirement.orientation) misses.push("orientation");
  if (requirement.minScreen && (primary.logical[0] < requirement.minScreen[0] || primary.logical[1] < requirement.minScreen[1])) {
    misses.push("minScreen");
  }
  if (requirement.maxScreen && (primary.logical[0] > requirement.maxScreen[0] || primary.logical[1] > requirement.maxScreen[1])) {
    misses.push("maxScreen");
  }
  if (requirement.form && !requirement.form.includes(modality.form)) misses.push("form");
  return misses;
}

export function matchesModality(modality: Modality, requirement: ModalityRequirement): boolean {
  return modalityMisses(modality, requirement).length === 0;
}

const viewportSchema = {
  type: "array",
  items: { type: "integer", minimum: 1 },
  minItems: 2,
  maxItems: 2,
} as const satisfies JsonSchema;

/** The `modality` block of a manifest presentation. */
export const modalityRequirementSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    screens: { type: "integer", minimum: 1, maximum: 2 },
    touch: { enum: [...TOUCH_MODALITIES, "any"] },
    pointer: { enum: [...POINTER_MODALITIES, "any"] },
    buttons: { type: "boolean" },
    analog: { type: "integer", minimum: 0, maximum: 2 },
    text: { enum: TEXT_MODALITIES },
    orientation: { enum: ORIENTATIONS },
    minScreen: viewportSchema,
    maxScreen: viewportSchema,
    form: {
      type: "array",
      items: { enum: TARGET_FORMS },
      minItems: 1,
      uniqueItems: true,
    },
  },
} as const satisfies JsonSchema;

/**
 * The modality of a build compiled without a resolved plan: the portable
 * PSP shape every stock demo targets. `deriveModality(POCKET_TARGETS.psp)`
 * must equal this value (tests/modality.test.ts pins it), and the runtime
 * module falls back to it so non-manifest builds keep one answer.
 */
export const PORTABLE_MODALITY: Modality = {
  form: "takeover",
  screens: [
    { role: "primary", logical: [480, 272], orientation: "landscape", touch: false, resizable: false },
  ],
  touch: "none",
  pointer: "cursor",
  buttons: true,
  analog: 1,
  text: "osk",
  glyphs: "playstation",
};
