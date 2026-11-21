// Framework-neutral analog input state.
//
// Solid and Vue Vapor have different lifecycle/disposal integrations, but a
// host frame carries the same packed left-stick sample to both. Keep decoding
// and deadzone policy here so every framework observes one public contract.

import { ANALOG_CENTER } from "../../contracts/spec/spec.ts";

/** Fraction of half-range ignored around the stick center (PSP nubs drift). */
const ANALOG_DEADZONE = 0.12;

let analogPacked = ANALOG_CENTER, rightPacked = ANALOG_CENTER;

export function __setAnalog(packed: number | undefined, right: number | undefined = undefined): void {
  analogPacked = packed === undefined ? ANALOG_CENTER : packed & 0xffff;
  rightPacked = right === undefined ? ANALOG_CENTER : right & 0xffff;
}

export function __resetAnalog(): void {
  analogPacked = rightPacked = ANALOG_CENTER;
}

/** Raw packed left-stick value ((x << 8) | y) delivered by the host. */
export function analogRaw(): number {
  return analogPacked;
}

/** One axis normalized to -1..1 with the runtime deadzone applied. */
function axis(raw: number): number {
  // The negative half has 128 integer steps while the positive half has 127;
  // clamp the asymmetric 0 sample so the public range remains exactly -1..1.
  const value = Math.max(-1, Math.min(1, (raw - 128) / 127));
  const magnitude = Math.abs(value);
  if (magnitude < ANALOG_DEADZONE) return 0;
  // Rescale so the active range still spans 0..1 (no jump at the edge).
  return (Math.sign(value) * (magnitude - ANALOG_DEADZONE)) / (1 - ANALOG_DEADZONE);
}

/** Left-stick X in -1..1 (right positive), or 0 on stickless hosts. */
export function analogX(): number {
  return axis((analogPacked >> 8) & 0xff);
}

/** Left-stick Y in -1..1 (down positive), or 0 on stickless hosts. */
export function analogY(): number {
  return axis(analogPacked & 0xff);
}

/** Right stick, with the same center/deadzone as the left; absent hosts read zero. */
export function rightAnalogRaw(): number { return rightPacked; }
export function rightAnalogX(): number { return axis((rightPacked >> 8) & 0xff); }
export function rightAnalogY(): number { return axis(rightPacked & 0xff); }
