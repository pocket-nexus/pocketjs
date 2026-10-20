// Type surface of runtime-glyphs.js for the TS harness
// (tests/runtime-glyphs.test.ts). The .js stays plain ESM so the browser
// loads it without a build step.

import type { HostOps } from "../../framework/src/host.ts";

export declare const FONT_MAGIC: number;
export declare const FONT_HEADER_SIZE: number;
export declare const FONT_CMAP_ENTRY_SIZE: number;
export declare const DEFAULT_FALLBACK_FAMILIES: string;
export declare const MAX_GLYPHS: number;
export declare const BITMAP_CUT: number;

/** An appendable copy of one FONT ATLAS blob. */
export interface RuntimeAtlas {
  cellW: number;
  cellH: number;
  baseline: number;
  lineHeight: number;
  slot: number;
  flags: number;
  density: number;
  /** [codepoint, gid, advance, xoff], one per cell. */
  glyphs: number[][];
  known: Set<number>;
  coverage: Uint8Array;
  em: number;
  bilevel: boolean;
}

/** One drawn glyph: `advance` and `width` in logical px, `coverage` `width * density` samples wide. */
export interface RuntimeGlyph {
  advance: number;
  width: number;
  coverage: Uint8Array;
}

export type Rasterizer = (codepoint: number, atlas: RuntimeAtlas) => RuntimeGlyph | null;

export declare function parseAtlas(bytes: ArrayBuffer | Uint8Array): RuntimeAtlas | null;
export declare function widenAtlas(atlas: RuntimeAtlas, cellW: number): void;
export declare function appendGlyph(atlas: RuntimeAtlas, codepoint: number, glyph: RuntimeGlyph): boolean;
export declare function serializeAtlas(atlas: RuntimeAtlas): Uint8Array;
export declare function canvasRasterizer(options?: {
  families?: string;
  createCanvas?: (width: number, height: number) => unknown;
}): Rasterizer;

export interface RuntimeGlyphStats {
  glyphs: number;
  cells: number;
  reloads: number;
  ms: number;
  full: number;
  slots: number;
}

export declare function installRuntimeGlyphs(
  ops: HostOps,
  options?: { rasterize?: Rasterizer; now?: () => number },
): {
  ensure(text: string): void;
  flush(): void;
  stats(): RuntimeGlyphStats;
};
