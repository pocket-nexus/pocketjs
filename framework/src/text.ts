import { TEXT, type TextFace, type TextGlyph, type TextGlyphRequest } from "../../contracts/spec/text.ts";
import { createResourceScheduler, type ResourceDemand } from "./resource-cache.ts";
import { offloadResource } from "./resource-offload.ts";
import { offload, uploadCoverage } from "./offload.ts";
import { createBakedFontCoverage } from "./font-coverage.ts";
import { getOps } from "./host.ts";
import { registerServicePump } from "./services.ts";

export type { TextFace, TextGlyphRequest };
export interface ResidentGlyph extends Omit<TextGlyph, "mask"> { handle: number; envelope: number }
export type TextPart = { text: string; x: number; width: number; start: number; end: number } &
  ({ kind: "local" } | { kind: "glyph"; glyph?: ResidentGlyph });
export interface TextLayout { text: string; parts: TextPart[]; width: number; pending: boolean; revision: number }
export interface TextStyle { size: number; density: number; bold: boolean; fontSlot: number; width: number }
type Channel = Pick<ReturnType<typeof offload>, "request" | "cancel" | "session">;

/** Realm-owned immutable glyph resources. Layout reads never submit I/O. */
export function createTextResources(options: {
  io: Channel;
  measure(text: string, slot: number): number;
  local?(scalar: string, slot: number): boolean;
  upload(mask: string, width: number, height: number): number | undefined;
  free(handle: number): void;
  maxGlyphs?: number;
}) {
  const local = options.local ?? ((scalar: string) => /^[\x20-\x7e]$/.test(scalar));
  const io = options.io, limit = options.maxGlyphs ?? TEXT.maxGlyphs;
  if (!Number.isInteger(limit) || limit < 1 || limit > TEXT.maxGlyphs) throw new Error("Invalid text cache budget");
  let face = "", session = 0, faceRequest = 0, facePending = false, retry = 0, dead = false;
  let demandsDirty = true;
  const owners = new Set<{ demands: ResourceDemand<TextGlyphRequest>[]; glyphs: Map<string, ResidentGlyph | undefined>; stale: boolean }>();
  const key = (r: TextGlyphRequest) => `${r.face}/${r.size}/${r.density}/${+r.bold}/${r.text}`;
  const scheduler = createResourceScheduler({ maxCollections: 1, maxConcurrent: 2, startsPerFrame: 1, completionsPerFrame: 1,
    available: () => io.session() > 0 && !facePending });
  const cache = scheduler.createCache<TextGlyphRequest, string, ResidentGlyph>({
    key, maxEntries: limit, maxCost: limit * TEXT.maxPixels * 4, maxResponseBytes: 7800,
    cost: () => TEXT.maxPixels * 4,
    load: offloadResource(io, "text.glyph", r => JSON.stringify(r)),
    materialize(raw, request) {
      const g = JSON.parse(raw) as TextGlyph;
      if (g.face !== request.face || !Number.isFinite(g.advance) || g.advance < 0 || g.advance > 64 ||
          !Number.isFinite(g.xoff) || g.xoff < 0 || g.xoff > 32 || !Number.isInteger(g.width) || g.width < 4 ||
          g.width > TEXT.maxWidth || g.width % 4 || !Number.isInteger(g.height) || g.height < 16 ||
          g.height > TEXT.maxHeight || (g.height & (g.height - 1)) || typeof g.mask !== "string" ||
          g.mask.length !== Math.ceil(g.width * g.height / 12) * 4) throw new Error("Invalid glyph coverage");
      const handle = options.upload(g.mask, g.width, g.height);
      if (handle === undefined || handle <= 0) throw new Error("Glyph upload unavailable");
      const { mask, ...metrics } = g;
      return { ...metrics, handle, envelope: Math.max(8, 2 ** Math.ceil(Math.log2(g.width))) };
    },
    dispose: g => options.free(g.handle), changed: request => {
      const id = key(request), state = cache.state(request), glyph = state.status === "ready" ? state.value : undefined;
      // A request starting is not a layout change. Only readers of coverage
      // whose resident value changed need to rebuild and repaint their parts.
      for (const owner of owners) if (owner.glyphs.has(id) && owner.glyphs.get(id) !== glyph) owner.stale = true;
    },
  });
  return {
    createLayout(style: TextStyle) {
      if (dead || !Number.isInteger(style.size) || style.size < 8 || !Number.isInteger(style.density) ||
          style.density < 1 || style.density > 3 || style.size * style.density > TEXT.maxRasterSize ||
          !Number.isFinite(style.width) || style.width <= 0 || style.width > 4096 || !Number.isInteger(style.fontSlot) ||
          style.fontSlot < 0 || style.fontSlot >= 24) throw new Error("Invalid text layout style");
      const owner = { demands: [] as ResourceDemand<TextGlyphRequest>[], glyphs: new Map<string, ResidentGlyph | undefined>(), stale: true }; owners.add(owner);
      let text = "", priority = 1, active = true, previous = "\0", serial = 0;
      let layout: TextLayout = { text: "", parts: [], width: 0, pending: false, revision: 0 };
      return {
        set(value: string, visible = true, rank = 1) {
          if (text === value && active === visible && priority === rank) return;
          let bounded = "";
          for (const scalar of value) { if (bounded.length + scalar.length > TEXT.maxCodeUnits) break; bounded += scalar; }
          if (text !== bounded || active !== visible || priority !== rank) { text = bounded; active = visible; priority = rank; previous = "\0"; }
        },
        snapshot(): TextLayout {
          if (text === previous && !owner.stale) return layout;
          previous = text; owner.stale = false; owner.glyphs.clear();
          const parts: TextPart[] = [], demands: ResourceDemand<TextGlyphRequest>[] = [];
          let x = 0, start = 0, pending = false;
          // Same scalar cmap model as the core's baked fonts. Shaping runs and
          // grapheme caret boundaries must come from a shaper, not this loop.
          const tokens: { text: string; local: boolean }[] = [];
          for (const scalar of text) {
            const baked = local(scalar, style.fontSlot), previous = tokens.at(-1);
            if (baked && previous?.local) previous.text += scalar;
            else tokens.push({ text: scalar, local: baked });
          }
          for (const { text: token, local: baked } of tokens) {
            const end = start + token.length;
            if (baked) {
              const width = options.measure(token, style.fontSlot);
              parts.push({ kind: "local", text: token, x, width, start, end }); x += width;
            } else {
              const request = { face, text: token, size: style.size, density: style.density, bold: style.bold };
              const state = face ? cache.state(request) : { status: "pending" as const };
              const glyph = state.status === "ready" ? state.value : undefined, width = glyph?.advance ?? style.size;
              // Clipped glyphs still contribute to the reported text width.
              owner.glyphs.set(key(request), glyph);
              if (x < style.width && active && face) demands.push({ input: request, priority, pin: true });
              if (x < style.width) { parts.push({ kind: "glyph", text: token, x, width, start, end, glyph }); pending ||= !glyph; }
              x += width;
            }
            start = end;
          }
          if (demands.length !== owner.demands.length || demands.some((d, i) => d.priority !== owner.demands[i].priority || key(d.input) !== key(owner.demands[i].input))) demandsDirty = true;
          owner.demands = demands;
          layout = { text, parts, width: x, pending, revision: ++serial };
          return layout;
        },
        dispose() { owners.delete(owner); owner.demands = []; demandsDirty = true; },
      };
    },
    step() {
      if (dead) return;
      const current = io.session();
      if (current !== session) {
        session = current; scheduler.cancel(); if (faceRequest) io.cancel(faceRequest);
        faceRequest = 0; facePending = current > 0; retry = 0;
      }
      if (facePending && !faceRequest && retry-- <= 0) {
        faceRequest = io.request("text.font", "{}", result => {
          faceRequest = 0;
          if (result.ok) try {
            const next = JSON.parse(result.value) as TextFace;
            if (next.mapping !== "scalar" || !/^[a-f0-9]{64}$/.test(next.id)) throw new Error();
            if (face !== next.id) {
              face = next.id;
              for (const owner of owners) if (owner.glyphs.size) owner.stale = true;
            }
            cache.retryFailed(request => request.face === face);
            facePending = false; return;
          } catch { /* Keep immutable resident glyphs until a valid face arrives. */ }
          retry = 60;
        });
      }
      if (demandsDirty) {
        const unique = new Map<string, ResourceDemand<TextGlyphRequest>>();
        for (const owner of owners) for (const demand of owner.demands) {
          const id = key(demand.input), old = unique.get(id);
          if (!old || demand.priority < old.priority) unique.set(id, demand);
        }
        cache.reconcile([...unique.values()].sort((a, b) => a.priority - b.priority).slice(0, limit));
        demandsDirty = false;
      }
      scheduler.step();
    },
    stats: cache.stats,
    dispose() { dead = true; if (faceRequest) io.cancel(faceRequest); scheduler.dispose(); owners.clear(); },
  };
}

let resources: ReturnType<typeof createTextResources> | undefined;
/** One cache and upload scheduler shared by labels in every UI framework. */
export function textResources() {
  if (!resources) {
    resources = createTextResources({ io: offload(), local: createBakedFontCoverage(), measure: (s, slot) => getOps().measureText(s, slot),
      upload: (mask, w, h) => uploadCoverage(mask, w, h, 0xffffffff), free: h => getOps().freeTexture?.(h) });
    registerServicePump(() => resources!.step());
  }
  return resources;
}
