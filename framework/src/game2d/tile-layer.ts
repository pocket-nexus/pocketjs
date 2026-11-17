// @pocketjs/framework/game2d — a map drawn in square chunks.
//
// A map larger than the texture budget cannot be one static picture. A tile layer is a static
// layer holding the chunks that intersect the view, plus a margin: it draws again only when the
// view crosses a chunk edge, so a camera that scrolls every frame redraws it every few hundred
// pixels of motion, and the chunks out of view are unpinned for the texture pool to evict.

import { createStaticLayer, type LayerConfig, type LayerStats } from "./layer.tsx";
import type { PackImage } from "./packs.ts";
import type { JSX } from "solid-js";

export interface TileLayerConfig extends Omit<LayerConfig, "clip"> {
  /** Chunk size in world pixels. */
  tile: number;
  /** Chunks kept around the view, in chunks. Default 0. */
  margin?: number;
}

export interface TileMap {
  cols: number; rows: number;
  /** The image of chunk `index` (row-major), or undefined for an empty chunk. */
  image(index: number): PackImage | undefined;
}

export interface TileLayer {
  /** Lives inside a camera: it draws in world space. */
  View: () => JSX.Element;
  /** Replace the map, or null for none. Draws on the next `frame()`. */
  setMap(map: TileMap | null): void;
  /** The map's images changed (a door opened): draw again. */
  invalidate(): void;
  /** Call once per frame with the camera's world position. Returns true when it drew. */
  frame(viewX: number, viewY: number): boolean;
  stats(): LayerStats;
}

export function createTileLayer(cfg: TileLayerConfig): TileLayer {
  const T = cfg.tile, margin = cfg.margin ?? 0;
  let map: TileMap | null = null;
  let x0 = 0, y0 = 0, x1 = -1, y1 = -1;
  const layer = createStaticLayer({
    ...cfg, clip: false,
    draw(gfx) {
      if (!map) return;
      for (let ty = y0; ty <= y1; ty++) {
        if (ty < 0 || ty >= map.rows) continue;
        for (let tx = x0; tx <= x1; tx++) {
          if (tx < 0 || tx >= map.cols) continue;
          const img = map.image(ty * map.cols + tx);
          if (img) gfx.cell(img, tx * T, ty * T);
        }
      }
    },
  });
  const floor = (v: number) => Math.floor(v / T);
  return {
    View: layer.View,
    setMap(m) { map = m; x1 = -1; y1 = -1; layer.invalidate(); },
    invalidate: layer.invalidate,
    frame(vx, vy) {
      const nx0 = floor(vx) - margin, ny0 = floor(vy) - margin;
      const nx1 = floor(vx + cfg.width - 1) + margin, ny1 = floor(vy + cfg.height - 1) + margin;
      if (nx0 !== x0 || ny0 !== y0 || nx1 !== x1 || ny1 !== y1) { x0 = nx0; y0 = ny0; x1 = nx1; y1 = ny1; layer.invalidate(); }
      return layer.frame();
    },
    stats: layer.stats,
  };
}
