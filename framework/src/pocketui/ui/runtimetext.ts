// PocketUI ui/runtimetext.ts — text in any script: the run-time faces.
//
// The baked faces hold ASCII. Everything else (Chinese above all, kana,
// hangul, accented Latin, Cyrillic, Greek, emoji: whatever the device has a
// font for) is drawn from two faces made while the application runs, regular
// and bold, each a table of glyphs (core/glyphfont.ts) that only ever GROWS:
//
//   - a text names the characters it draws (`want`); the ones the table lacks
//     are asked of the application's transport, a few hundred to a request,
//     and only those: a reply is the new glyphs, never the face again;
//   - a reply's glyphs join the table, the table is written out as one font
//     atlas and loaded into the face's slot: once per frame at most, however
//     many replies landed, and one signal moves, so the texts that were
//     waiting lay out once;
//   - a glyph that is here stays. Scrolling a transcript up and down asks for
//     nothing and loads nothing. The table holds `capacity` glyphs (4096: the
//     everyday set of Chinese and Japanese together); past it the ones no
//     mounted text has named for longest go, never one that is on screen.
//
// A glyph is a codepoint and text runs left to right. There is no shaping, no
// joining and no right-to-left: that is what keeps a glyph a table lookup and
// a paragraph's width a sum.
//
// An application installs it once with the transport to its glyph service:
//
//   installRuntimeText({ density: platform.pixelRatio, transport: { atlas: (request) => post("/glyphs/atlas", request) } });
//
// The reply is a FONT ATLAS v3 (PocketJS contracts/spec) of the request's
// characters at the request's size, weight and density; with `ascii: false`
// a service may leave printable ASCII out unless the text names it.
import { createSignal } from "solid-js";
import { getOps } from "../../host.ts";
import { onFrame } from "../../lifecycle.ts";
import { createRuntimeFaces, type GlyphTransport, type RuntimeTextStats } from "../core/runtimefaces.ts";
import { RICH_BOLD_FACE, RICH_FACE } from "../core/theme.ts";
import { setTextSource, textCounters } from "./textview.ts";
import type { Face } from "./theme.ts";

export type { FaceStats, GlyphRequest, GlyphTransport, RuntimeTextStats } from "../core/runtimefaces.ts";

export interface RuntimeTextOptions {
  transport: GlyphTransport;
  /** device pixels to a point (platform.pixelRatio) */
  density: number;
  /** the two faces: slot, size and line (default the theme module's RICH_FACE and RICH_BOLD_FACE: 13 px in slots 21 and 22) */
  regular?: Face;
  bold?: Face;
  /** glyphs a face holds before the least recently named go (default 4096) */
  capacity?: number;
  /** frames between loads of glyphs nothing on screen is waiting for (default 20) */
  idleLoadFrames?: number;
}

export interface RuntimeText {
  /** Whether the host can load a face at all; false leaves text as it was without this module. */
  readonly available: boolean;
  /** Fetch the characters of `texts` ahead of their being drawn (a transcript that just arrived, a list's names): behind anything on screen, and never at the cost of a glyph that is held. */
  prefetch(texts: readonly string[], bold?: boolean): void;
  /** Whether nothing is asked for, on its way or waiting to load. */
  settled(): boolean;
  /** The faces' counts, with: `revision`, the loads that reached texts; `layouts`, paragraphs broken into lines since the realm began; `relayouts`, those of them broken again because their glyphs arrived. */
  stats(): RuntimeTextStats & { revision: number; layouts: number; relayouts: number };
  /** a signal read: bumps when glyphs load */
  revision(): number;
  dispose(): void;
}

/** Install the run-time faces for this realm: Text, RichText and the editor
 *  draw from them from now on. Call it before the tree is mounted. The handle
 *  is also at `globalThis.__pocketUIText`, for a simulator and a debugger. */
export function installRuntimeText(options: RuntimeTextOptions): RuntimeText {
  const ops = getOps();
  const [revision, setRevision] = createSignal(0);
  const [epoch, setEpoch] = createSignal(0);
  if (!ops.loadFontAtlas) {
    return { available: false, prefetch() {}, settled: () => true, stats: () => ({ ...EMPTY, revision: 0, ...textCounters }), revision, dispose() {} };
  }
  const faces = createRuntimeFaces({
    transport: options.transport,
    density: options.density,
    regular: options.regular ?? RICH_FACE,
    bold: options.bold ?? RICH_BOLD_FACE,
    capacity: options.capacity,
    idleLoadFrames: options.idleLoadFrames,
    load: (atlas) => void ops.loadFontAtlas!(atlas),
    onRevision: () => setRevision((value) => value + 1),
    onEpoch: () => setEpoch((value) => value + 1),
  });
  let live = true;
  onFrame(() => {
    if (live) faces.tick();
  });
  setTextSource({ face: faces.face, want: faces.want, measure: faces.measure, revision, epoch });
  const handle: RuntimeText = {
    available: true,
    prefetch: faces.prefetch,
    settled: faces.settled,
    stats: () => ({ ...faces.stats(), revision: revision(), ...textCounters }),
    revision,
    dispose() {
      live = false;
      faces.dispose();
      setTextSource(null);
    },
  };
  (globalThis as { __pocketUIText?: RuntimeText }).__pocketUIText = handle;
  return handle;
}

const NONE = { slot: 0, glyphs: 0, bytes: 0, waiting: 0, requests: 0, asked: 0, replyBytes: 0, loads: 0, loadMs: 0, lastLoadMs: 0, atlasBytes: 0, evictions: 0, failures: 0 };
const EMPTY: RuntimeTextStats = { regular: NONE, bold: NONE, waitingFrames: 0 };

