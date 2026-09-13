// tests/osk-script.ts — turn "type this text on the system OSK" into a
// deterministic button script. Uses the SAME layout/navigation math the
// keyboard runs (framework/src/osk-layout.ts), so journeys stay valid across
// layout tweaks: the scripter walks a BFS-shortest d-pad path to each key and
// presses CIRCLE, switching layers with the L/R chords when a character
// lives elsewhere. Mirrors the panel's conventions: a first open focuses
// 'q'; the keyboard remembers its layer and key across opens
// (osk-session.ts), so a scripter that `resume`s a previous one starts
// where that one left off.

import { BTN, SCREEN_H, SCREEN_W } from "../contracts/spec/spec.ts";
import type { ScriptEvent } from "../hosts/sim/sim.ts";
import {
  clampPos,
  homePos,
  layoutRows,
  navigate,
  oskLayer,
  oskLayerToggle,
  oskMetrics,
  oskPanelHeight,
  oskRowsTop,
  OSK_HOME_LAYER,
  OSK_LAYOUT_ROW_H,
  OSK_PAD,
  type OskLayerName,
  type OskLayoutKind,
  type OskMetrics,
  type OskPos,
} from "../framework/src/osk-layout.ts";

const DIRS = ["up", "down", "left", "right"] as const;
const DIR_BTN = { up: BTN.UP, down: BTN.DOWN, left: BTN.LEFT, right: BTN.RIGHT } as const;

export interface OskScripterOptions {
  /** Seconds between events. */
  step?: number;
  /** The layout the panel picks for its surface (osk-session.ts). */
  layout?: OskLayoutKind;
  /** The surface's logical size; the panel docks at its bottom. */
  viewport?: { w: number; h: number };
  /** Row metrics; default: the layout's default row height, no legend. */
  metrics?: OskMetrics;
  /** Continue from the layer and key another scripter left the keyboard on. */
  resume?: OskScripter;
}

/** Absolute centre of a key on a surface with the panel docked at its
 *  bottom — the coordinate a contact needs to land on that key. */
export function oskKeyCenter(
  layout: OskLayoutKind,
  layer: OskLayerName,
  want: string,
  viewport: { w: number; h: number },
  metrics: OskMetrics = oskMetrics(layout),
): [number, number] {
  const rows = layoutRows(oskLayer(layout, layer), viewport.w - 2 * metrics.pad, metrics.gap);
  const panelTop = viewport.h - oskPanelHeight(metrics);
  for (const row of rows) {
    for (const k of row) {
      if ((k.key.ch ?? k.key.label) === want) {
        return [
          metrics.pad + k.x + Math.floor(k.w / 2),
          panelTop + oskRowsTop(metrics) + k.row * (metrics.rowH + metrics.gap) + Math.floor(metrics.rowH / 2),
        ];
      }
    }
  }
  throw new Error(`osk-script: no key ${JSON.stringify(want)} on ${layout}/${layer}`);
}

export class OskScripter {
  readonly events: ScriptEvent[] = [];
  private layer: OskLayerName;
  private pos: OskPos;
  private readonly step: number;
  private readonly layout: OskLayoutKind;
  private readonly viewport: { w: number; h: number };
  private readonly metrics: OskMetrics;
  private readonly innerW: number;

  constructor(
    private t: number,
    options: OskScripterOptions | number = {},
  ) {
    const opts: OskScripterOptions = typeof options === "number" ? { step: options } : options;
    this.step = opts.step ?? 0.5;
    this.layout = opts.layout ?? opts.resume?.layout ?? "grid";
    this.viewport = opts.viewport ?? opts.resume?.viewport ?? { w: SCREEN_W, h: SCREEN_H };
    this.metrics = opts.metrics ?? opts.resume?.metrics ?? oskMetrics(this.layout, OSK_LAYOUT_ROW_H[this.layout]);
    this.innerW = this.viewport.w - 2 * OSK_PAD;
    if (opts.resume) {
      this.layer = opts.resume.layer;
      this.pos = { ...opts.resume.pos };
    } else {
      this.layer = OSK_HOME_LAYER;
      this.pos = homePos(this.rows(OSK_HOME_LAYER));
    }
  }

  private rows(layer: OskLayerName = this.layer) {
    return layoutRows(oskLayer(this.layout, layer), this.innerW, this.metrics.gap);
  }

  private findKey(layer: OskLayerName, ch: string): OskPos | null {
    for (const row of this.rows(layer)) {
      for (const k of row) if (k.key.ch === ch) return { row: k.row, col: k.col };
    }
    return null;
  }

  /** BFS-shortest d-pad path (navigate() transitions) from one key to another. */
  private pathTo(from: OskPos, to: OskPos): (typeof DIRS)[number][] {
    const rows = this.rows();
    const id = (p: OskPos) => `${p.row}:${p.col}`;
    const start = clampPos(rows, from);
    const seen = new Map<string, (typeof DIRS)[number][]>([[id(start), []]]);
    const queue: OskPos[] = [start];
    while (queue.length) {
      const pos = queue.shift()!;
      const path = seen.get(id(pos))!;
      if (pos.row === to.row && pos.col === to.col) return path;
      for (const d of DIRS) {
        const next = navigate(rows, pos, d);
        if (!seen.has(id(next))) {
          seen.set(id(next), [...path, d]);
          queue.push(next);
        }
      }
    }
    throw new Error(`osk-script: ${id(to)} unreachable from ${id(start)}`);
  }

  press(btn: number): this {
    this.events.push({ at: this.t, press: btn });
    this.t += this.step;
    return this;
  }

  /** △ — open the keyboard. The panel resumes its remembered layer and key. */
  open(): this {
    return this.press(BTN.TRIANGLE);
  }

  /** START — commit. */
  commit(): this {
    return this.press(BTN.START);
  }

  private setLayer(next: OskLayerName, chord: number): void {
    this.press(chord);
    this.layer = next;
    this.pos = clampPos(this.rows(next), this.pos);
  }

  /** The layers the current layout carries, home layer first. */
  private layers(): OskLayerName[] {
    return this.layout === "grid" ? ["lower", "upper", "symbols"] : ["lower", "upper", "numbers", "symbols"];
  }

  /** Navigate to `ch` (switching layers when needed) and press CIRCLE. */
  type(text: string): this {
    for (const ch of text) {
      if (!this.findKey(this.layer, ch)) {
        const home = this.layers().find((l) => this.findKey(l, ch));
        if (!home) throw new Error(`osk-script: no layer types ${JSON.stringify(ch)}`);
        // Chord routes: R toggles lower<->upper, L toggles the layer key's
        // target (grid: symbols<->lower; staggered: numbers<->lower, with
        // symbols one more L press away through the panel's own key).
        let guard = 0;
        while (this.layer !== home) {
          if (guard++ > 8) throw new Error(`osk-script: no chord route from ${this.layer} to ${home}`);
          if (home === "upper" || this.layer === "upper") {
            this.setLayer(this.layer === "upper" ? "lower" : "upper", BTN.RTRIGGER);
          } else if (this.layout === "staggered" && home === "symbols") {
            if (this.layer !== "numbers") this.setLayer("numbers", BTN.LTRIGGER);
            else this.pressLayerKey("symbols");
          } else {
            this.setLayer(oskLayerToggle(this.layout, this.layer), BTN.LTRIGGER);
          }
        }
      }
      const target = this.findKey(this.layer, ch)!;
      for (const d of this.pathTo(this.pos, target)) this.press(DIR_BTN[d]);
      this.pos = target;
      this.press(BTN.CIRCLE);
      // The phone layout's shift is one-shot: a letter typed on "upper"
      // returns the panel to "lower".
      if (this.layout === "staggered" && this.layer === "upper" && ch !== " ") {
        this.layer = "lower";
        this.pos = clampPos(this.rows(), this.pos);
      }
    }
    return this;
  }

  /** Walk to the layer key that switches to `to` and press it. */
  private pressLayerKey(to: OskLayerName): void {
    const rows = this.rows();
    for (const row of rows) {
      for (const k of row) {
        if (k.key.action === "layer" && k.key.to === to) {
          for (const d of this.pathTo(this.pos, { row: k.row, col: k.col })) this.press(DIR_BTN[d]);
          this.press(BTN.CIRCLE);
          this.layer = to;
          this.pos = clampPos(this.rows(to), { row: k.row, col: k.col });
          return;
        }
      }
    }
    throw new Error(`osk-script: no layer key to ${to} on ${this.layer}`);
  }

  /** Touch-tap each character at its key centre (panel docked at the bottom
   *  of the surface — the system convention). A tap is a one-event contact
   *  released half a step later. On the staggered layout a character types
   *  on the down edge; on the grid it types on the release. */
  tap(text: string): this {
    for (const ch of text) {
      const pos = this.findKey(this.layer, ch);
      if (!pos) throw new Error(`osk-script: ${JSON.stringify(ch)} is not on layer ${this.layer}`);
      const [x, y] = oskKeyCenter(this.layout, this.layer, ch, this.viewport, this.metrics);
      this.events.push({ at: this.t, touch: [{ x, y }] });
      this.events.push({ at: this.t + this.step / 2, touch: [] });
      this.t += this.step;
      this.pos = pos; // the panel's memory follows the tap
    }
    return this;
  }

  get end(): number {
    return this.t;
  }
}
