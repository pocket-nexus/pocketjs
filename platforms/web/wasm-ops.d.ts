// Type surface of wasm-ops.js for the TS harness (tests/golden.ts). The .js
// stays plain ESM so the browser loads it without a build step.

import type { HostOps } from "../../framework/src/host.ts";

export declare const FB_W: number;
export declare const FB_H: number;

export type WasmHostOps = HostOps & Required<Pick<HostOps, "loadStyles" | "loadFontAtlas">> & {
  __viewport: { w: number; h: number };
};

export interface WasmUi {
  ops: WasmHostOps;
  readonly booted: boolean;
  readonly disposed: boolean;
  boot(source: string, options?: Record<string, any>): WasmHostOps;
  bootAsync(source: string, options?: Record<string, any>): Promise<WasmHostOps>;
  advance(facts?: Record<string, any>, ticks?: number): void;
  present(): Uint8Array;
  dispose(): void;
  focused(): number;
  inspectNode(id: number): { type: number; text: string; children: number[]; display: number | null; style: { bgColor: number; textColor: number } } | null;
  layout(id: number): [number, number, number, number, number, number, number, number];
  setLayoutMode(id: number, mode: number, x: number, y: number, width: number, height: number): void;
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
  /** Hash the auxiliary surface's DrawList; null for an older wasm. */
  drawHashAuxiliary: (() => bigint) | null;
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
  /** Rasterize once with coverage: premultiplied RGBA8, alpha 0 where nothing is drawn; null for an older wasm. */
  renderPremultiplied: ((scale?: number) => Uint8Array) | null;
  /** Render child surfaces at their compositor instructions. */
  renderComposited(scale?: number): Uint8Array;
  /** Repaint only changed regions at the logical viewport size. */
  renderIncremental(): Uint8Array;
  /** Repaint only changed regions at an integer physical scale. */
  renderScaledIncremental(scale: number): Uint8Array;
}

export declare function createWasmUi(
  wasm: ArrayBuffer | Uint8Array | WebAssembly.Module,
  options?: { host?: string; hostAbi?: number; width?: number; height?: number; rasterDensity?: number; auxiliary?: [number, number] },
): Promise<WasmUi>;

export declare function uploadPackImages(
  ops: HostOps,
  listEntries: (prefix: string) => string[],
  getEntry: (key: string) => Uint8Array,
): Map<string, number>;

export declare function createWasmUiSync(wasm: ArrayBuffer | Uint8Array | WebAssembly.Module, options?: {host?: string; hostAbi?: number; width?: number; height?: number; rasterDensity?: number; auxiliary?: [number, number]}): WasmUi;
export declare function contactFacts(touches?: readonly number[], surfaces?: readonly number[]): Array<{surface:number;id:number;x:number;y:number;cancelled:boolean}>;
