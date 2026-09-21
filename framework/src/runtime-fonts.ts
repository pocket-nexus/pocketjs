import {
  RUNTIME_TEXT as R, runtimeClearPacket, runtimeDropPacket, runtimeGlyphPacket, runtimeLayoutPacket,
  type RuntimeCaret, type RuntimeFontInstance, type RuntimeFontSpec, type RuntimeGlyphBitmap,
  type RuntimeGlyphPosition, type RuntimeLayoutOptions, type RuntimeTextLayout, type RuntimeTextRow,
} from "../../contracts/spec/runtime-text.ts";
import { getOps, type HostOps } from "./host.ts";
import { offload, type createOffloadClient } from "./offload.ts";
import { registerServicePump } from "./services.ts";
import { failed, pending, ready, type ResourceState } from "./resource-state.ts";
import type { PreparedText, TextResource } from "./fonts.ts";

export type { RuntimeFontSpec, RuntimeFontInstance, RuntimeTextLayout, RuntimeLayoutOptions };
export { textCaret, textHitTest, textSelection, textMoveCaret } from "./text-geometry.ts";
type Client = ReturnType<typeof createOffloadClient>;
export interface RuntimeFontOptions extends RuntimeFontSpec {
  provider?: "companion" | "local";
  /** Independent CPU grayscale cache budget. Live batches reserve their union. */
  bitmapBytes?: number;
  /** Independent GPU texture budget. Includes power-of-two RGBA padding. */
  gpuBytes?: number;
  /** Service-wide worker cache budgets; zero makes new admission fail. */
  workerBudgets?: { shaping?: number; layout?: number; bitmap?: number };
}
export interface RuntimeTextResource extends TextResource {
  /** Geometry becomes available before coverage; bitmap residency never changes it. */
  layout(): RuntimeTextLayout | undefined;
}
export interface RuntimeFont {
  prepareText(text: string, options?: RuntimeLayoutOptions): RuntimeTextResource;
  stats(): { bitmapBytes: number; gpuBytes: number; glyphs: number; batches: number; uploads: number; uploadedBytes: number; evictions: number };
  dispose(): void;
}
type Glyph = { id: number; refs: number; used: number; bitmap?: RuntimeGlyphBitmap; partial?: RuntimeGlyphBitmap;
  offset?: number; busy?: boolean; gpu: boolean; bytes: number; gpuCost: number };
type Stage = "prepare" | "glyphs" | "rows" | "carets" | "admit" | "bitmap" | "upload" | "done";
type Batch = {
  text: string; options: RuntimeLayoutOptions; state: ResourceState<PreparedText>; listeners: Set<() => void>;
  stage: Stage; leaseKey: string; layoutId: number; pinned: boolean; offset: number; total: number;
  meta?: { width: number; height: number; baseline: number; truncated: boolean; glyphs: number; rows: number; carets: number };
  positions: RuntimeGlyphPosition[]; rows: RuntimeTextRow[]; carets: RuntimeCaret[]; layout?: RuntimeTextLayout;
  glyphs: Glyph[]; current: number; dead: boolean;
};
const integer = (n: unknown, min = 0, max = 0xffffffff): n is number => Number.isInteger(n) && (n as number) >= min && (n as number) <= max;
const finite = (n: unknown): n is number => typeof n === "number" && Number.isFinite(n);
const pow2 = (n: number) => n ? 2 ** Math.ceil(Math.log2(n)) : 0;
let nextNativeInstance = 1;
const hostGpuBudgets = new WeakMap<HostOps, number>();

function coverageBytes(text: string): Uint8Array {
  if (typeof text !== "string" || text.length > 1368 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(text))
    throw Error("Invalid runtime glyph coverage");
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  const out = new Uint8Array(text.length / 4 * 3 - (text.endsWith("==") ? 2 : text.endsWith("=") ? 1 : 0));
  for (let i = 0, at = 0; i < text.length; i += 4) {
    const word = alphabet.indexOf(text[i]) << 18 | alphabet.indexOf(text[i + 1]) << 12 |
      Math.max(0, alphabet.indexOf(text[i + 2])) << 6 | Math.max(0, alphabet.indexOf(text[i + 3]));
    if (at < out.length) out[at++] = word >>> 16;
    if (at < out.length) out[at++] = word >>> 8;
    if (at < out.length) out[at++] = word;
  }
  return out;
}
function validateOptions(options: RuntimeLayoutOptions) {
  if (options.width != null && (!finite(options.width) || options.width <= 0 || options.width > 16384) ||
      options.maxLines != null && !integer(options.maxLines, 1, R.maxUnits + 1) ||
      options.overflow != null && options.overflow !== "clip" && options.overflow !== "ellipsis") throw Error("Invalid runtime text layout options");
}

/** Worker requests, raster delivery and GPU uploads advance at frame boundaries.
 * A lease reveals its entire shaped glyph union together and pins it until disposal. */
export function createRuntimeFont(options: RuntimeFontOptions, host: HostOps, client: Client): RuntimeFont {
  if (!host.fontStreamCommit) throw Error("Host does not implement runtime text resources");
  if (!options.family || options.family.length > 128 || !finite(options.size) || options.size < 4 || options.size > 256 ||
      !Array.isArray(options.fallback) || options.fallback.length > 8 || options.fallback.some(f => !f || f.length > 128))
    throw Error("Invalid runtime font; explicit fallback is required");
  const spec = Object.freeze({ family: options.family, size: options.size, fallback: [...options.fallback] });
  const bitmapLimit = options.bitmapBytes ?? R.bitmapBytes, gpuLimit = options.gpuBytes ?? 4 * 1024 * 1024;
  if (!integer(bitmapLimit, 1, 16 * 1024 * 1024) || !integer(gpuLimit, 1, 16 * 1024 * 1024)) throw Error("Invalid runtime font memory budget");
  for (const value of Object.values(options.workerBudgets ?? {})) if (!integer(value, 0, 64 * 1024 * 1024)) throw Error("Invalid worker text cache budget");
  const budget = new Uint8Array(12), bv = new DataView(budget.buffer);
  const hostGpuLimit = Math.max(gpuLimit, hostGpuBudgets.get(host) ?? 0);
  bv.setUint32(0, R.packetMagic, true); bv.setUint32(4, 5, true); bv.setUint32(8, hostGpuLimit, true);
  if (!host.fontStreamCommit(budget)) throw Error("Runtime GPU budget is below existing residency");
  hostGpuBudgets.set(host, hostGpuLimit);
  let nativeInstance = nextNativeInstance++;
  const batches = new Set<Batch>(), glyphs = new Map<number, Glyph>(), releases: string[] = [];
  const rasterRequests = new Map<number, Batch>();
  let font: RuntimeFontInstance | undefined, fontError: unknown, request = 0, requestBatch: Batch | undefined,
    session = client.session(), dead = false, clock = 0, cpuBytes = 0, gpuBytes = 0, uploads = 0, uploadedBytes = 0, evictions = 0,
    leaseSerial = 0, budgetReady = !options.workerBudgets;
  const notify = (b: Batch) => { for (const listener of b.listeners) listener(); };
  const releaseGlyphs = (b: Batch) => {
    for (const g of b.glyphs) {
      g.refs--; g.used = ++clock;
      if (g.refs === 0 && !g.bitmap) {
        cpuBytes -= g.bytes; g.bytes = 0;
        if (!g.gpu) glyphs.delete(g.id);
      }
    }
    b.glyphs = [];
  };
  const releaseLayout = (b: Batch) => { if (b.pinned) { releases.push(b.leaseKey); b.pinned = false; } };
  const fail = (b: Batch, error: unknown) => {
    for (const [id, owner] of rasterRequests) if (owner === b) { client.cancel(id); rasterRequests.delete(id); }
    releaseGlyphs(b); releaseLayout(b); b.stage = "done"; b.state = failed(error); notify(b);
  };
  const evict = (extra: number) => {
    for (const g of [...glyphs.values()].filter(g => g.refs === 0).sort((a, b) => a.used - b.used)) {
      if (cpuBytes + extra <= bitmapLimit) break;
      cpuBytes -= g.bytes; g.bytes = 0; g.bitmap = undefined;
      if (!g.gpu) glyphs.delete(g.id);
      evictions++;
    }
    return cpuBytes + extra <= bitmapLimit;
  };
  const evictGpu = (extra: number) => {
    for (const g of [...glyphs.values()].filter(g => g.refs === 0 && g.gpu).sort((a, b) => a.used - b.used)) {
      if (gpuBytes + extra <= gpuLimit) break;
      host.fontStreamCommit!(runtimeDropPacket(nativeInstance, g.id));
      g.gpu = false; gpuBytes -= g.gpuCost;
      if (!g.bitmap) glyphs.delete(g.id);
      evictions++;
    }
    return gpuBytes + extra <= gpuLimit;
  };
  const dropAllGpu = () => {
    for (const g of glyphs.values()) if (g.gpu) host.fontStreamCommit!(runtimeDropPacket(nativeInstance, g.id));
    gpuBytes = 0;
  };
  const send = (method: string, data: unknown, b: Batch | undefined, done: (value: any) => void) => {
    requestBatch = b;
    try {
      request = client.request(method, JSON.stringify(data), result => {
        request = 0; requestBatch = undefined;
        if (dead || b?.dead) return;
        try {
          if (!result.ok) throw Error(result.error);
          done(JSON.parse(result.value));
        } catch (error) {
          if (b) fail(b, error);
          else if (method !== "runtime.release") { fontError = error; for (const batch of batches) fail(batch, error); }
        }
      }, { session });
    } catch (error) { if (b) fail(b, error); else fontError = error; }
  };
  const newBatch = (text: string, layoutOptions: RuntimeLayoutOptions): Batch => ({
    text, options: { ...layoutOptions }, state: pending(), listeners: new Set(), stage: "prepare", leaseKey: `rt-${nativeInstance}-${++leaseSerial}`, layoutId: 0,
    pinned: false, offset: 0, total: 0, meta: undefined, layout: undefined,
    positions: [], rows: [], carets: [], glyphs: [], current: 0, dead: false,
  });
  const acceptGlyph = (g: Glyph, value: any) => {
    const offset = g.offset ?? 0;
    if (value.glyph !== g.id || !integer(value.width, 0, 512) || !integer(value.height, 0, 512) ||
        !integer(value.left, -512, 512) || !integer(value.top, -512, 512) || value.total !== value.width * value.height ||
        value.total > R.maxGlyphPixels || value.offset !== offset) throw Error("Invalid runtime glyph metadata");
    const chunk = coverageBytes(value.coverage);
    if (offset + chunk.length > value.total || value.next !== (offset + chunk.length === value.total ? null : offset + chunk.length) || (!chunk.length && value.total !== 0))
      throw Error("Invalid runtime glyph page");
    if (!g.partial) {
      const gpuCost = pow2(value.width) * pow2(value.height) * 4;
      const reservedGpu = [...glyphs.values()].filter(item => item !== g && item.refs > 0).reduce((sum, item) => sum + item.gpuCost, 0);
      if (!evict(value.total) || reservedGpu + gpuCost > gpuLimit) throw Error("Text exceeds the available glyph residency budget");
      g.bytes = value.total; g.gpuCost = gpuCost; cpuBytes += g.bytes;
      g.partial = { glyph: g.id, width: value.width, height: value.height, left: value.left, top: value.top, coverage: new Uint8Array(value.total) };
    } else if (g.partial.width !== value.width || g.partial.height !== value.height || g.partial.left !== value.left || g.partial.top !== value.top)
      throw Error("Glyph changed during transfer");
    g.partial.coverage.set(chunk, offset);
    if (value.next === null) { g.bitmap = g.partial; g.partial = undefined; g.offset = 0; }
    else g.offset = value.next;
  };
  const fetchGlyphs = (b: Batch) => {
    while (rasterRequests.size < 2) {
      const available = b.glyphs.filter(g => !g.bitmap && !g.gpu && !g.busy);
      if (!available.length) break;
      const continuation = available.find(g => g.partial);
      const group = continuation ? [continuation] : available.slice(0, 16);
      const method = continuation ? "runtime.glyph" : "runtime.glyph.batch";
      const data = continuation ? { glyph: continuation.id, offset: continuation.offset } : { glyphs: group.map(g => g.id) };
      let id = 0;
      try {
        id = client.request(method, JSON.stringify(data), result => {
          rasterRequests.delete(id); group.forEach(g => { g.busy = false; });
          if (dead || b.dead || b.stage === "done") return;
          try {
            if (!result.ok) throw Error(result.error);
            const value = JSON.parse(result.value);
            if (continuation) acceptGlyph(continuation, value);
            else {
              if (!Array.isArray(value.items) || !value.items.length || value.items.length > group.length || value.total !== group.length ||
                  value.next !== (value.items.length === group.length ? null : value.items.length)) throw Error("Invalid runtime glyph batch");
              value.items.forEach((item: unknown, i: number) => acceptGlyph(group[i], item));
            }
          } catch (error) { fail(b, error); }
        }, { session });
      } catch (error) { fail(b, error); return; }
      if (!id) break;
      group.forEach(g => { g.busy = true; }); rasterRequests.set(id, b);
    }
  };
  const appendItems = (b: Batch, kind: "glyphs" | "rows" | "carets", items: unknown[]) => {
    for (const item of items) {
      if (!Array.isArray(item) || item.length !== (kind === "glyphs" ? 7 : 4) || !item.every(finite)) throw Error("Invalid layout coordinates");
      if (kind === "glyphs") {
        if (!integer(item[0], 1) || !integer(item[4], 0, b.text.length) || !integer(item[5], item[4], b.text.length) || !integer(item[6], 0, b.meta!.rows - 1)) throw Error("Invalid glyph cluster");
        b.positions.push(Object.freeze(item) as RuntimeGlyphPosition);
      } else if (kind === "rows") {
        if (!integer(item[0], 0, b.text.length) || !integer(item[1], item[0], b.text.length) || item[2] < 0) throw Error("Invalid text row");
        b.rows.push(Object.freeze(item) as RuntimeTextRow);
      } else {
        if (!integer(item[0], 0, b.text.length) || !integer(item[3], 0, b.meta!.rows - 1)) throw Error("Invalid caret stop");
        b.carets.push(Object.freeze(item) as RuntimeCaret);
      }
    }
  };
  const stepOnce = () => {
    if (dead) return;
    if (session !== client.session()) {
      session = client.session(); if (request) client.cancel(request); request = 0; requestBatch = undefined;
      for (const id of rasterRequests.keys()) client.cancel(id);
      rasterRequests.clear();
      // A new provider session owns new identities. Invalidate consumers before dropping textures.
      for (const b of batches) { b.state = pending(); b.layout = undefined; notify(b); releaseGlyphs(b); b.pinned = false; }
      dropAllGpu();
      nativeInstance = nextNativeInstance++;
      glyphs.clear(); releases.length = 0; cpuBytes = gpuBytes = 0; font = undefined; fontError = undefined;
      budgetReady = !options.workerBudgets;
      for (const b of batches) Object.assign(b, newBatch(b.text, b.options), { listeners: b.listeners });
    }
    if (request) return;
    const b = [...batches].find(b => b.stage !== "done");
    // Continuous superseding edits can lose every prepare acknowledgement.
    // Drain keyed cleanup before admitting more work so this queue stays bounded.
    if (releases.length && (!font || b?.stage !== "prepare" || releases.length >= R.maxBatches)) {
      send("runtime.release", { key: releases[0] }, undefined, () => {});
      if (request) releases.shift();
      return;
    }
    if (!font) {
      if (fontError) return;
      if (!budgetReady) { send("runtime.budget", options.workerBudgets, undefined, () => { budgetReady = true; }); return; }
      send("runtime.font", spec, undefined, value => {
        if (!integer(value.font, 1) || ![value.ascent, value.descent, value.lineHeight].every(finite) || value.lineHeight <= 0)
          throw Error("Invalid runtime font instance");
        font = Object.freeze({ font: value.font, ascent: value.ascent, descent: value.descent, lineHeight: value.lineHeight });
      });
      return;
    }
    if (!b) return;
    if (b.stage === "prepare") {
      const releaseKeys = releases.slice(0, 32);
      send("runtime.prepare", { font: font.font, text: b.text, leaseKey: b.leaseKey, ...b.options,
        ...(releaseKeys.length ? { releases: releaseKeys } : {}) }, b, value => {
        for (const key of releaseKeys) { const index = releases.indexOf(key); if (index >= 0) releases.splice(index, 1); }
        if (!integer(value.layout, 1) || ![value.width, value.height, value.baseline].every(finite) || value.width < 0 || value.height < 0 ||
            !integer(value.glyphs, 0, R.maxUnits * 4) || !integer(value.rows, 1, R.maxUnits + 1) || !integer(value.carets, 1, R.maxUnits * 4 + 2) ||
            typeof value.truncated !== "boolean" || value.units !== b.text.length || value.missing !== 0)
          throw Error("Invalid runtime layout");
        b.layoutId = value.layout; b.meta = value;
        if (value.inline) {
          for (const kind of ["glyphs", "rows", "carets"] as const) {
            if (!Array.isArray(value.inline[kind]) || value.inline[kind].length !== value[kind]) throw Error("Invalid inline layout");
            appendItems(b, kind, value.inline[kind]);
          }
          b.stage = "admit";
        } else b.stage = "glyphs";
      });
      // The caller-supplied key permits release even if cancellation loses the reply.
      if (request) b.pinned = true;
    } else if (b.stage === "glyphs" || b.stage === "rows" || b.stage === "carets") {
      const kind = b.stage, count = b.meta![kind];
      if (count === 0) { b.stage = kind === "glyphs" ? "rows" : kind === "rows" ? "carets" : "admit"; return; }
      send("runtime.layout.page", { layout: b.layoutId, kind, offset: b.offset }, b, value => {
        if (!Array.isArray(value.items) || !value.items.length || value.items.length > 64 || value.total !== count ||
            b.offset + value.items.length > count || value.next !== (b.offset + value.items.length === count ? null : b.offset + value.items.length))
          throw Error("Invalid runtime layout page");
        appendItems(b, kind, value.items);
        if (value.next === null) { b.offset = 0; b.stage = kind === "glyphs" ? "rows" : kind === "rows" ? "carets" : "admit"; }
        else b.offset = value.next;
      });
    } else if (b.stage === "admit") {
      b.layout = Object.freeze({ id: b.layoutId, text: b.text, font, width: b.meta!.width, height: b.meta!.height,
        baseline: b.meta!.baseline, truncated: b.meta!.truncated,
        glyphs: Object.freeze(b.positions), rows: Object.freeze(b.rows), carets: Object.freeze(b.carets) });
      for (const id of new Set(b.positions.map(g => g[0]))) {
        let glyph = glyphs.get(id);
        if (!glyph) { glyph = { id, refs: 0, used: ++clock, gpu: false, bytes: 0, gpuCost: 0 }; glyphs.set(id, glyph); }
        glyph.refs++; b.glyphs.push(glyph);
      }
      b.stage = "bitmap"; notify(b);
    } else if (b.stage === "bitmap") {
      if (b.glyphs.every(g => g.bitmap || g.gpu)) { b.stage = "upload"; b.current = 0; return; }
      fetchGlyphs(b);
    } else if (b.stage === "upload") {
      const g = b.glyphs[b.current++];
      if (g) {
        if (!g.gpu) {
          if (!evictGpu(g.gpuCost)) { fail(b, Error("Runtime GPU residency budget exceeded")); return; }
          if (!host.fontStreamCommit!(runtimeGlyphPacket(nativeInstance, g.bitmap!))) { fail(b, Error("Runtime GPU residency budget exceeded")); return; }
          g.gpu = true; gpuBytes += g.gpuCost; uploads++; uploadedBytes += g.gpuCost;
        }
      } else {
        const layout = b.layout!, instance = nativeInstance;
        const value: PreparedText = Object.freeze({ text: b.text, slot: 0, layout,
          paint(node: number) {
            if (b.dead || b.state.status !== "ready" || b.state.value !== value) return false;
            return host.fontStreamCommit!(runtimeLayoutPacket(node, layout, instance)) === 1;
          },
          clear(node: number) { host.fontStreamCommit!(runtimeClearPacket(node)); },
        });
        b.state = ready(value); b.stage = "done"; notify(b);
      }
    }
  };
  const step = () => {
    const startedBytes = uploadedBytes;
    for (let operations = 0; operations < 64; operations++) {
      const b = [...batches].find(b => b.stage !== "done"), before = b && `${b.stage}/${b.current}/${b.offset}`;
      stepOnce();
      if (dead || request || uploadedBytes - startedBytes >= 16 * 1024) break;
      const after = b && `${b.stage}/${b.current}/${b.offset}`;
      if (before === after) break;
    }
  };
  const unregister = registerServicePump(step);
  return {
    prepareText(text, layoutOptions = {}) {
      if (dead) throw Error("Runtime font is disposed");
      validateOptions(layoutOptions);
      if (typeof text !== "string" || text.length > R.maxUnits) throw Error(`Runtime text exceeds ${R.maxUnits} UTF-16 units`);
      for (const scalar of text) if (/^[\uD800-\uDFFF]$/.test(scalar)) throw Error("Text contains an unpaired surrogate");
      if (batches.size >= R.maxBatches) throw Error("Runtime text batch count exceeds budget");
      const b = newBatch(text, layoutOptions); batches.add(b);
      if (fontError) fail(b, fontError);
      return {
        state: () => b.state,
        layout: () => b.layout,
        subscribe(listener) { if (b.dead) return () => {}; b.listeners.add(listener); return () => { b.listeners.delete(listener); }; },
        dispose() {
          if (b.dead) return;
          b.dead = true; b.state = failed(Error("Text batch is disposed")); notify(b);
          if (requestBatch === b && request) { client.cancel(request); request = 0; requestBatch = undefined; }
          for (const [id, owner] of rasterRequests) if (owner === b) { client.cancel(id); rasterRequests.delete(id); }
          releaseGlyphs(b); releaseLayout(b); batches.delete(b); b.listeners.clear();
        },
      };
    },
    stats: () => ({ bitmapBytes: cpuBytes, gpuBytes, glyphs: glyphs.size, batches: batches.size, uploads, uploadedBytes, evictions }),
    dispose() {
      if (dead) return;
      if (request) client.cancel(request);
      for (const id of rasterRequests.keys()) client.cancel(id);
      rasterRequests.clear();
      for (const b of batches) { b.dead = true; b.state = failed(Error("Runtime font is disposed")); notify(b); releaseGlyphs(b); releaseLayout(b); b.listeners.clear(); }
      dropAllGpu();
      batches.clear(); glyphs.clear(); cpuBytes = 0; dead = true; unregister();
      // Releases are bounded by maxBatches; offload's pending limit provides backpressure.
      const releaseSession = session, cleanupRequests = new Set<number>();
      const releasePump = registerServicePump(() => {
        if (client.session() !== releaseSession) {
          for (const id of cleanupRequests) client.cancel(id);
          releasePump(); return;
        }
        if (!releases.length) { if (!cleanupRequests.size) releasePump(); return; }
        const id = client.request("runtime.release", JSON.stringify({ key: releases[0] }), () => { cleanupRequests.delete(id); }, { session: releaseSession });
        if (id) { releases.shift(); cleanupRequests.add(id); }
      });
    },
  };
}

export function openRuntimeFont(options: RuntimeFontOptions): RuntimeFont {
  return createRuntimeFont(options, getOps(), offload(options.provider ?? "local"));
}
