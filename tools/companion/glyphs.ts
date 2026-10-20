// Glyphs for the agent's words on a console (contracts/spec/agent.ts
// "Glyphs"): a console bakes only the glyphs its bundle's source names, so
// the companion rasterizes the agent's text with CoreText
// (tools/companion/macos/Glyphs.swift, built through swift-helper.ts;
// $POCKET_AGENT_GLYPHS overrides it) and sends the console a FONT ATLAS v3
// (contracts/spec/spec.ts) for AGENT_FONT_SLOT before the first message that
// needs a glyph the console lacks.
//
// GlyphRasterizer is shared by every console and caches cells by codepoint.
// GlyphFeed is one console's account of the atlas it holds.

import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { join } from "node:path";
import { AGENT_FONT, AGENT_FONT_MAX_GLYPHS, AGENT_FONT_SLOT, AGENT_LABEL_GLYPHS } from "../../contracts/spec/agent.ts";
import { FONT_CMAP_ENTRY_SIZE, FONT_HEADER_SIZE, FONT_MAGIC, FONT_VERSION } from "../../contracts/spec/spec.ts";
import { helperCommand } from "./swift-helper.ts";

export const GLYPHS_SOURCE = join(import.meta.dir, "macos", "Glyphs.swift");

export type AgentFont = { size: number; cellW: number; cellH: number; baseline: number; lineHeight: number };

export interface GlyphCell {
  advance: number;
  xoff: number;
  /** cellW x cellH alpha bytes, top row first. */
  coverage: Uint8Array;
}

/** What every atlas holds: printable ASCII, common CJK punctuation and the
 *  overlay's own words (AGENT_LABEL_GLYPHS). */
export const AGENT_BASE_CODEPOINTS: readonly number[] = [
  ...new Set([
    ...Array.from({ length: 0x7f - 0x20 }, (_, i) => 0x20 + i),
    ...[..."，。！？：；、“”‘’（）《》…—·「」"].map((ch) => ch.codePointAt(0)!),
    ...codepointsOf(AGENT_LABEL_GLYPHS),
  ]),
];

/** The distinct drawable codepoints of `text` (control characters left out). */
export function codepointsOf(text: string): number[] {
  const out = new Set<number>();
  for (const ch of text) {
    const cp = ch.codePointAt(0)!;
    if (cp >= 0x20 && cp !== 0x7f) out.add(cp);
  }
  return [...out];
}

/** gid 0: an outlined box, the width of a CJK glyph's ink. */
export function tofuCell(font: AgentFont = AGENT_FONT): GlyphCell {
  const coverage = new Uint8Array(font.cellW * font.cellH);
  const left = 1;
  const right = Math.min(font.cellW - 2, font.size - 2);
  const top = Math.max(0, font.baseline - font.size + 2);
  const bottom = font.baseline;
  for (let y = top; y <= bottom; y++) {
    for (let x = left; x <= right; x++) {
      if (y === top || y === bottom || x === left || x === right) coverage[y * font.cellW + x] = 200;
    }
  }
  return { advance: Math.min(font.cellW, font.size), xoff: 0, coverage };
}

/** The codepoint the tofu box answers to, as bake-font.ts maps it. */
export const TOFU_CODEPOINT = 0xfffd;

/** A FONT ATLAS v3 blob: gid 0 the tofu box (mapped from U+FFFD), then
 *  `cells`; one cmap entry per glyph, sorted by codepoint. */
export function packAgentAtlas(cells: ReadonlyMap<number, GlyphCell>, font: AgentFont = AGENT_FONT, slot = AGENT_FONT_SLOT): Uint8Array {
  const codepoints = [...cells.keys()].filter((cp) => cp !== TOFU_CODEPOINT).sort((a, b) => a - b);
  const count = codepoints.length + 1;
  if (count > 0xffff) throw new Error("atlas: too many glyphs");
  const cellBytes = font.cellW * font.cellH;
  const coverageOffset = FONT_HEADER_SIZE + count * FONT_CMAP_ENTRY_SIZE;
  const out = new Uint8Array(coverageOffset + count * cellBytes);
  const view = new DataView(out.buffer);
  view.setUint32(0, FONT_MAGIC, true);
  view.setUint16(4, FONT_VERSION, true);
  view.setUint16(6, count, true);
  out[8] = font.cellW;
  out[9] = font.cellH;
  out[10] = font.baseline;
  out[11] = font.lineHeight;
  out[12] = slot;
  out[13] = 0; // flags: regular
  out[14] = 1; // density
  out[15] = 0;
  const tofu = tofuCell(font);
  out.set(tofu.coverage, coverageOffset);
  const entries = codepoints.map((cp, index) => ({ cp, gid: index + 1, cell: cells.get(cp)! }));
  entries.push({ cp: TOFU_CODEPOINT, gid: 0, cell: tofu });
  entries.sort((a, b) => a.cp - b.cp);
  entries.forEach(({ cp, gid, cell }, index) => {
    const entry = FONT_HEADER_SIZE + index * FONT_CMAP_ENTRY_SIZE;
    view.setUint32(entry, cp, true);
    view.setUint16(entry + 4, gid, true);
    out[entry + 6] = Math.max(0, Math.min(255, cell.advance));
    out[entry + 7] = Math.max(0, Math.min(255, cell.xoff));
    if (gid > 0) out.set(cell.coverage.subarray(0, cellBytes), coverageOffset + gid * cellBytes);
  });
  return out;
}

/** The CoreText helper as one long-lived child; cells cached by codepoint
 *  (null: no font draws it, the atlas leaves it to the tofu box). */
export class GlyphRasterizer {
  private child: ChildProcessWithoutNullStreams | undefined;
  private starting: Promise<ChildProcessWithoutNullStreams | null> | undefined;
  private cache = new Map<number, GlyphCell | null>();
  private chain: Promise<unknown> = Promise.resolve();
  private buffer = "";
  private waiting: ((line: string | null) => void)[] = [];
  private failed = false;

  constructor(
    private readonly storeDir: string,
    private readonly font: AgentFont = AGENT_FONT,
    private readonly log?: (line: string) => void,
  ) {}

  private start(): Promise<ChildProcessWithoutNullStreams | null> {
    if (this.child) return Promise.resolve(this.child);
    if (this.failed) return Promise.resolve(null);
    this.starting ??= helperCommand({ name: "pocket-glyphs", source: GLYPHS_SOURCE, env: "POCKET_AGENT_GLYPHS" }, this.storeDir, this.log).then((command) => {
      this.starting = undefined;
      if (!command) {
        this.failed = true;
        return null;
      }
      const { size, cellW, cellH, baseline } = this.font;
      const child = spawn(command[0], [...command.slice(1), String(size), String(cellW), String(cellH), String(baseline)], { stdio: ["pipe", "pipe", "pipe"] });
      child.stdout.setEncoding("utf8");
      child.stdout.on("data", (chunk: string) => {
        this.buffer += chunk;
        let newline: number;
        while ((newline = this.buffer.indexOf("\n")) >= 0) {
          const line = this.buffer.slice(0, newline);
          this.buffer = this.buffer.slice(newline + 1);
          this.waiting.shift()?.(line);
        }
      });
      child.stderr.on("data", (chunk: Buffer) => this.log?.(`glyphs: ${chunk.toString().trim().slice(0, 200)}`));
      child.stdin.on("error", () => {});
      child.on("exit", () => {
        if (this.child === child) this.child = undefined;
        for (const wake of this.waiting.splice(0)) wake(null);
      });
      this.child = child;
      return child;
    });
    return this.starting;
  }

  /** Cells for `codepoints`, rasterizing the ones not cached; one request at
   *  a time. Empty when the helper cannot run. */
  cells(codepoints: Iterable<number>): Promise<Map<number, GlyphCell | null>> {
    const run = this.chain.then(() => this.fill([...codepoints]));
    this.chain = run.catch(() => undefined);
    return run;
  }

  private async fill(codepoints: number[]): Promise<Map<number, GlyphCell | null>> {
    const missing = codepoints.filter((cp) => !this.cache.has(cp));
    if (missing.length) {
      const child = await this.start();
      if (child) {
        const line = await new Promise<string | null>((resolve) => {
          this.waiting.push(resolve);
          child.stdin.write(`${missing.join(",")}\n`);
        });
        const size = this.font.cellW * this.font.cellH;
        try {
          const parsed = JSON.parse(line ?? "{}") as { glyphs?: { cp: number; advance: number; xoff: number; coverage: string }[] };
          for (const glyph of parsed.glyphs ?? []) {
            const coverage = new Uint8Array(Buffer.from(glyph.coverage, "base64"));
            if (coverage.length === size) this.cache.set(glyph.cp, { advance: glyph.advance, xoff: glyph.xoff, coverage });
          }
          for (const cp of missing) if (!this.cache.has(cp)) this.cache.set(cp, null);
        } catch {
          this.log?.("glyphs: unreadable helper answer");
        }
      }
    }
    const out = new Map<number, GlyphCell | null>();
    for (const cp of codepoints) if (this.cache.has(cp)) out.set(cp, this.cache.get(cp)!);
    return out;
  }

  close() {
    this.child?.kill();
    this.child = undefined;
  }
}

/** One console's atlas: the codepoints it was sent, and what the next atlas
 *  must hold. */
export class GlyphFeed {
  /** What the console holds now; null after a guest switch (it holds none). */
  private delivered: Set<number> | null = null;
  private wanted = new Set<number>(AGENT_BASE_CODEPOINTS);
  private turn = new Set<number>();

  constructor(
    private readonly raster: GlyphRasterizer,
    private readonly font: AgentFont = AGENT_FONT,
    private readonly max = AGENT_FONT_MAX_GLYPHS,
  ) {}

  /** A guest switch dropped the slot: the next prepare() sends the atlas. */
  dropped() {
    this.delivered = null;
  }

  /** A new turn: what "the glyphs the current turn needs" counts from. */
  newTurn() {
    this.turn.clear();
  }

  /** The atlas to send before `texts` reach the console, or null when the
   *  console holds every glyph they use (and `force` is off). */
  async prepare(texts: readonly string[], force = false): Promise<Uint8Array | null> {
    const needed = texts.flatMap(codepointsOf);
    for (const cp of needed) this.turn.add(cp);
    const delivered = this.delivered;
    if (!force && delivered && needed.every((cp) => delivered.has(cp))) return null;
    for (const cp of needed) this.wanted.add(cp);
    if (this.wanted.size > this.max) this.wanted = new Set([...AGENT_BASE_CODEPOINTS, ...this.turn]);
    const cells = await this.raster.cells(this.wanted);
    if (cells.size === 0) return null; // no helper on this Mac: send text as is
    const drawn = new Map<number, GlyphCell>();
    for (const [cp, cell] of cells) if (cell) drawn.set(cp, cell);
    this.delivered = new Set(this.wanted);
    return packAgentAtlas(drawn, this.font);
  }
}
