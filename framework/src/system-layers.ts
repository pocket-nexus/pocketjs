// System layers: guest code a product adds to an app's bundle
// (tools/build.ts --layer=<module>), mounted by render() after the app.
//
// A layer may also take the frame's input before the app sees it: an overlay
// passes the user's input through while it is open, and a layer that
// operates the app replaces that input with its own.

import type { HostOps } from "./host.ts";
import type { PointerRecord } from "./pointer.ts";

export type SystemLayer = (ops: HostOps) => (() => void) | null;

/** One frame's input as the host delivered it; a filter rewrites it in place. */
export interface FrameInput {
  buttons: number;
  touches: readonly number[] | undefined;
  hits: readonly number[] | undefined;
  surfaces: readonly number[] | undefined;
  /** The frame's pointer with its scroll; null for none. A layer that
   *  replaces the touches with its own sets it to null, so the user's hover
   *  and scrolling stay out of the app while the layer operates it. */
  pointer: PointerRecord | null | undefined;
}

export type FrameInputFilter = (input: FrameInput) => void;

const layers: SystemLayer[] = [];
let filter: FrameInputFilter | null = null;
const input: FrameInput = { buttons: 0, touches: undefined, hits: undefined, surfaces: undefined, pointer: undefined };

export function registerSystemLayer(layer: SystemLayer): void {
  if (!layers.includes(layer)) layers.push(layer);
}

export function mountSystemLayers(ops: HostOps): () => void {
  const disposers: (() => void)[] = [];
  for (const layer of layers) {
    const dispose = layer(ops);
    if (dispose) disposers.push(dispose);
  }
  return () => {
    for (const dispose of disposers.splice(0).reverse()) dispose();
    filter = null;
  };
}

export function setFrameInputFilter(next: FrameInputFilter | null): void {
  filter = next;
}

/** The frame's input after the filter, or null when no filter is set. */
export function filterFrameInput(
  buttons: number,
  touches: readonly number[] | undefined,
  hits: readonly number[] | undefined,
  surfaces: readonly number[] | undefined,
  pointer?: PointerRecord | null,
): FrameInput | null {
  if (filter === null) return null;
  input.buttons = buttons;
  input.touches = touches;
  input.hits = hits;
  input.surfaces = surfaces;
  input.pointer = pointer;
  filter(input);
  return input;
}
