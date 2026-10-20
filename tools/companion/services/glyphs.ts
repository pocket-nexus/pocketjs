// The glyphs service (tools/companion/services.ts): font atlases for an app's
// runtime text. A console bakes only the glyphs its bundle's source names, so
// Chinese names, Japanese posts or an emoji in a message have no glyph on it.
// The app sends the text it is about to show; the companion draws PingFang
// with CoreText (glyphs.ts, macos/Glyphs.swift) and answers a FONT ATLAS v3
// (contracts/spec/spec.ts) for the slot the app names, holding printable
// ASCII and every codepoint of the text. The app loads it with
// `ui.loadFontAtlas` and draws that text from the slot.
//
//   POST /glyphs/atlas {px, bold, slot, text}   the atlas (application/x-pocket-font)
//
// One rasterizer per size and weight, each caching its cells, so a later
// atlas that repeats earlier glyphs draws only the new ones. An emoji draws
// as a one-colour picture (Glyphs.swift); a codepoint no font has maps to
// the atlas's tofu box.

import { atlasFont, codepointsOf, GlyphRasterizer, packAtlas, type GlyphCell } from "../glyphs.ts";
import { bytesResponse, jsonResponse, type ServiceContext, type ServiceProvider } from "../services.ts";
import { MAX_FONT_SLOTS } from "../../../contracts/spec/spec.ts";

/** Sizes an app may ask for, and how many glyphs one atlas holds. */
export const GLYPH_PX_MIN = 8;
export const GLYPH_PX_MAX = 32;
export const GLYPH_ATLAS_MAX = 1500;
/** The text one request may carry, in characters. */
const TEXT_MAX = 20_000;

const ASCII = Array.from({ length: 0x7f - 0x20 }, (_, i) => 0x20 + i);

export interface GlyphsOptions {
  /** Test seam: the rasterizer for a size and weight. */
  rasterizer?: (px: number, bold: boolean) => Pick<GlyphRasterizer, "cells" | "close">;
}

export function createGlyphsService(context: ServiceContext, options: GlyphsOptions = {}): ServiceProvider {
  const rasterizers = new Map<string, Pick<GlyphRasterizer, "cells" | "close">>();
  const rasterizer = (px: number, bold: boolean) => {
    const key = `${px}${bold ? "b" : ""}`;
    let raster = rasterizers.get(key);
    if (!raster) {
      raster = options.rasterizer?.(px, bold) ?? new GlyphRasterizer(context.storeDir, atlasFont(px), context.log, bold);
      rasterizers.set(key, raster);
    }
    return raster;
  };
  return {
    name: "glyphs",
    async handle(request) {
      if (request.path !== "/atlas" || request.method !== "POST") return jsonResponse(404, { error: `no glyphs endpoint ${request.path}` });
      let body: { px?: unknown; bold?: unknown; slot?: unknown; text?: unknown };
      try {
        body = JSON.parse(new TextDecoder().decode(request.body)) as typeof body;
      } catch {
        return jsonResponse(400, { error: "atlas needs JSON {px, bold, slot, text}" });
      }
      const px = typeof body.px === "number" ? Math.round(body.px) : NaN;
      const slot = typeof body.slot === "number" ? body.slot : NaN;
      const text = typeof body.text === "string" ? body.text : "";
      if (!(px >= GLYPH_PX_MIN && px <= GLYPH_PX_MAX) || !Number.isInteger(slot) || slot < 0 || slot >= MAX_FONT_SLOTS) {
        return jsonResponse(400, { error: `atlas needs px ${GLYPH_PX_MIN}..${GLYPH_PX_MAX} and a slot below ${MAX_FONT_SLOTS}` });
      }
      if (text.length > TEXT_MAX) return jsonResponse(400, { error: `atlas text is limited to ${TEXT_MAX} characters` });
      const wanted = [...new Set([...ASCII, ...codepointsOf(text)])];
      if (wanted.length > GLYPH_ATLAS_MAX) return jsonResponse(400, { error: `an atlas holds at most ${GLYPH_ATLAS_MAX} glyphs` });
      const bold = body.bold === true;
      const cells = await rasterizer(px, bold).cells(wanted);
      if (cells.size === 0) return jsonResponse(503, { error: "this Mac cannot draw glyphs (no CoreText helper)" });
      const drawn = new Map<number, GlyphCell>();
      for (const [cp, cell] of cells) if (cell) drawn.set(cp, cell);
      return bytesResponse(packAtlas(drawn, atlasFont(px), slot, bold), "application/x-pocket-font");
    },
    close() {
      for (const raster of rasterizers.values()) raster.close();
      rasterizers.clear();
    },
  };
}
