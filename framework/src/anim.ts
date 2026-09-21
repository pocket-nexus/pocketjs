// Typed animation API over ops.animate — JS declares motion once, the Rust
// core ticks it per vblank at fixed dt = 1/60 s (byte-exact goldens [R]).
//
// Prop names are the spec PROP keys (contracts/spec/spec.ts is plain TS and bundles
// fine); only ANIMATABLE props are accepted. Colors animate per ABGR channel
// natively — pass a packed u32 or a '#rrggbb' string.

import {
  animBit,
  ENUMS,
  PROP,
  PROP_VALUE_KIND,
  VALUE_KIND,
  type PropName,
} from "../../contracts/spec/spec.ts";
import { encodePropValue, getOps } from "./host.ts";
import type { NodeMirror } from "./renderer.ts";
import type { NodeSlot } from "./model-node-ref.ts";
export type ModelAnimationResult = "ended" | "replaced" | "dropped";

export type EasingName =
  | "linear"
  | "in"
  | "out"
  | "in-out"
  | "out-back"
  | "spring"
  | "spring-bouncy";

const EASING_BY_NAME: Record<EasingName, number> = {
  linear: ENUMS.Easing.Linear,
  in: ENUMS.Easing.EaseIn,
  out: ENUMS.Easing.EaseOut,
  "in-out": ENUMS.Easing.EaseInOut,
  "out-back": ENUMS.Easing.OutBack,
  spring: ENUMS.Easing.Spring,
  "spring-bouncy": ENUMS.Easing.SpringBouncy,
};

export interface AnimateOptions {
  /** Duration in ms (default 200). Ignored by spring easings (physics). */
  dur?: number;
  /** Easing name or a raw ENUMS.Easing ordinal (default "out"). */
  easing?: EasingName | number;
  /** Delay in ms before the tween starts (default 0). */
  delay?: number;
}

function nodeId(node: NodeMirror | number): number {
  return typeof node === "number" ? node : node.id;
}

function animatablePropId(prop: PropName): number {
  const propId = PROP[prop];
  if (propId === undefined) {
    throw new Error(`PocketJS: unknown prop '${prop}'`);
  }
  if (animBit(prop) < 0) {
    throw new Error(`PocketJS: prop '${prop}' is not animatable (see spec ANIMATABLE)`);
  }
  return propId;
}

/**
 * Tween a node prop from its CURRENT value to `to`. Returns the animId
 * (cancelAnim). `to` for color props: packed u32 ABGR or '#rrggbb[aa]'.
 */
export function animate(node: NodeSlot, prop: PropName, to: number | string, opts?: AnimateOptions): PromiseLike<ModelAnimationResult>;
export function animate(node: NodeMirror | number, prop: PropName, to: number | string, opts?: AnimateOptions): number;
export function animate(
  node: NodeMirror | number | NodeSlot,
  prop: PropName,
  to: number | string,
  opts: AnimateOptions = {},
): number | PromiseLike<ModelAnimationResult> {
  if (typeof node === "function" && node.__pocketNodeRef) throw new Error("NodeSlot animation requires the compiled model transform");
  const propId = animatablePropId(prop);
  let easing: number;
  if (typeof opts.easing === "number") {
    easing = opts.easing;
  } else {
    const named = EASING_BY_NAME[opts.easing ?? "out"];
    if (named === undefined) {
      throw new Error(`PocketJS: unknown easing '${opts.easing}'`);
    }
    easing = named;
  }
  return getOps().animate(
    nodeId(node as NodeMirror | number),
    propId,
    encodePropValue(prop, to),
    opts.dur ?? 200,
    easing,
    opts.delay ?? 0,
  );
}

export type SpringPreset = "default" | "bouncy";

/** Spring a node prop to `to`; duration comes from the physics, not a timer. */
export function spring(
  node: NodeMirror | number,
  prop: PropName,
  to: number | string,
  preset: SpringPreset = "default",
): number {
  const propId = animatablePropId(prop);
  const easing =
    preset === "bouncy" ? ENUMS.Easing.SpringBouncy : ENUMS.Easing.Spring;
  return getOps().animate(nodeId(node), propId, encodePropValue(prop, to), 0, easing, 0);
}

/** Stop a running animation by the id animate()/spring() returned. */
export function cancelAnim(animId: number): void {
  getOps().cancelAnim(animId);
}

/**
 * Set an animatable prop RIGHT NOW — the scrub primitive. The core
 * guarantees a direct set kills any running animation on the same prop, so
 * per-frame jumps while an input is held never fight a tween; on release,
 * animate()/spring() glide from wherever the last jump left the value.
 */
export function jump(node: NodeMirror | number | NodeSlot, prop: PropName, value: number | string): void {
  if (typeof node === "function" && node.__pocketNodeRef) throw new Error("NodeSlot jump requires the compiled model transform");
  getOps().setProp(nodeId(node as NodeMirror | number), animatablePropId(prop), encodePropValue(prop, value));
}

export interface JumpBatch {
  /** Replace one entry's pending value. Entries retain their node/prop pair. */
  set(index: number, value: number | string): void;
  /** Apply every pending entry with the same semantics as repeated jump(). */
  commit(): void;
}

/**
 * Precompile a repeated direct-property update into one optional host call.
 * Native QuickJS hosts avoid one JS/C transition per property; older and
 * injected hosts retain identical behavior through the setProp fallback.
 */
export function createJumpBatch(
  entries: readonly (readonly [NodeMirror | number, PropName])[],
): JumpBatch {
  const ops = getOps();
  const records = new Float64Array(entries.length * 3);
  const props: PropName[] = new Array(entries.length);
  const directNumber: boolean[] = new Array(entries.length);
  for (let i = 0; i < entries.length; i++) {
    const [node, prop] = entries[i];
    records[i * 3] = nodeId(node);
    records[i * 3 + 1] = animatablePropId(prop);
    props[i] = prop;
    const kind = PROP_VALUE_KIND[prop];
    directNumber[i] = kind !== VALUE_KIND.color && kind !== VALUE_KIND.int;
  }
  return {
    set(index, value) {
      if (index < 0 || index >= entries.length) {
        throw new RangeError(`PocketJS: jump batch index ${index} outside 0..${entries.length - 1}`);
      }
      records[index * 3 + 2] =
        directNumber[index] && typeof value === "number"
          ? value
          : encodePropValue(props[index], value);
    },
    commit() {
      if (ops.setPropBatch) {
        ops.setPropBatch(records.buffer as ArrayBuffer);
        return;
      }
      for (let i = 0; i < entries.length; i++) {
        ops.setProp(records[i * 3], records[i * 3 + 1], records[i * 3 + 2]);
      }
    },
  };
}
