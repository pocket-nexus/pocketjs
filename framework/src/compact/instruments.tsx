// The instrument controls: the readouts a small tool shows while it works.
// Each one keeps the one physical metaphor that explains its value (the
// bubble between rings, the ruler under a pointer, the tape past a lubber
// line, the segmented meter with its peak) and nothing more. Values arrive
// as accessors and the instrument redraws only what moved: a bubble, a
// pointer, the digits.

import { createEffect, createMemo, Index, Show, type Accessor, type JSX } from "solid-js";
import { Text, View } from "../primitives.ts";
import type { NodeMirror } from "../renderer.ts";
import { createFollower, glide, MOTION, place } from "./motion.ts";
import { measure } from "./text.ts";
import { COLOR, LINE, SLOT, TONE_COLOR, type Slot, type Tone } from "./tokens.ts";

export interface Box {
  x: number;
  y: number;
  w?: number;
  h?: number;
}

// ---- digits -------------------------------------------------------------------------

export type DigitSize = "xs" | "sm" | "base" | "lg" | "xl" | "xxl" | "big" | "huge";

const DIGIT_SLOT: Record<DigitSize, Slot> = { xs: SLOT.xsBold, sm: SLOT.smBold, base: SLOT.baseBold, lg: SLOT.lgBold, xl: SLOT.xlBold, xxl: SLOT.xxlBold, big: SLOT.bigBold, huge: SLOT.hugeBold };
const DIGIT_LINE: Record<DigitSize, number> = { xs: LINE.xs, sm: LINE.sm, base: LINE.base, lg: LINE.lg, xl: LINE.xl, xxl: LINE.xxl, big: LINE.big, huge: LINE.huge };

const cellCache = new Map<Slot, number>();
/** The widest digit of a slot: every digit is drawn in a cell this wide, so
 *  a changing value does not jitter. */
function digitCell(slot: Slot): number {
  let width = cellCache.get(slot);
  if (width === undefined) {
    width = 0;
    for (const d of "0123456789") width = Math.max(width, measure(d, slot));
    width = Math.ceil(width);
    cellCache.set(slot, width);
  }
  return width;
}

function digitClass(size: DigitSize): string {
  switch (size) {
    case "xs":
      return "absolute top-0 text-xs font-bold leading-[14] text-center";
    case "sm":
      return "absolute top-0 text-sm font-bold leading-[16] text-center";
    case "base":
      return "absolute top-0 text-base font-bold leading-[18] text-center";
    case "lg":
      return "absolute top-0 text-lg font-bold leading-[20] text-center";
    case "xl":
      return "absolute top-0 text-xl font-bold leading-[22] text-center";
    case "xxl":
      return "absolute top-0 text-2xl font-bold leading-[26] text-center";
    case "big":
      return "absolute top-0 text-4xl font-bold leading-[38] text-center";
    case "huge":
      return "absolute top-0 text-5xl font-bold leading-[56] text-center";
  }
}

export interface DigitsProps extends Box {
  value: Accessor<string>;
  size: DigitSize;
  tone?: Accessor<Tone>;
  /** Where the text sits in its box when `w` is given. */
  align?: "left" | "center" | "right";
}

/** A number in fixed-advance cells: digits in a cell as wide as the widest
 *  digit, other characters at their own width. */
export function Digits(props: DigitsProps): JSX.Element {
  const slot = DIGIT_SLOT[props.size];
  const line = DIGIT_LINE[props.size];
  const cells = createMemo(() => {
    const cell = digitCell(slot);
    const out: { ch: string; x: number; w: number }[] = [];
    let x = 0;
    for (const ch of props.value()) {
      const w = ch >= "0" && ch <= "9" ? cell : Math.ceil(measure(ch, slot));
      out.push({ ch, x, w });
      x += w;
    }
    return { out, width: x };
  });
  const offset = () => {
    if (props.w === undefined || props.align === "left" || !props.align) return 0;
    const free = props.w - cells().width;
    return props.align === "center" ? Math.round(free / 2) : free;
  };
  const color = () => TONE_COLOR[props.tone?.() ?? "ink"];
  return (
    <View class="absolute" style={{ insetL: props.x, insetT: props.y, width: props.w ?? cells().width, height: line }}>
      <Index each={cells().out}>
        {cell => (
          <Text class={digitClass(props.size)} style={{ insetL: offset() + cell().x, width: cell().w, textColor: color() }}>
            {cell().ch}
          </Text>
        )}
      </Index>
    </View>
  );
}

/** The width `Digits` draws `text` at. */
export function digitsWidth(text: string, size: DigitSize): number {
  const slot = DIGIT_SLOT[size];
  const cell = digitCell(slot);
  let width = 0;
  for (const ch of text) width += ch >= "0" && ch <= "9" ? cell : Math.ceil(measure(ch, slot));
  return width;
}

// ---- gauge ----------------------------------------------------------------------------

export interface GaugeProps extends Box {
  value: Accessor<number>;
  decimals: number;
  unit?: string;
  label?: string;
  /** With both, a thin scale under the digits carries a marker. */
  min?: number;
  max?: number;
  size?: DigitSize;
  tone?: Accessor<Tone>;
  signed?: boolean;
}

/** One large reading with its unit and label, and a marker on a thin scale
 *  when the range is known. */
export function Gauge(props: GaugeProps): JSX.Element {
  const w = props.w ?? 150;
  const size = props.size ?? "big";
  const text = () => {
    const v = props.value();
    const body = Math.abs(v).toFixed(props.decimals);
    return v < 0 ? `-${body}` : props.signed ? `+${body}` : body;
  };
  const line = DIGIT_LINE[size];
  const digitsW = () => digitsWidth(text(), size);
  const unitW = () => (props.unit ? Math.ceil(measure(props.unit, SLOT.sm)) + 4 : 0);
  const left = () => Math.max(0, Math.round((w - digitsW() - unitW()) / 2));
  const labelY = props.label ? 12 : 0;
  const scaleY = labelY + line + 4;
  const marker = () => {
    if (props.min === undefined || props.max === undefined || props.max <= props.min) return null;
    const ratio = (props.value() - props.min) / (props.max - props.min);
    return Math.round(Math.max(0, Math.min(1, ratio)) * (w - 2));
  };
  let mark: NodeMirror | undefined;
  const followMark = createFollower("translateX", MOTION.value);
  createEffect(() => {
    const at = marker();
    if (at !== null) followMark(mark, at);
  });
  return (
    <View class="absolute" style={{ insetL: props.x, insetT: props.y, width: w, height: props.h ?? scaleY + 8 }}>
      <Show when={props.label}>
        <Text class="absolute left-0 top-0 text-2xs font-bold leading-[12] text-center text-[#8e80ac]" style={{ width: w }}>
          {props.label}
        </Text>
      </Show>
      <Digits value={text} size={size} x={left()} y={labelY} tone={props.tone} />
      <Show when={props.unit}>
        <Text class="absolute text-sm leading-[16] text-[#a99cc6]" style={{ insetL: left() + digitsW() + 4, insetT: labelY + line - 18 }}>
          {props.unit}
        </Text>
      </Show>
      <Show when={marker() !== null}>
        <View class="absolute left-0 h-[2] bg-[#2b2148]" style={{ insetT: scaleY, width: w }} />
        <View ref={node => (mark = node)} class="absolute left-0 w-[2] h-[6]" style={{ insetT: scaleY - 2, bgColor: TONE_COLOR[props.tone?.() ?? "accent"] }} />
      </Show>
    </View>
  );
}

// ---- tuner ----------------------------------------------------------------------------------

export interface TunerProps extends Box {
  value: Accessor<number>;
  min: number;
  max: number;
  /** Ruler ticks every `step`; a tall tick every `major` steps. */
  step: number;
  major: number;
  /** Panel pixels per step. */
  pxPerStep: number;
  decimals: number;
  unit?: string;
  label?: string;
  tone?: Accessor<Tone>;
  /** Draw the ruler only: another readout shows the value. */
  rulerOnly?: boolean;
}

/** A ruler that slides under a fixed centre pointer, the value in large
 *  digits above it. Left and right move the value; the ruler follows. */
export function Tuner(props: TunerProps): JSX.Element {
  const w = props.w ?? 300;
  const h = props.h ?? 70;
  const rulerY = h - 26;
  const center = Math.round(w / 2);
  const text = () => props.value().toFixed(props.decimals);
  const digitsW = () => digitsWidth(text(), "xxl");
  const unitW = () => (props.unit ? Math.ceil(measure(props.unit, SLOT.sm)) + 4 : 0);
  // The ruler is laid out for the new value and starts shifted by the
  // change, then glides into place: the pointer stands still, the scale moves.
  let ruler: NodeMirror | undefined;
  let previous: number | null = null;
  createEffect(() => {
    const value = props.value();
    if (ruler && previous !== null && previous !== value) {
      const shift = ((value - previous) / props.step) * props.pxPerStep;
      place(ruler, "translateX", Math.max(-w, Math.min(w, shift)));
      glide(ruler, "translateX", 0, MOTION.needle);
    }
    previous = value;
  });
  const ticks = createMemo(() => {
    const out: { x: number; tall: boolean; label: string | null }[] = [];
    const span = Math.ceil(center / props.pxPerStep) + 1;
    const base = Math.round(props.value() / props.step);
    for (let k = base - span; k <= base + span; k++) {
      const v = k * props.step;
      if (v < props.min - 1e-9 || v > props.max + 1e-9) continue;
      const x = center + (v - props.value()) / props.step * props.pxPerStep;
      if (x < 0 || x > w) continue;
      const tall = k % props.major === 0;
      out.push({ x: Math.round(x), tall, label: tall ? v.toFixed(props.decimals > 0 && props.step < 1 ? Math.min(props.decimals, 1) : 0) : null });
    }
    return out;
  });
  return (
    <View class="absolute overflow-hidden" style={{ insetL: props.x, insetT: props.y, width: w, height: h }}>
      <Show when={props.label}>
        <Text class="absolute left-0 top-0 text-2xs font-bold leading-[12] text-[#8e80ac]">{props.label}</Text>
      </Show>
      <Show when={!props.rulerOnly}>
        <Digits value={text} size="xxl" x={Math.round((w - digitsW() - unitW()) / 2)} y={props.label ? 10 : 0} tone={props.tone} />
        <Show when={props.unit}>
          <Text class="absolute text-sm leading-[16] text-[#a99cc6]" style={{ insetL: Math.round((w - digitsW() - unitW()) / 2) + digitsW() + 4, insetT: (props.label ? 10 : 0) + 8 }}>
            {props.unit}
          </Text>
        </Show>
      </Show>
      <View class="absolute left-0 h-[1] bg-[#3a2d5c]" style={{ insetT: rulerY + 12, width: w }} />
      <View ref={node => (ruler = node)} class="absolute left-0 top-0" style={{ width: w, height: h }}>
        <Index each={ticks()}>
          {tick => (
            <>
              <View class="absolute w-[1]" style={{ insetL: tick().x, insetT: rulerY + (tick().tall ? 2 : 7), height: tick().tall ? 10 : 5, bgColor: tick().tall ? COLOR.text : COLOR.dim }} />
              <Show when={tick().label}>
                <Text class="absolute text-2xs leading-[12] text-center text-[#8e80ac]" style={{ insetL: tick().x - 16, insetT: rulerY + 13, width: 32 }}>
                  {tick().label}
                </Text>
              </Show>
            </>
          )}
        </Index>
      </View>
      <View class="absolute w-[2]" style={{ insetL: center - 1, insetT: rulerY - 2, height: 16, bgColor: TONE_COLOR[props.tone?.() ?? "accent"] }} />
    </View>
  );
}

// ---- bubble level ------------------------------------------------------------------------

export interface BubbleLevelProps extends Box {
  /** -1..1 each; the bubble sits at the centre when both are 0. */
  bubbleX: Accessor<number>;
  bubbleY: Accessor<number>;
  size: number;
  /** The reading is held. */
  frozen?: Accessor<boolean>;
}

/** Two rings, a crosshair and the bubble. Within the inner ring the bubble
 *  turns cyan: level. */
export function BubbleLevel(props: BubbleLevelProps): JSX.Element {
  const s = props.size;
  const bubble = 14;
  const radius = (s - bubble) / 2;
  const level = () => Math.hypot(props.bubbleX(), props.bubbleY()) < 0.08;
  const bx = () => Math.round(s / 2 + Math.max(-1, Math.min(1, props.bubbleX())) * radius - bubble / 2);
  const by = () => Math.round(s / 2 - Math.max(-1, Math.min(1, props.bubbleY())) * radius - bubble / 2);
  const inner = Math.round(s * 0.42);
  const color = () => (props.frozen?.() ? COLOR.dim : level() ? COLOR.ok : COLOR.accent);
  // The bubble sits at the centre and glides by its offset each reading.
  let ball: NodeMirror | undefined;
  const followX = createFollower("translateX", MOTION.needle);
  const followY = createFollower("translateY", MOTION.needle);
  createEffect(() => {
    followX(ball, bx() - (s - bubble) / 2);
    followY(ball, by() - (s - bubble) / 2);
  });
  return (
    <View class="absolute" style={{ insetL: props.x, insetT: props.y, width: s, height: s }}>
      <View class="absolute left-0 top-0 border" style={{ width: s, height: s, radius: s / 2, borderColor: COLOR.line }} />
      <View class="absolute border" style={{ insetL: (s - inner) / 2, insetT: (s - inner) / 2, width: inner, height: inner, radius: inner / 2, borderColor: COLOR.line }} />
      <View class="absolute w-[1] bg-[#3a2d5c]" style={{ insetL: Math.round(s / 2), insetT: 0, height: s }} />
      <View class="absolute h-[1] bg-[#3a2d5c]" style={{ insetL: 0, insetT: Math.round(s / 2), width: s }} />
      <View ref={node => (ball = node)} class="absolute w-[14] h-[14] rounded-full" style={{ insetL: (s - bubble) / 2, insetT: (s - bubble) / 2, bgColor: color() }}>
        <View class="absolute w-[4] h-[4] rounded-full bg-[#fcf6ff]" style={{ insetL: 5, insetT: 5 }} />
      </View>
    </View>
  );
}

// ---- tape compass ---------------------------------------------------------------------------

const CARDINALS = ["N", "NE", "E", "SE", "S", "SW", "W", "NW"];

export interface TapeCompassProps extends Box {
  heading: Accessor<number | null>;
  /** Panel pixels per degree. */
  pxPerDeg?: number;
}

/** A heading tape: cardinal points every 45 degrees and ticks every 15 slide
 *  past a fixed lubber line; the bearing in large digits above. */
export function TapeCompass(props: TapeCompassProps): JSX.Element {
  const w = props.w ?? 300;
  const h = props.h ?? 70;
  const pxPerDeg = props.pxPerDeg ?? 2;
  const center = Math.round(w / 2);
  const tapeY = h - 30;
  const heading = () => props.heading() ?? 0;
  const text = () => (props.heading() === null ? "---" : `${Math.round(heading()) % 360}`);
  const cardinal = () => (props.heading() === null ? "no field" : CARDINALS[Math.round(heading() / 45) % 8]!);
  let tape: NodeMirror | undefined;
  let previous: number | null = null;
  createEffect(() => {
    const value = props.heading();
    if (value === null) {
      previous = null;
      return;
    }
    if (tape && previous !== null) {
      let delta = value - previous;
      if (delta > 180) delta -= 360;
      if (delta < -180) delta += 360;
      if (delta !== 0) {
        place(tape, "translateX", Math.max(-w, Math.min(w, delta * pxPerDeg)));
        glide(tape, "translateX", 0, MOTION.needle);
      }
    }
    previous = value;
  });
  const marks = createMemo(() => {
    const out: { x: number; label: string | null; tall: boolean }[] = [];
    const span = Math.ceil(center / pxPerDeg / 15) + 1;
    const base = Math.round(heading() / 15);
    for (let k = base - span; k <= base + span; k++) {
      const deg = k * 15;
      const x = center + (deg - heading()) * pxPerDeg;
      if (x < 0 || x > w) continue;
      const norm = ((deg % 360) + 360) % 360;
      const major = norm % 45 === 0;
      out.push({ x: Math.round(x), tall: major, label: major ? CARDINALS[norm / 45]! : null });
    }
    return out;
  });
  const digitsW = () => digitsWidth(text(), "big");
  return (
    <View class="absolute overflow-hidden" style={{ insetL: props.x, insetT: props.y, width: w, height: h }}>
      <Digits value={text} size="big" x={Math.round((w - digitsW()) / 2) - 14} y={0} tone={() => (props.heading() === null ? "dim" : "ink")} />
      <Text class="absolute text-sm font-bold leading-[16] text-[#ffd23f]" style={{ insetL: Math.round((w - digitsW()) / 2) + digitsW() - 10, insetT: 20 }}>
        {cardinal()}
      </Text>
      <View class="absolute left-0 h-[1] bg-[#3a2d5c]" style={{ insetT: tapeY + 14, width: w }} />
      <View ref={node => (tape = node)} class="absolute left-0 top-0" style={{ width: w, height: h }}>
        <Index each={marks()}>
          {mark => (
            <>
              <View class="absolute w-[1]" style={{ insetL: mark().x, insetT: tapeY + (mark().tall ? 4 : 9), height: mark().tall ? 10 : 5, bgColor: mark().tall ? COLOR.text : COLOR.dim }} />
              <Show when={mark().label}>
                <Text class="absolute text-2xs font-bold leading-[12] text-center" style={{ insetL: mark().x - 12, insetT: tapeY + 15, width: 24, textColor: mark().label === "N" ? COLOR.warn : COLOR.text }}>
                  {mark().label}
                </Text>
              </Show>
            </>
          )}
        </Index>
      </View>
      <View class="absolute w-[2] bg-[#ffd23f]" style={{ insetL: center - 1, insetT: tapeY, height: 18 }} />
    </View>
  );
}

// ---- signal meter and bars --------------------------------------------------------------------

export interface SignalMeterProps extends Box {
  /** 0..1 */
  value: Accessor<number>;
  /** 0..1, the held peak. */
  peak?: Accessor<number>;
  segments?: number;
  tone?: Tone;
  /** Draw upward from the bottom. */
  vertical?: boolean;
}

/** A segmented bar; the segments under the value light up, the peak holds
 *  as one lit segment above them. */
export function SignalMeter(props: SignalMeterProps): JSX.Element {
  const w = props.w ?? 120;
  const h = props.h ?? 10;
  const segments = props.segments ?? 20;
  const lit = () => Math.round(Math.max(0, Math.min(1, props.value())) * segments);
  const peak = () => (props.peak ? Math.round(Math.max(0, Math.min(1, props.peak())) * segments) : 0);
  const color = TONE_COLOR[props.tone ?? "ok"];
  const along = props.vertical ? h : w;
  const seg = Math.max(2, Math.floor((along - (segments - 1)) / segments));
  return (
    <View class="absolute" style={{ insetL: props.x, insetT: props.y, width: w, height: h }}>
      <Index each={Array.from({ length: segments }, (_, i) => i)}>
        {index => {
          const i = index();
          const on = () => i < lit() || (props.peak && i === peak() - 1 && i >= lit());
          const hot = () => i >= Math.round(segments * 0.85);
          return props.vertical ? (
            <View class="absolute left-0 rounded-sm" style={{ insetT: h - (i + 1) * (seg + 1) + 1, width: w, height: seg, bgColor: on() ? (hot() ? COLOR.warn : color) : COLOR.raised }} />
          ) : (
            <View class="absolute top-0 rounded-sm" style={{ insetL: i * (seg + 1), width: seg, height: h, bgColor: on() ? (hot() ? COLOR.warn : color) : COLOR.raised }} />
          );
        }}
      </Index>
    </View>
  );
}

export interface BarsProps extends Box {
  /** Each 0..1; one column per value. */
  values: Accessor<readonly number[]>;
  tone?: Tone;
  /** Columns grow from the vertical middle both ways (a waveform). */
  mirror?: boolean;
  gap?: number;
}

/** Columns from the bottom (or round the middle): a spectrum, a waveform,
 *  a sparkline of recent readings. */
export function Bars(props: BarsProps): JSX.Element {
  const w = props.w ?? 300;
  const h = props.h ?? 60;
  const gap = props.gap ?? 1;
  const color = TONE_COLOR[props.tone ?? "ok"];
  const count = () => Math.max(1, props.values().length);
  const colW = () => Math.max(1, Math.floor((w - gap * (count() - 1)) / count()));
  return (
    <View class="absolute overflow-hidden" style={{ insetL: props.x, insetT: props.y, width: w, height: h }}>
      <View class="absolute left-0 h-[1] bg-[#2f2550]" style={{ insetT: props.mirror ? Math.round(h / 2) : h - 1, width: w }} />
      <Index each={props.values()}>
        {(value, i) => {
          const v = () => Math.max(0, Math.min(1, Math.abs(value())));
          const height = () => Math.max(1, Math.round(v() * (props.mirror ? h / 2 : h)));
          const top = () => (props.mirror ? (value() >= 0 ? Math.round(h / 2) - height() : Math.round(h / 2)) : h - height());
          return <View class="absolute" style={{ insetL: i * (colW() + gap), insetT: top(), width: colW(), height: height(), bgColor: color }} />;
        }}
      </Index>
    </View>
  );
}

// ---- recorder strip and status matrix ------------------------------------------------------------

export interface RecorderStripProps extends Box {
  recording: Accessor<boolean>;
  /** Seconds recorded; shown as m:ss. */
  seconds: Accessor<number>;
  /** 0..1 */
  level: Accessor<number>;
  blink: Accessor<boolean>;
}

/** REC dot, elapsed time, level meter. */
export function RecorderStrip(props: RecorderStripProps): JSX.Element {
  const w = props.w ?? 300;
  const time = () => {
    const s = Math.max(0, Math.floor(props.seconds()));
    return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
  };
  return (
    <View class="absolute" style={{ insetL: props.x, insetT: props.y, width: w, height: 26 }}>
      <View class="absolute w-[10] h-[10] rounded-full" style={{ insetL: 0, insetT: 8, bgColor: props.recording() ? (props.blink() ? COLOR.rec : COLOR.raised) : COLOR.raised }} />
      <Text class="absolute text-xs font-bold leading-[26]" style={{ insetL: 16, insetT: 0, textColor: props.recording() ? COLOR.rec : COLOR.dim }}>
        {props.recording() ? "REC" : "IDLE"}
      </Text>
      <Digits value={time} size="xl" x={54} y={2} tone={() => (props.recording() ? "ink" : "dim")} />
      <SignalMeter value={props.level} x={130} y={8} w={w - 130} h={10} segments={24} />
    </View>
  );
}

export interface MatrixCell {
  label: string;
  on: boolean;
  /** Text in the cell instead of the lamp. */
  text?: string;
  tone?: Tone;
}

export interface StatusMatrixProps extends Box {
  cells: Accessor<readonly MatrixCell[]>;
  columns: number;
  gap?: number;
}

/** A grid of small cells: a label and a lamp (or a short text) each. */
export function StatusMatrix(props: StatusMatrixProps): JSX.Element {
  const w = props.w ?? 300;
  const h = props.h ?? 60;
  const gap = props.gap ?? 4;
  const rows = () => Math.max(1, Math.ceil(props.cells().length / props.columns));
  const cellW = () => Math.floor((w - gap * (props.columns - 1)) / props.columns);
  const cellH = () => Math.floor((h - gap * (rows() - 1)) / rows());
  return (
    <View class="absolute" style={{ insetL: props.x, insetT: props.y, width: w, height: h }}>
      <Index each={props.cells()}>
        {(cell, i) => {
          const col = i % props.columns;
          const row = Math.floor(i / props.columns);
          const color = () => TONE_COLOR[cell().tone ?? (cell().on ? "ok" : "dim")];
          return (
            <View class="absolute rounded-sm bg-[#231b3b] border-[#3a2d5c] border" style={{ insetL: col * (cellW() + gap), insetT: row * (cellH() + gap), width: cellW(), height: cellH() }}>
              <Text class="absolute left-0 text-2xs leading-[12] text-center text-[#8e80ac]" style={{ width: cellW(), insetT: 2 }}>
                {cell().label}
              </Text>
              <Show when={cell().text} fallback={<View class="absolute w-[8] h-[8] rounded-full" style={{ insetL: (cellW() - 8) / 2, insetT: cellH() - 14, bgColor: cell().on ? color() : COLOR.raised }} />}>
                <Text class="absolute left-0 text-xs font-bold leading-[14] text-center" style={{ width: cellW(), insetT: cellH() - 17, textColor: color() }}>
                  {cell().text}
                </Text>
              </Show>
            </View>
          );
        }}
      </Index>
    </View>
  );
}
