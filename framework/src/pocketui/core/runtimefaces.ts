// PocketUI core/runtimefaces.ts — the run-time faces' bookkeeping: which
// characters are asked for, which request is on its way, when a face's table
// is written out and loaded. No host and no signals here (ui/runtimetext.ts
// supplies the frame, the slot's loader and the two notifications), so the
// whole of it runs under a unit test.
import { ASCII_CODEPOINTS, GlyphTable, parseAtlas, planParts } from "./glyphfont.ts";
import type { Measure } from "./text.ts";
import type { Face } from "./theme.ts";

export interface GlyphRequest {
  px: number;
  bold: boolean;
  slot: number;
  /** device pixels to a point: the atlas is drawn at px x density */
  density: number;
  /** the characters wanted, each once */
  text: string;
  /** false: only the characters of `text`. A service that does not know the field adds printable ASCII, which is harmless. */
  ascii: boolean;
}

/** The application's way to its glyph service. */
export interface GlyphTransport {
  /** The atlas of a request's characters; rejects when the service cannot be reached or refuses. */
  atlas(request: GlyphRequest): Promise<Uint8Array>;
  /** UTF-8 bytes of characters one request can name (default 600) */
  textBytes?: number;
  /** the largest reply it takes, in bytes (default 256 KiB) */
  responseBytes?: number;
}

export interface RuntimeFacesOptions {
  transport: GlyphTransport;
  /** device pixels to a point (platform.pixelRatio) */
  density: number;
  /** the two faces: slot, size and line */
  regular: Face;
  bold: Face;
  /** glyphs a face holds before the least recently named go (default 4096) */
  capacity?: number;
  /** frames between loads of glyphs nothing on screen is waiting for (default 20) */
  idleLoadFrames?: number;
  /** hand an atlas to its slot (the host's loadFontAtlas) */
  load: (atlas: Uint8Array) => void;
  /** glyphs loaded: the texts that waited lay out again */
  onRevision: () => void;
  /** what a text resolved to may no longer hold though no glyph arrived: every text outside ASCII resolves again, synchronously */
  onEpoch: () => void;
}

export interface FaceStats {
  slot: number;
  /** glyphs held, and the bytes of their cells */
  glyphs: number;
  bytes: number;
  /** characters asked for and not yet here */
  waiting: number;
  /** requests sent, the characters they named, the bytes of their replies */
  requests: number;
  asked: number;
  replyBytes: number;
  /** atlases loaded into the slot, the time that took in all and the last time, in ms */
  loads: number;
  loadMs: number;
  lastLoadMs: number;
  /** bytes of the atlas in the slot */
  atlasBytes: number;
  /** glyphs dropped past the capacity */
  evictions: number;
  /** requests that failed */
  failures: number;
}

export interface RuntimeTextStats {
  regular: FaceStats;
  bold: FaceStats;
  /** frames in which some drawn text was waiting for a glyph */
  waitingFrames: number;
}

export interface RuntimeFaces {
  /** The face in that weight, or null while the service has answered nothing and the last request failed. */
  face(bold: boolean): Face | null;
  /** `text` is about to be drawn in that weight. Whether every glyph of it is here; the rest are asked for. */
  want(text: string, bold: boolean): boolean;
  /** The width of text in `slot`, when it is one of the two. */
  measure(slot: number): Measure | null;
  /** Once a frame: load what arrived, send what is asked for. */
  tick(): void;
  /** Fetch the characters of `texts` ahead of their being drawn (a transcript that just arrived, a list's names): behind anything on screen, and never at the cost of a glyph that is held. */
  prefetch(texts: readonly string[], bold?: boolean): void;
  /** Whether nothing is asked for, on its way or waiting to load. */
  settled(): boolean;
  stats(): RuntimeTextStats;
  dispose(): void;
}

interface State {
  face: Face;
  bold: boolean;
  table: GlyphTable;
  measure: Measure;
  /** asked for by text that is drawn: sent newest first */
  urgent: number[];
  /** asked for ahead of time */
  later: number[];
  /** every codepoint in `urgent`, `later` or on its way; true when a text is waiting for it */
  queued: Map<number, boolean>;
  /** the table holds glyphs the slot's atlas does not have yet: `fresh` names the ones that were asked for */
  dirty: boolean;
  fresh: Set<number>;
  /** a text is waiting for one of `fresh`: load at the next frame */
  hurry: boolean;
  loadedAt: number;
  warmed: boolean;
  stats: FaceStats;
}

/** Frames before a failed request is tried again: three seconds at 60 Hz, doubling to a minute. */
const RETRY_FRAMES = 180;
const RETRY_MOST = 3600;

const now = (): number => (typeof performance !== "undefined" ? performance.now() : Date.now());

/** The two faces over a transport. */
export function createRuntimeFaces(options: RuntimeFacesOptions): RuntimeFaces {
  const transport = options.transport;
  const density = Math.max(1, Math.round(options.density));
  const capacity = options.capacity ?? 4096;
  const idleLoadFrames = options.idleLoadFrames ?? 20;
  const load = options.load;

  const state = (face: Face, bold: boolean): State => {
    const table = new GlyphTable(face.size, capacity);
    return {
      face,
      bold,
      table,
      measure: (text) => table.measure(text),
      urgent: [],
      later: [],
      queued: new Map(),
      dirty: false,
      fresh: new Set(),
      hurry: false,
      loadedAt: 0,
      warmed: false,
      stats: { slot: face.slot, glyphs: 0, bytes: 0, waiting: 0, requests: 0, asked: 0, replyBytes: 0, loads: 0, loadMs: 0, lastLoadMs: 0, atlasBytes: 0, evictions: 0, failures: 0 },
    };
  };
  const regular = state(options.regular, false);
  const bold = state(options.bold, true);
  const states = [regular, bold];

  // what one request can carry: its text, and a reply of the widest cells a face of this size has (two ems by 1.4)
  const textBytes = transport.textBytes ?? 600;
  const responseBytes = transport.responseBytes ?? 256 * 1024;
  const most = (px: number): number => Math.max(8, Math.floor((responseBytes - 1024) / (8 + (2 * px + 2) * Math.ceil(1.4 * px) * density * density)));

  let frame = 0;
  let flying = false;
  /** the request on its way is for text that is drawn */
  let flyingWaited = false;
  /** the last request failed: none before `retryAt` */
  let lost = false;
  /** a reply settled characters a text waited for without adding a glyph (no font has them) */
  let settledSome = false;
  let retryAt = 0;
  let retryIn = RETRY_FRAMES;
  let disposed = false;
  let waitingFrames = 0;
  const scratch: number[] = [];

  /** Printable ASCII, once a face is used: the words it draws whole (a name with an accent) and the field that types in it need it. */
  const warm = (s: State): void => {
    if (s.warmed) return;
    s.warmed = true;
    for (const cp of ASCII_CODEPOINTS) {
      if (s.queued.has(cp) || s.table.has(cp)) continue;
      s.queued.set(cp, true);
      s.urgent.push(cp);
    }
  };

  const want = (text: string, isBold: boolean): boolean => {
    const s = isBold ? bold : regular;
    warm(s);
    scratch.length = 0;
    const missing = s.table.missing([text], scratch);
    if (missing.length === 0) {
      // All here, so its layout is final. The slot may not have the newest of
      // them yet (glyphs asked ahead load at leisure): then it loads now.
      if (s.fresh.size > 0 && !s.hurry) {
        for (let at = 0; at < text.length; at++) {
          if (s.fresh.has(text.codePointAt(at)!)) {
            s.hurry = true;
            break;
          }
        }
      }
      return true;
    }
    for (const cp of missing) {
      const queued = s.queued.get(cp);
      if (queued === true) continue;
      s.queued.set(cp, true);
      // asked ahead of time before: it moves to the front
      if (queued === false) {
        const at = s.later.indexOf(cp);
        if (at >= 0) s.later.splice(at, 1);
        else continue; // on its way already
      }
      s.urgent.push(cp);
    }
    return false;
  };

  const prefetch = (texts: readonly string[], isBold = false): void => {
    const s = isBold ? bold : regular;
    const room = Math.floor(capacity * 0.75) - s.table.size - s.later.length - s.urgent.length;
    if (room <= 0) return;
    scratch.length = 0;
    const missing = s.table.missing(texts, scratch);
    let taken = 0;
    for (const cp of missing) {
      if (cp < 0x80 || s.queued.has(cp)) continue;
      if (taken++ >= room) break;
      s.queued.set(cp, false);
      s.later.push(cp);
    }
  };

  const failed = (s: State, part: number[], waited: boolean): void => {
    s.stats.failures++;
    // back at the front of its queue, for the next try
    for (let index = part.length - 1; index >= 0; index--) {
      const cp = part[index]!;
      if (waited && s.queued.get(cp) === true) s.urgent.push(cp);
      else s.later.unshift(cp);
    }
    retryAt = frame + retryIn;
    retryIn = Math.min(RETRY_MOST, retryIn * 2);
    if (!lost) {
      lost = true;
      // a face that never loaded has nothing to draw with: its texts show placeholders
      options.onEpoch();
    }
  };

  const send = (s: State): boolean => {
    const waited = s.urgent.length > 0;
    const queue = waited ? s.urgent : s.later;
    if (queue.length === 0) return false;
    // the newest of what is on screen first; what was asked ahead in its order
    const limit = most(s.face.size);
    let part: number[];
    if (waited) {
      part = planParts([...queue].reverse(), textBytes, limit)[0]!;
      queue.length -= part.length;
      // room left in the request: what was asked ahead rides along, one reply and one load for both
      let bytes = 0;
      for (const cp of part) bytes += cp < 0x80 ? 1 : cp < 0x800 ? 2 : cp < 0x10000 ? 3 : 4;
      while (s.later.length > 0 && part.length < limit) {
        const cp = s.later[0]!;
        bytes += cp < 0x80 ? 1 : cp < 0x800 ? 2 : cp < 0x10000 ? 3 : 4;
        if (bytes > textBytes) break;
        part.push(cp);
        s.later.shift();
      }
    } else {
      part = planParts(queue, textBytes, limit)[0]!;
      queue.splice(0, part.length);
    }
    flying = true;
    flyingWaited = waited;
    s.stats.requests++;
    s.stats.asked += part.length;
    let reply: Promise<Uint8Array>;
    try {
      reply = transport.atlas({ px: s.face.size, bold: s.bold, slot: s.face.slot, density, text: String.fromCodePoint(...part), ascii: false });
    } catch (error) {
      reply = Promise.reject(error);
    }
    reply.then(
      (bytes) => {
        flying = false;
        if (disposed) return;
        const atlas = parseAtlas(bytes);
        const added = atlas ? s.table.add(atlas, part) : -1;
        if (added < 0) return failed(s, part, waited);
        s.stats.replyBytes += bytes.length;
        // asked ahead, and a text came to want one of them while it was on its way
        let wanted = waited;
        for (const cp of part) {
          if (s.queued.get(cp) === true) wanted = true;
          s.queued.delete(cp);
          if (s.table.has(cp)) s.fresh.add(cp);
        }
        if (added > 0) s.dirty = true;
        if (wanted) {
          if (added > 0) s.hurry = true;
          else settledSome = true;
        }
        retryIn = RETRY_FRAMES;
        if (lost) {
          lost = false;
          options.onEpoch();
        }
      },
      () => {
        flying = false;
        if (!disposed) failed(s, part, waited);
      },
    );
    return true;
  };

  /** Write the table out and hand it to the slot. */
  const commit = (s: State): void => {
    if (s.table.size > capacity) {
      // every mounted text names its characters again, so the ones that go are the ones nothing mounted draws
      options.onEpoch();
      s.table.evict();
      s.stats.evictions = s.table.evictions;
    }
    const started = now();
    const atlas = s.table.build(s.face.slot, s.bold);
    if (atlas) {
      load(atlas);
      s.stats.loads++;
      s.stats.atlasBytes = atlas.length;
      s.stats.lastLoadMs = now() - started;
      s.stats.loadMs += s.stats.lastLoadMs;
    }
    s.dirty = false;
    s.fresh.clear();
    s.hurry = false;
    s.loadedAt = frame;
  };

  const tick = (): void => {
    if (disposed) return;
    frame++;
    let loaded = settledSome;
    settledSome = false;
    let waiting = flying && flyingWaited;
    for (const s of states) {
      if (s.urgent.length > 0 || s.hurry) waiting = true;
      if (s.dirty && (s.hurry || frame - s.loadedAt >= idleLoadFrames || (s.later.length === 0 && !flying))) {
        commit(s);
        loaded = true;
      }
    }
    if (waiting) waitingFrames++;
    // one signal for everything that loaded this frame: the texts that waited lay out once
    if (loaded) options.onRevision();
    if (!flying && frame >= retryAt) {
      // text on screen before anything asked ahead; regular before bold
      if (!(regular.urgent.length > 0 && send(regular)) && !(bold.urgent.length > 0 && send(bold)) && !send(regular)) send(bold);
    }
  };
  warm(regular);

  const statsOf = (s: State): FaceStats => {
    s.stats.glyphs = s.table.size;
    s.stats.bytes = s.table.bytes;
    s.stats.waiting = s.queued.size;
    return { ...s.stats };
  };
  return {
    // nothing ever came and the last request failed: the service is not there, and the baked face's placeholders stand in
    face: (isBold) => (lost && (isBold ? bold : regular).stats.loads === 0 ? null : (isBold ? bold : regular).face),
    want,
    measure: (slot) => (slot === regular.face.slot ? regular.measure : slot === bold.face.slot ? bold.measure : null),
    tick,
    prefetch,
    settled: () => !flying && states.every((s) => s.urgent.length === 0 && s.later.length === 0 && !s.dirty),
    stats: () => ({ regular: statsOf(regular), bold: statsOf(bold), waitingFrames }),
    dispose() {
      disposed = true;
    },
  };
}
