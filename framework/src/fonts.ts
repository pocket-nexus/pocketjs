import { getOps, type HostOps } from "./host.ts";
import { offload, type createOffloadClient } from "./offload.ts";
import { registerServicePump } from "./services.ts";
import { pending, ready, failed, type ResourceState } from "./resource-state.ts";
import { FONT_ARCHIVE as F, decodeArchiveFace, type ArchiveFace, type ArchiveStrike } from "../../contracts/spec/font-archive.ts";

type Client = ReturnType<typeof createOffloadClient>;
export interface PreparedText { readonly text: string; readonly slot: number }
/** A lease owns every glyph until dispose. Reads never initiate I/O. */
export interface TextResource {
  state(): ResourceState<PreparedText>;
  subscribe(changed: () => void): () => void;
  dispose(): void;
}
export interface FontArchiveOptions {
  /** Provider-relative path, confined by the provider. */
  path: string;
  slots: number[];
  /** Source cells per slot; 1..4096, subject to the core's shared 2 MiB cap. */
  capacity?: number;
  /** Extra source bitmap budget for this controller, at most 2 MiB. */
  maxBytes?: number;
  /** Loaded before dynamic batches and held until the archive is disposed. */
  resident?: readonly PreparedText[];
  /** Both providers use the same archive protocol and batch scheduler. */
  provider?: "companion" | "local";
  onChange?: () => void;
}
export interface FontArchiveStatus {
  state: "opening" | "warming" | "ready" | "error" | "disposed";
  identity: string;
  error: string;
  requests: number;
  loaded: number;
  paused: boolean;
}
const config = (s: ArchiveStrike, generation: number, capacity: number) => {
  const b = new Uint8Array(20), v = new DataView(b.buffer);
  v.setUint32(0, F.configMagic, true); v.setUint32(4, generation, true);
  b.set([s.slot, s.width, s.height, s.baseline, s.lineHeight, s.advance, s.density], 8);
  v.setUint16(16, capacity, true);
  return b;
};
function decodeHex(s: string): Uint8Array {
  if (s.length < 24 || s.length > 2500 || s.length % 2 || !/^[0-9a-f]+$/.test(s)) throw new Error("Invalid font reply");
  const b = new Uint8Array(s.length / 2);
  for (let i = 0; i < b.length; i++) {
    const hi = s.charCodeAt(i * 2), lo = s.charCodeAt(i * 2 + 1);
    b[i] = ((hi <= 57 ? hi - 48 : hi - 87) << 4) | (lo <= 57 ? lo - 48 : lo - 87);
  }
  return b;
}
const reason = (code: number) => new Error(code === -1 ? "Font has no glyph for this text" : code === -2
  ? "Text exceeds the available glyph residency budget" : "Invalid or stale text batch");

/** One owner of streamed slots. Admission reserves the entire union before I/O;
 * batches, including invisible prefetches, remain pinned through ready. */
export function createFontArchive(options: FontArchiveOptions, host: HostOps, client: Client) {
  if (!host.fontStreamConfigure || !host.fontStreamCommit || !host.fontStreamRequests || !host.fontStreamStats || !host.fontStreamBatch)
    throw new Error("Host does not implement text.glyphs.streamed batches");
  const capacity = options.capacity ?? 1024, maxBytes = options.maxBytes ?? F.maxResidentBytes,
    slots = [...new Set(options.slots)];
  if (!Number.isInteger(capacity) || capacity < 1 || capacity > F.maxResidentEntries ||
      !Number.isInteger(maxBytes) || maxBytes < 1 || maxBytes > F.maxResidentBytes || !slots.length ||
      slots.some(s => !Number.isInteger(s) || s < 0 || s >= 24)) throw new Error("Invalid font residency configuration");
  if (!/^[a-zA-Z0-9_./-]{1,127}$/.test(options.path) || options.path.includes("..") || options.path.startsWith("/"))
    throw new Error("Invalid font path");
  const status: FontArchiveStatus = { state: "opening", identity: "", error: "", requests: 0, loaded: 0, paused: false };
  type Batch = { id: number; value: PreparedText; scalars: number[]; common: boolean; admitted: boolean;
    state: ResourceState<PreparedText>; listeners: Set<() => void>; descriptor: Uint8Array };
  const batches = new Set<Batch>(), requests = new Set<number>(), inflight = new Set<string>(),
    retries = new Map<string, { frame: number; attempts: number }>();
  let face: ArchiveFace | undefined, configured: ArchiveStrike[] = [], frame = 0, serial = 0,
    nextId = 1, opening = false, session = client.session(), lastSlot = -1, dead = false;
  const changed = () => options.onChange?.();
  const publish = (b: Batch, state: ResourceState<PreparedText>) => {
    if (b.state.status === state.status && state.status !== "error") return;
    b.state = state;
    for (const fn of b.listeners) fn();
    if (state.status === "error" && b.admitted && face) {
      command(b, 2); b.admitted = false;
    }
  };
  const command = (b: Batch, action: number) => {
    const v = new DataView(b.descriptor.buffer);
    v.setUint32(4, face!.generation, true); b.descriptor[9] = action;
    return host.fontStreamBatch!(action === 0 ? b.descriptor : b.descriptor.subarray(0, 16));
  };
  const refresh = () => {
    for (const b of batches) if (b.admitted && b.state.status === "pending") {
      const result = command(b, 1);
      if (result === 1) publish(b, ready(b.value));
      else if (result < 0) publish(b, failed(reason(result)));
    }
    const common = [...batches].filter(b => b.common);
    const error = common.find(b => b.state.status === "error");
    if (error) {
      status.state = "error"; status.error = "Resident character set could not be loaded";
      for (const b of batches) if (b.state.status === "pending") publish(b, failed(new Error(status.error)));
    }
    else if (face) status.state = common.every(b => b.state.status === "ready") ? "ready" : "warming";
    changed();
  };
  const admit = (b: Batch) => {
    if (!face || b.admitted || b.state.status === "error") return;
    const result = command(b, 0);
    b.admitted = result >= -1;
    if (result === 1) publish(b, ready(b.value));
    else if (result < 0) publish(b, failed(reason(result)));
  };
  function prepare(text: string, slot: number, common = false): TextResource {
    if (dead) throw new Error("Font archive is disposed");
    if (!slots.includes(slot) || typeof text !== "string" || text.length > F.maxTextLength)
      throw new Error("Invalid text batch or text exceeds 65536 UTF-16 units");
    const set = new Set<number>();
    for (const c of text) {
      const cp = c.codePointAt(0)!;
      if (cp >= 0xd800 && cp <= 0xdfff) throw new Error("Text contains an unpaired surrogate");
      if (cp >= 32) set.add(cp);
      if (set.size > F.maxResidentEntries) throw new Error("Text has too many unique scalars");
    }
    if (batches.size >= F.maxBatches) throw new Error("Text batch count exceeds budget");
    const scalars = [...set], descriptor = new Uint8Array(16 + scalars.length * 4), v = new DataView(descriptor.buffer);
    const id = nextId++;
    if (id > 0xffffffff) throw new Error("Text batch ids exhausted");
    v.setUint32(0, F.batchMagic, true); descriptor[8] = slot; v.setUint32(12, id, true);
    scalars.forEach((cp, i) => v.setUint32(16 + i * 4, cp, true));
    const b: Batch = { id, value: Object.freeze({ text, slot }), scalars, common, admitted: false,
      state: pending(), listeners: new Set(), descriptor };
    batches.add(b);
    if (status.state === "error") publish(b, failed(new Error(status.error)));
    if (face && (common || status.state === "ready")) { admit(b); refresh(); }
    let disposed = false;
    return {
      state: () => b.state,
      subscribe(fn) { if (disposed) return () => {}; b.listeners.add(fn); return () => { b.listeners.delete(fn); }; },
      dispose() {
        if (disposed) return; disposed = true;
        // Invalidate consumers before releasing native pins.
        publish(b, failed(new Error("Text batch is disposed")));
        if (b.admitted && face) command(b, 2);
        batches.delete(b); b.listeners.clear();
      },
    };
  }
  const reset = () => {
    serial++;
    for (const id of requests) client.cancel(id);
    requests.clear(); inflight.clear(); retries.clear(); opening = false;
    for (const b of batches) { b.admitted = false; publish(b, pending()); }
    for (const s of configured) host.fontStreamConfigure!(config(s, 0, 0));
    configured = []; face = undefined;
    status.state = "opening"; status.error = ""; changed();
  };
  const fail = (message: string) => {
    status.state = "error"; status.error = message;
    for (const b of batches) if (b.state.status === "pending") publish(b, failed(new Error(message)));
    changed();
  };
  const open = () => {
    opening = true;
    const token = serial;
    const id = client.request("font.open", options.path, result => {
      requests.delete(id);
      if (token !== serial) return;
      opening = false;
      if (!result.ok) { fail(result.error); return; }
      try {
        const value = decodeArchiveFace(result.value);
        const strikes = slots.map(slot => {
          const s = value.strikes.find(s => s.slot === slot);
          if (!s) throw new Error(`Font slot ${slot} unavailable`);
          return s;
        });
        if (strikes.reduce((n, s) => n + s.width * s.height * capacity, 0) > maxBytes)
          throw new Error("Font source bitmap budget exceeded");
        for (const s of strikes) {
          if (!host.fontStreamConfigure!(config(s, value.generation, capacity)))
            throw new Error(`Font slot ${s.slot} incompatible or exceeds residency budget`);
          configured.push(s);
        }
        // Account for the host's padding of baked cells as well.
        if (JSON.parse(host.fontStreamStats!()).bytes > maxBytes) throw new Error("Font source bitmap budget exceeded");
        face = value; status.identity = value.identity; status.error = "";
        for (const b of batches) if (b.common) admit(b);
        refresh();
      } catch (e) {
        for (const s of configured) host.fontStreamConfigure!(config(s, 0, 0));
        configured = []; face = undefined; fail(String(e));
      }
    });
    if (id) { requests.add(id); status.requests++; } else opening = false;
  };
  const step = () => {
    if (dead) return;
    frame++;
    const current = client.session();
    if (current !== session) { session = current; reset(); }
    if (!face) {
      if (status.state !== "error" && !opening) open(); // offload supplies a bounded unavailable timeout
      return;
    }
    let loading = false;
    for (const b of batches) {
      if (status.state === "ready") admit(b);
      loading ||= b.admitted && b.state.status === "pending";
    }
    if (!loading || status.paused || requests.size >= 2 || status.state === "error") return;
    const demand = JSON.parse(host.fontStreamRequests!()) as number[][];
    const available = demand.filter(([g, s, cp]) => g === face!.generation && slots.includes(s) &&
      !inflight.has(`${s}:${cp}`) && (retries.get(`${s}:${cp}`)?.frame ?? 0) <= frame);
    if (!available.length) return;
    const slot = [...new Set(available.map(r => r[1]))].sort((a, b) => a - b).find(s => s > lastSlot) ?? available[0][1];
    lastSlot = slot;
    const strike = face.strikes.find(s => s.slot === slot)!;
    const packed = Math.ceil(strike.width * strike.height / 4), stride = 8 + packed;
    const count = Math.min(F.maxBatch, Math.floor((1250 - 12) / stride));
    const scalars = available.filter(r => r[1] === slot).slice(0, count).map(r => r[2]);
    const keys = scalars.map(cp => `${slot}:${cp}`), token = serial;
    const id = client.request("font.glyphs", JSON.stringify({ generation: face.generation, slot, scalars }), result => {
      requests.delete(id);
      if (token !== serial) return;
      keys.forEach(k => inflight.delete(k));
      let error = "";
      try {
        if (!result.ok) throw new Error(result.error);
        const bytes = decodeHex(result.value), v = new DataView(bytes.buffer);
        if (bytes.length !== 12 + scalars.length * stride || v.getUint32(0, true) !== F.glyphMagic ||
            v.getUint32(4, true) !== face!.generation || bytes[8] !== slot || bytes[9] !== scalars.length ||
            bytes[10] !== strike.width || bytes[11] !== strike.height || scalars.some((cp, i) =>
              v.getUint32(12 + i * stride, true) !== cp || bytes[17 + i * stride] > strike.width ||
              bytes[18 + i * stride] > 1 || bytes[19 + i * stride] !== 0))
          throw new Error("Font reply does not match the requested batch");
        status.loaded += host.fontStreamCommit!(bytes);
        status.error = "";
      } catch (e) { error = String(e); status.error = error; }
      refresh();
      for (let i = 0; i < keys.length; i++) {
        const key = keys[i], cp = scalars[i];
        if (!error) { retries.delete(key); continue; }
        const waiting = [...batches].filter(b => b.value.slot === slot && b.state.status === "pending" && b.scalars.includes(cp));
        if (!waiting.length) { retries.delete(key); continue; }
        const attempts = (retries.get(key)?.attempts ?? 0) + 1;
        if (attempts >= 3) {
          for (const b of waiting) publish(b, failed(new Error(error || "Glyph commit failed")));
          retries.delete(key);
        } else retries.set(key, { frame: frame + 30 * attempts, attempts });
      }
      refresh();
    });
    if (id) { requests.add(id); keys.forEach(k => inflight.add(k)); status.requests++; }
  };
  // Validate configuration before registering the pump or starting any I/O.
  for (const r of options.resident ?? []) prepare(r.text, r.slot, true);
  const unregister = registerServicePump(step);
  return {
    prepareText: (text: string, options: { slot: number }) => prepare(text, options.slot),
    status: () => ({ ...status }),
    stats: () => JSON.parse(host.fontStreamStats!()) as {
      resident: number; bytes: number; pending: number; evictions: number; rejected: number; unsupported: number;
    },
    pause(value: boolean) { status.paused = value; changed(); },
    reload() { if (!dead) reset(); },
    dispose() {
      if (dead) return;
      reset(); dead = true; unregister();
      for (const b of batches) { publish(b, failed(new Error("Font archive is disposed"))); b.listeners.clear(); }
      batches.clear(); client.request("font.close", "", () => {});
      status.state = "disposed"; changed();
    },
  };
}
let active: ReturnType<typeof createFontArchive> | undefined;
/** Companion is the default; local uses the PSP worker with the same protocol. */
export function openFontArchive(options: FontArchiveOptions) {
  if (active && active.status().state !== "disposed") throw new Error("A font archive is already open");
  return (active = createFontArchive(options, getOps(), offload(options.provider ?? "companion")));
}
