// Device classes contributed by InputSource. Values are append-only. This
// vocabulary does not change the existing script frame arguments or tapes.
// input.axis.relative and input.motion.* are candidate capability ids for the
// runtime migration; they are not yet registered by platforms.ts or advertised
// by current profiles. Existing AOT axis/motion support declares demands, not
// profile capability ids.
import { BTN, ANALOG_CENTER } from "./spec.ts";
import { RelativeAxis, RelativeAxisUnits } from "./microts.ts";
import { MOTION_VALUES, MotionLevel, MotionQuality, MotionReferenceFrame } from "./motion.ts";

export { BTN, ANALOG_CENTER, RelativeAxis, RelativeAxisUnits, MOTION_VALUES, MotionLevel, MotionQuality, MotionReferenceFrame };

export const INPUT_CLASSES = {
  buttons: { bit: 1 << 0, constant: "BUTTONS", capabilities: ["input.buttons"] },
  "axis.absolute": { bit: 1 << 1, constant: "AXIS_ABSOLUTE", capabilities: ["input.analog.left", "input.analog.right"] },
  "axis.relative": { bit: 1 << 2, constant: "AXIS_RELATIVE", capabilities: ["input.axis.relative"] },
  pointer: { bit: 1 << 3, constant: "POINTER", capabilities: ["input.pointer"] },
  contact: { bit: 1 << 4, constant: "CONTACT", capabilities: ["input.touch", "input.touch.auxiliary"] },
  text: { bit: 1 << 5, constant: "TEXT", capabilities: ["input.text", "input.ime"] },
  motion: { bit: 1 << 6, constant: "MOTION", capabilities: ["input.motion.gravity", "input.motion.inertial", "input.motion.geomagnetic"] },
} as const;
export type InputClass = keyof typeof INPUT_CLASSES;

/** Absolute sticks use [0, 255], with 128 at rest, preserving the frame ABI. */
export const ABSOLUTE_AXES = { LEFT_X: 0, LEFT_Y: 1, RIGHT_X: 2, RIGHT_Y: 3 } as const;
/** Text payload is UTF-8; key events carry a named editing key in the payload. */
export const TEXT_EVENT_KINDS = { KEY_DOWN: 0, KEY_UP: 1, COMMIT: 2, COMPOSITION: 3, COMPOSITION_END: 4 } as const;
export const LEGACY_FRAME_ARGUMENTS = ["buttons", "analog", "touches", "hits", "touchSurfaces", "rightAnalog", "axisDeltas", "motion"] as const;

export function inputClassesForCapabilities(capabilities: readonly string[]): number {
  let classes = 0;
  for (const spec of Object.values(INPUT_CLASSES)) {
    if (spec.capabilities.some(capability => capabilities.includes(capability))) classes |= spec.bit;
  }
  return classes;
}

const constantName = (name: string) => name.replace(/([a-z0-9])([A-Z])/g, "$1_$2").toUpperCase();
export const INPUT_ABI_CONSTANTS: Readonly<Record<string, number>> = {
  ...Object.fromEntries(Object.values(INPUT_CLASSES).map(value => [`POCKET_INPUT_CLASS_${value.constant}`, value.bit])),
  ...Object.fromEntries(Object.entries(BTN).map(([name, value]) => [`POCKET_BUTTON_${name}`, value])),
  POCKET_ANALOG_CENTER: ANALOG_CENTER,
  ...Object.fromEntries(Object.entries(ABSOLUTE_AXES).map(([name, value]) => [`POCKET_AXIS_${name}`, value])),
  ...Object.fromEntries(Object.entries(RelativeAxis).map(([name, value]) => [`POCKET_RELATIVE_AXIS_${constantName(name)}`, value])),
  ...Object.fromEntries(Object.entries(RelativeAxisUnits).map(([name, value]) => [`POCKET_RELATIVE_AXIS_${constantName(name)}`, value])),
  ...Object.fromEntries(Object.entries(TEXT_EVENT_KINDS).map(([name, value]) => [`POCKET_TEXT_${name}`, value])),
  ...Object.fromEntries(Object.entries(MotionLevel).map(([name, value]) => [`POCKET_MOTION_LEVEL_${constantName(name)}`, value])),
  ...Object.fromEntries(Object.entries(MotionQuality).map(([name, value]) => [`POCKET_MOTION_QUALITY_${constantName(name)}`, value])),
  ...Object.fromEntries(Object.entries(MotionReferenceFrame).map(([name, value]) => [`POCKET_MOTION_REFERENCE_${constantName(name)}`, value])),
  ...Object.fromEntries(Object.entries(MOTION_VALUES).map(([name, value]) => [`POCKET_MOTION_VALUE_${constantName(name)}`, value.id])),
};
