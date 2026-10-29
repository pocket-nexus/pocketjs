import { ENUMS } from "../../contracts/spec/spec.ts";
import type { HostOps } from "./host.ts";
import {
  adoptNativeRoot,
  createElement,
  insertNode,
  releaseNativeRoot,
  setProp,
  type NodeMirror,
} from "./native-tree.ts";

export type SurfaceId = "primary" | "auxiliary";

export interface AuxiliaryViewport {
  readonly width: number;
  readonly height: number;
}

export interface AuxiliarySurfaceRoots {
  readonly native: NodeMirror;
  readonly app: NodeMirror;
  readonly overlay: NodeMirror;
  readonly viewport: AuxiliaryViewport;
}

let roots: AuxiliarySurfaceRoots | null = null;

function layerStyle(width: number, height: number, overlay: boolean) {
  return overlay
    ? {
        width,
        height,
        posType: ENUMS.PosType.Absolute,
        insetT: 0,
        insetR: 0,
        insetB: 0,
        insetL: 0,
        zIndex: 1000,
        hitPass: 1,
      }
    : { width, height, overflow: ENUMS.Overflow.Hidden };
}

function layer(width: number, height: number, overlay: boolean): NodeMirror {
  const node = createElement("view");
  setProp(node, "style", layerStyle(width, height, overlay), undefined);
  return node;
}

/** Install guest-owned app/overlay layers under the host-created root. */
export function mountAuxiliarySurface(ops: HostOps): AuxiliarySurfaceRoots | null {
  const descriptor = ops.__auxiliarySurface;
  if (!descriptor) {
    roots = null;
    return null;
  }
  if (
    !Number.isInteger(descriptor.root) || descriptor.root <= 1 ||
    !Number.isFinite(descriptor.w) || descriptor.w <= 0 ||
    !Number.isFinite(descriptor.h) || descriptor.h <= 0
  ) {
    throw new Error("PocketJS: invalid ui.__auxiliarySurface descriptor");
  }
  const native = adoptNativeRoot(descriptor.root, "auxiliary-root");
  const app = layer(descriptor.w, descriptor.h, false);
  const overlay = layer(descriptor.w, descriptor.h, true);
  insertNode(native, app);
  insertNode(native, overlay);
  roots = {
    native,
    app,
    overlay,
    viewport: Object.freeze({ width: descriptor.w, height: descriptor.h }),
  };
  return roots;
}

/** Destroy guest-owned children without destroying the host-owned root. */
export function unmountAuxiliarySurface(ops: HostOps): void {
  const mounted = roots;
  roots = null;
  if (!mounted) return;
  for (const child of mounted.native.children.splice(0)) {
    child.parent = null;
    ops.destroyNode(child.id);
  }
  releaseNativeRoot(mounted.native);
}

/** The host resized the auxiliary surface (Runtime::resize_auxiliary): the
 *  app and overlay layers take the new size, and auxiliaryViewport() reads
 *  it. Content laid out from the old size lays out again when the app
 *  remounts it. */
export function resizeAuxiliarySurface(width: number, height: number): void {
  if (!roots || !(width > 0) || !(height > 0)) return;
  setProp(roots.app, "style", layerStyle(width, height, false), undefined);
  setProp(roots.overlay, "style", layerStyle(width, height, true), undefined);
  roots = { ...roots, viewport: Object.freeze({ width, height }) };
}

export function auxiliaryViewport(): AuxiliaryViewport | null {
  return roots?.viewport ?? null;
}

export function hasAuxiliarySurface(): boolean {
  return roots !== null;
}

export function getAuxiliarySurfaceRoots(): AuxiliarySurfaceRoots {
  if (!roots) {
    throw new Error(
      "PocketJS: AuxiliarySurface requires a resolved display.auxiliary capability",
    );
  }
  return roots;
}
