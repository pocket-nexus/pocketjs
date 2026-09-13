// The resolved modality and presentation of this bundle
// (@pocketjs/framework/modality).
//
// tools/build.ts defines `__POCKET_MODALITY__` and `__POCKET_PRESENTATION__`
// from the resolved plan. A bundle built without a plan (stock demos, unit
// harnesses) reads the portable PSP shape, the same fallback `platform`
// uses for its feature map. Everything here is data the plan already
// decided: the framework never sniffs hardware at runtime to fill it.

import {
  BUTTON_GLYPHS,
  modalityMisses,
  PORTABLE_MODALITY,
  type ButtonName,
  type Modality,
  type ModalityRequirement,
  type ScreenModality,
  type ScreenRole,
} from "../../contracts/spec/modality.ts";
import type { SurfaceId } from "./display.ts";

export type {
  ButtonGlyphSet,
  ButtonName,
  Modality,
  ModalityRequirement,
  Orientation,
  PointerModality,
  ScreenModality,
  ScreenRole,
  TextModality,
  TouchModality,
} from "../../contracts/spec/modality.ts";
export { BUTTON_GLYPHS, PORTABLE_MODALITY } from "../../contracts/spec/modality.ts";

declare const __POCKET_MODALITY__: Modality | null;
declare const __POCKET_PRESENTATION__: string;

function freezeModality(value: Modality): Modality {
  return Object.freeze({
    ...value,
    screens: Object.freeze(value.screens.map((screen) => Object.freeze({ ...screen }))),
  });
}

/** The target's interaction structure this bundle was compiled for. */
export const modality: Modality = freezeModality(
  typeof __POCKET_MODALITY__ === "object" && __POCKET_MODALITY__ !== null
    ? __POCKET_MODALITY__
    : PORTABLE_MODALITY,
);

/** The manifest presentation id this bundle compiles; "default" is the
 *  baseline `app.entry`. */
export const presentation: string =
  typeof __POCKET_PRESENTATION__ === "string" && __POCKET_PRESENTATION__ ? __POCKET_PRESENTATION__ : "default";

/** The screen behind a UI surface. The auxiliary surface has no screen on
 *  single-screen targets. */
export function screen(role: ScreenRole | SurfaceId = "primary"): ScreenModality | undefined {
  return modality.screens.find((entry) => entry.role === role);
}

/** Whether a surface's screen reports contacts. */
export function surfaceHasTouch(surface: SurfaceId = "primary"): boolean {
  return screen(surface)?.touch === true;
}

/** Evaluate a manifest-shaped requirement against this bundle's modality. */
export function supports(requirement: ModalityRequirement): boolean {
  return modalityMisses(modality, requirement).length === 0;
}

/** The device-shell label for a BTN position ("○" on a PSP, "A" on a 3DS). */
export function glyph(button: ButtonName): string {
  return BUTTON_GLYPHS[modality.glyphs][button];
}
