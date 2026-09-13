// The system keyboard's device-wide memory and modality, JSX-free so unit
// tests and the journey scripter (tests/osk-script.ts) share the exact
// rules the panel runs.
//
// A device has one system keyboard. Closing and reopening it — from any
// field, any screen — returns to the layer and key the user left, the way
// the hardware's own keyboard would. The memory is per layout kind, because
// a key position on the grid means nothing on the staggered rows.

import type { SurfaceId } from "./display.ts";
import { surfaceHasTouch } from "./modality.ts";
import { homePos, layoutRows, oskLayer, OSK_HOME_LAYER, type OskLayerName, type OskLayoutKind, type OskPos } from "./osk-layout.ts";

export interface OskPanelMemory {
  layer: OskLayerName;
  pos: OskPos;
}

const memories = new Map<OskLayoutKind, OskPanelMemory>();

/** The layer and key the keyboard reopens on for a layout. First open: the
 *  home layer with focus on 'q'. */
export function recallPanel(kind: OskLayoutKind, innerWidth: number): OskPanelMemory {
  const remembered = memories.get(kind);
  if (remembered) return { layer: remembered.layer, pos: { ...remembered.pos } };
  return { layer: OSK_HOME_LAYER, pos: homePos(layoutRows(oskLayer(kind, OSK_HOME_LAYER), innerWidth)) };
}

export function rememberPanel(kind: OskLayoutKind, memory: OskPanelMemory): void {
  memories.set(kind, { layer: memory.layer, pos: { ...memory.pos } });
}

/** Forget every remembered position (a fresh world in tests). */
export function resetPanelMemory(): void {
  memories.clear();
}

export interface OskModality {
  /** Contacts land on the keyboard's surface: the staggered layout and the
   *  contact press model. */
  readonly contact: boolean;
  /** A d-pad exists: the focus adapter and the chords. Every stock target
   *  has buttons; the flag exists so a pure-touch host reads as one. */
  readonly focus: boolean;
  readonly layout: OskLayoutKind;
}

/** How the keyboard is driven on a surface. The layout follows the surface's
 *  contacts unless the caller fixes one. */
export function resolveOskModality(surface: SurfaceId, buttons: boolean, layout?: OskLayoutKind): OskModality {
  const contact = surfaceHasTouch(surface);
  return { contact, focus: buttons, layout: layout ?? (contact ? "staggered" : "grid") };
}
