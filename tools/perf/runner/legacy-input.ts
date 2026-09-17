import { parseInputTapeV1 } from "../core/index.ts";
import type { InputTapeV1, InputTrackV1 } from "../core/types.ts";

const RAW_BUTTONS = [
  [0x2000, "primary"],
  [0x1000, "secondary"],
  [0x4000, "tertiary"],
  [0x8000, "quaternary"],
  [0x0001, "select"],
  [0x0008, "start"],
  [0x0020, "right"],
  [0x0080, "left"],
  [0x0010, "up"],
  [0x0040, "down"],
  [0x0200, "shoulder-right"],
  [0x0100, "shoulder-left"],
] as const;

const VAPOR_BUTTONS = [
  "primary",
  "secondary",
  "select",
  "start",
  "right",
  "left",
  "up",
  "down",
  "shoulder-right",
  "shoulder-left",
] as const;

interface LegacyTouchPoint {
  readonly id: number;
  readonly x: number;
  readonly y: number;
}

interface GoldenSpecLike {
  readonly frames: number;
  readonly input?: (frame: number) => number;
  readonly touch?: (frame: number) => readonly LegacyTouchPoint[];
}

interface DevtoolsTapeLike {
  readonly frames: number;
  readonly masks: readonly (readonly [value: number, count: number])[];
  readonly analog?: readonly (readonly [value: number, count: number])[];
  readonly touch?: readonly (readonly [frame: number, contacts: readonly number[]])[];
  readonly startFrame?: number;
}

/** Freeze a GoldenSpec closure into serializable benchmark input. */
export function goldenSpecToInputTape(
  id: string,
  spec: GoldenSpecLike,
): InputTapeV1 {
  const masks = Array.from({ length: spec.frames }, (_, frame) => spec.input?.(frame) ?? 0);
  const touches = Array.from(
    { length: spec.frames },
    (_, frame) => spec.touch?.(frame) ?? [],
  );
  return buildTape(id, masks, undefined, touches);
}

/** Convert the always-from-boot subset of a DevTools tape. */
export function devtoolsTapeToInputTape(
  id: string,
  tape: DevtoolsTapeLike,
): InputTapeV1 {
  if ((tape.startFrame ?? 0) !== 0) {
    throw new Error("wrapped DevTools tapes cannot be benchmark inputs: startFrame must be 0");
  }
  const masks = expandPairs(tape.masks, 0, tape.frames);
  const analog = tape.analog ? expandPairs(tape.analog, 0x8080, tape.frames) : undefined;
  const contacts: LegacyTouchPoint[][] = Array.from({ length: tape.frames }, () => []);
  for (const [frame, packed] of tape.touch ?? []) {
    if (!Number.isInteger(frame) || frame < 0 || frame >= tape.frames) {
      throw new Error(`DevTools touch frame ${frame} is outside the tape`);
    }
    contacts[frame] = packed.map(unpackTouch);
  }
  return buildTape(id, masks, analog, contacts);
}

/** Convert tools/bench-ppsspp.ts's threshold-state input string. */
export function ppssppScriptToInputTape(
  id: string,
  frames: number,
  script: string,
): InputTapeV1 {
  const changes = script
    .split(",")
    .filter(Boolean)
    .map((entry) => {
      const [frame, value] = entry.split(":");
      return [Number(frame), Number(value)] as const;
    });
  let current = 0;
  let at = 0;
  const masks = new Array<number>(frames).fill(0);
  for (const [frame, value] of changes) {
    if (!Number.isInteger(frame) || frame < at || frame >= frames || !Number.isInteger(value)) {
      throw new Error(`invalid PPSSPP input change ${frame}:${value}`);
    }
    masks.fill(current, at, frame);
    current = value;
    at = frame;
  }
  masks.fill(current, at);
  return buildTape(id, masks);
}

/** Convert Vapor's ordered Button IDs into one-frame logical press pulses. */
export function vaporTodoToInputTape(
  id: string,
  buttons: readonly number[],
  options: { readonly bootFrames?: number; readonly spacing?: number } = {},
): InputTapeV1 {
  const bootFrames = options.bootFrames ?? 0;
  const spacing = options.spacing ?? 2;
  if (!Number.isInteger(bootFrames) || bootFrames < 0 || !Number.isInteger(spacing) || spacing < 2) {
    throw new Error("Vapor tape bootFrames must be >= 0 and spacing must be >= 2");
  }
  const frames = Math.max(1, bootFrames + buttons.length * spacing);
  const tracks = new Map<string, { frame: number; pressed: boolean }[]>();
  buttons.forEach((button, index) => {
    const control = VAPOR_BUTTONS[button];
    if (!control) throw new Error(`unknown Vapor Button ID ${button}`);
    const frame = bootFrames + index * spacing;
    const samples = tracks.get(control) ?? [];
    samples.push({ frame, pressed: true }, { frame: frame + 1, pressed: false });
    tracks.set(control, samples);
  });
  return parseInputTapeV1({
    schemaVersion: 1,
    kind: "pocketjs.perf.input-tape",
    id,
    frames,
    tracks: [...tracks].map(([control, samples]) => ({ kind: "button", control, samples })),
  });
}

function buildTape(
  id: string,
  masks: readonly number[],
  analog?: readonly number[],
  touches?: readonly (readonly LegacyTouchPoint[])[],
): InputTapeV1 {
  const frames = masks.length;
  if (frames === 0) throw new Error("benchmark tapes must contain at least one frame");
  if (analog && analog.length !== frames) throw new Error("analog frame count differs from buttons");
  if (touches && touches.length !== frames) throw new Error("touch frame count differs from buttons");
  const tracks: InputTrackV1[] = [...buttonTracks(masks)];
  if (analog) tracks.push(...analogTracks(analog));
  if (touches) tracks.push(...touchTracks(touches));
  return parseInputTapeV1({
    schemaVersion: 1,
    kind: "pocketjs.perf.input-tape",
    id,
    frames,
    tracks,
  });
}

function buttonTracks(masks: readonly number[]): InputTrackV1[] {
  return RAW_BUTTONS.flatMap(([mask, control]) => {
    const samples: { frame: number; pressed: boolean }[] = [];
    let previous = false;
    for (let frame = 0; frame < masks.length; frame++) {
      const pressed = (masks[frame] & mask) !== 0;
      if (pressed === previous) continue;
      samples.push({ frame, pressed });
      previous = pressed;
    }
    return samples.length > 0 ? [{ kind: "button", control, samples }] : [];
  });
}

function analogTracks(values: readonly number[]): InputTrackV1[] {
  const tracks: InputTrackV1[] = [];
  for (const [control, shift] of [["x", 8], ["y", 0]] as const) {
    const samples: { frame: number; value: number }[] = [];
    let previous = 128;
    for (let frame = 0; frame < values.length; frame++) {
      const raw = (values[frame] >>> shift) & 0xff;
      if (raw === previous) continue;
      const value = raw < 128 ? (raw - 128) / 128 : (raw - 128) / 127;
      samples.push({ frame, value });
      previous = raw;
    }
    if (samples.length > 0) tracks.push({ kind: "analog", control, samples });
  }
  return tracks;
}

function touchTracks(frames: readonly (readonly LegacyTouchPoint[])[]): InputTrackV1[] {
  const events = new Map<number, { frame: number; phase: "start" | "move" | "end"; x: number; y: number }[]>();
  let previous = new Map<number, LegacyTouchPoint>();
  for (let frame = 0; frame < frames.length; frame++) {
    const current = new Map(frames[frame].map((point) => [point.id, point]));
    for (const [id, point] of current) {
      const before = previous.get(id);
      if (!before) appendTouch(events, id, { frame, phase: "start", x: point.x, y: point.y });
      else if (before.x !== point.x || before.y !== point.y) {
        appendTouch(events, id, { frame, phase: "move", x: point.x, y: point.y });
      }
    }
    for (const [id, point] of previous) {
      if (!current.has(id)) appendTouch(events, id, { frame, phase: "end", x: point.x, y: point.y });
    }
    previous = current;
  }
  return [...events]
    .sort(([a], [b]) => a - b)
    .map(([id, samples]) => ({ kind: "touch", control: `contact-${id}`, samples }));
}

function appendTouch(
  events: Map<number, { frame: number; phase: "start" | "move" | "end"; x: number; y: number }[]>,
  id: number,
  event: { frame: number; phase: "start" | "move" | "end"; x: number; y: number },
): void {
  const list = events.get(id);
  if (list) list.push(event);
  else events.set(id, [event]);
}

function expandPairs(
  pairs: readonly (readonly [number, number])[],
  fill: number,
  frames: number,
): number[] {
  const out = new Array<number>(frames).fill(fill);
  let at = 0;
  for (const [value, count] of pairs) {
    if (!Number.isInteger(value) || !Number.isInteger(count) || count <= 0 || at + count > frames) {
      throw new Error(`invalid RLE pair [${value},${count}]`);
    }
    out.fill(value, at, at + count);
    at += count;
  }
  if (at !== frames) throw new Error(`RLE expands to ${at} frames, expected ${frames}`);
  return out;
}

function unpackTouch(value: number): LegacyTouchPoint {
  const wide = (value & 0x80000000) !== 0;
  const bits = wide ? 10 : 9;
  const mask = (1 << bits) - 1;
  return {
    id: (value >>> (bits * 2)) & 0xff,
    x: value & mask,
    y: (value >>> bits) & mask,
  };
}
