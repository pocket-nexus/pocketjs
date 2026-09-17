import type { InputTapeV1, InputTrackV1, JsonValue } from "../core/types.ts";

/**
 * Hardware-neutral controls used by the benchmark tapes. The adapter owns
 * the mapping to the legacy PSP-shaped guest frame ABI; tapes never contain
 * PSP SDK masks or device-specific crank/button names.
 */
const GUEST_BUTTON_MASK: Readonly<Record<string, number>> = Object.freeze({
  primary: 0x2000,
  secondary: 0x1000,
  tertiary: 0x4000,
  quaternary: 0x8000,
  select: 0x0001,
  start: 0x0008,
  up: 0x0010,
  right: 0x0020,
  down: 0x0040,
  left: 0x0080,
  "shoulder-left": 0x0100,
  "shoulder-right": 0x0200,
});

export interface RelativeAxisEvent {
  readonly control: string;
  readonly delta: number;
}

export interface EffectEvent {
  readonly effect: string;
  readonly value: JsonValue;
}

export interface ExpandedInputFrame {
  readonly buttons: number;
  /** PSP-compatible packed analog value at the final guest ABI boundary. */
  readonly analog: number;
  /** Packed legacy touch contacts consumed by hosts/sim. */
  readonly touches: readonly number[] | undefined;
  readonly relativeAxes: readonly RelativeAxisEvent[];
  readonly effects: readonly EffectEvent[];
}

interface ActiveTouch {
  readonly id: number;
  x: number;
  y: number;
}

function eventTable<T extends InputTrackV1>(track: T): Map<number, T["samples"][number][]> {
  const table = new Map<number, T["samples"][number][]>();
  for (const sample of track.samples) {
    const values = table.get(sample.frame);
    if (values) values.push(sample);
    else table.set(sample.frame, [sample]);
  }
  return table;
}

function analogByte(value: number): number {
  // Benchmark tapes use a target-neutral -1..1 range. The guest ABI mapping
  // happens here, immediately before frame(), and nowhere in scenario data.
  const clamped = Math.max(-1, Math.min(1, value));
  if (clamped === 0) return 128;
  return clamped < 0
    ? Math.round(128 + clamped * 128)
    : Math.round(128 + clamped * 127);
}

function packTouch(id: number, x: number, y: number): number {
  // hosts/sim currently consumes the legacy 9-bit logical-coordinate form.
  // All v1 scenarios use the stock 480x272 viewport, so no information is
  // lost at this adapter boundary.
  return (((id & 0xff) << 18) | ((y & 0x1ff) << 9) | (x & 0x1ff)) >>> 0;
}

/** Expand a strict sparse tape into the exact input delivered each frame. */
export function expandInputTape(tape: InputTapeV1): ExpandedInputFrame[] {
  const buttons = new Map<string, boolean>();
  const analog = new Map<string, number>();
  const touches = new Map<string, ActiveTouch>();
  const tables = tape.tracks.map((track) => ({ track, samples: eventTable(track) }));
  const out: ExpandedInputFrame[] = [];

  for (let frame = 0; frame < tape.frames; frame++) {
    const relativeAxes: RelativeAxisEvent[] = [];
    const effects: EffectEvent[] = [];

    for (const { track, samples } of tables) {
      const at = samples.get(frame) ?? [];
      switch (track.kind) {
        case "button":
          for (const sample of at as typeof track.samples) {
            buttons.set(track.control, sample.pressed);
          }
          break;
        case "analog":
          for (const sample of at as typeof track.samples) {
            analog.set(track.control, sample.value);
          }
          break;
        case "touch": {
          const id = touchId(track.control);
          for (const sample of at as typeof track.samples) {
            if (sample.phase === "end" || sample.phase === "cancel") {
              touches.delete(track.control);
            } else {
              touches.set(track.control, { id, x: sample.x, y: sample.y });
            }
          }
          break;
        }
        case "relative-axis":
          for (const sample of at as typeof track.samples) {
            relativeAxes.push({ control: track.control, delta: sample.delta });
          }
          break;
        case "effect":
          for (const sample of at as typeof track.samples) {
            effects.push({ effect: track.effect, value: sample.value });
          }
          break;
      }
    }

    let buttonMask = 0;
    for (const [control, pressed] of buttons) {
      if (!pressed) continue;
      const mask = GUEST_BUTTON_MASK[control];
      if (mask === undefined) {
        throw new Error(`native perf runner does not map button control ${JSON.stringify(control)}`);
      }
      buttonMask |= mask;
    }

    const x = analogByte(analog.get("x") ?? 0);
    const y = analogByte(analog.get("y") ?? 0);
    const packedTouches = [...touches.values()]
      .sort((a, b) => a.id - b.id)
      .map((touch) => packTouch(touch.id, touch.x, touch.y));
    out.push({
      buttons: buttonMask,
      analog: ((x << 8) | y) >>> 0,
      touches: packedTouches.length > 0 ? packedTouches : undefined,
      relativeAxes,
      effects,
    });
  }
  return out;
}

function touchId(control: string): number {
  const match = /^contact-(\d+)$/.exec(control);
  if (!match) {
    throw new Error(
      `native perf runner touch controls must be contact-N, got ${JSON.stringify(control)}`,
    );
  }
  const id = Number(match[1]);
  if (!Number.isInteger(id) || id < 0 || id > 7) {
    throw new Error(`native perf runner touch id must be 0..7, got ${id}`);
  }
  return id;
}

export const NATIVE_INPUT_CAPABILITIES = Object.freeze([
  "input.buttons",
  "input.analog",
  "input.touch",
] as const);

/** Report adapter gaps before execution; never substitute neutral/default input. */
export function nativeInputUnsupportedReasons(tape: InputTapeV1): string[] {
  const reasons: string[] = [];
  for (const track of tape.tracks) {
    if (track.kind === "button" && GUEST_BUTTON_MASK[track.control] === undefined) {
      reasons.push(`native guest ABI has no button mapping for ${JSON.stringify(track.control)}`);
    } else if (track.kind === "analog" && track.control !== "x" && track.control !== "y") {
      reasons.push(`native guest ABI has no analog mapping for ${JSON.stringify(track.control)}`);
    } else if (track.kind === "touch") {
      try {
        touchId(track.control);
      } catch (error) {
        reasons.push(error instanceof Error ? error.message : String(error));
      }
    }
  }
  return reasons;
}
