// Type surface of wasm-ops.js for the TS harness (tests/golden.ts). The .js
// stays plain ESM so the browser loads it without a build step.

import type { HostOps } from "../../framework/src/host.ts";

export declare const FB_W: number;
export declare const FB_H: number;

export interface WasmUi {
  ops: HostOps;
  exports: WebAssembly.Exports & { memory: WebAssembly.Memory };
  createAuxiliarySurface(width: number, height: number): number;
  renderAuxiliary(): Uint8Array;
  /** Reset the core and set raster samples per logical pixel (default 1). */
  init(rasterDensity?: number): void;
  /** Resize a dynamic browser viewport. */
  resizeViewport(width: number, height: number): void;
  /** Advance exactly one fixed-dt (1/60 s) frame. */
  tick(): void;
  /** Hash the current DrawList without rasterizing it; null for an older wasm. */
  drawHash: (() => bigint) | null;
  compositorBindings(): Array<{ handle: number; focused: boolean }>;
  compositorFrames(): Array<{
    handle: number;
    full: [number, number, number, number];
    clip: [number, number, number, number];
    focused: boolean;
    order: number;
  }>;
  uploadCompositorSurface(
    handle: number,
    pixels: Uint8Array,
    width: number,
    height: number,
  ): number;
  freeCompositorSurface(handle: number): void;
  /** Rasterize the byte-exact RGBA8 framebuffer at the logical viewport size. */
  render(): Uint8Array;
  /** Rasterize directly at an integer physical scale from 1 through 4. */
  renderScaled(scale: number): Uint8Array;
  /** Render child surfaces at their compositor instructions. */
  renderComposited(scale?: number): Uint8Array;
  /** Repaint only changed regions at the logical viewport size. */
  renderIncremental(): Uint8Array;
  /** Repaint only changed regions at an integer physical scale. */
  renderScaledIncremental(scale: number): Uint8Array;
}

export declare function createWasmUi(
  wasm: ArrayBuffer | Uint8Array | WebAssembly.Module,
  options?: { width?: number; height?: number; rasterDensity?: number; auxiliary?: [number, number] },
): Promise<WasmUi>;

export declare function uploadPackImages(
  ops: HostOps,
  listEntries: (prefix: string) => string[],
  getEntry: (key: string) => Uint8Array,
): Map<string, number>;
