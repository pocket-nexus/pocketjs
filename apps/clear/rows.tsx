// The todo row pool: a fixed set of row nodes mounted once and re-assigned
// to todos after every mutation (app.tsx layout()). Each slot captures its
// NodeMirrors (row, slider front, swipe icons, strike-through bar) so ALL
// motion goes through jump()/animate() — the only reactive state per slot is
// its text, done-look and lift refs.

import { shallowRef, type ShallowRef } from "vue";
import { Text, View, type NodeMirror } from "@pocketjs/framework/components";
import { jump } from "@pocketjs/framework/animation";
import { remoteText } from "./remote-text.tsx";
import { ROW_H } from "./metrics.ts";

/** Off-canvas parking spot for unassigned row slots. */
export const PARKED_Y = 4000;

export interface RowSlot {
  node: NodeMirror | null;
  front: NodeMirror | null;
  check: NodeMirror | null;
  cross: NodeMirror | null;
  strike: NodeMirror | null;
  text: ReturnType<typeof shallowRef<string>>;
  done: ReturnType<typeof shallowRef<boolean>>;
  lift: ShallowRef<number>;
  todoId: number;
  /** Current resting y (display index * ROW_H). */
  y: number;
  /** Mid-exit animation: layout() must not repark or reuse it yet. */
  busy: boolean;
  gradFrom: string;
  gradTo: string;
  /** Measured title width (strike-through line length). */
  textW: number;
  textVisible: boolean;
  textPriority: number;
}

export function makeSlots(count: number): RowSlot[] {
  return Array.from({ length: count }, () => ({
    node: null,
    front: null,
    check: null,
    cross: null,
    strike: null,
    text: shallowRef(""),
    done: shallowRef(false),
    lift: shallowRef(0),
    todoId: -1,
    y: PARKED_Y,
    busy: false,
    gradFrom: "",
    gradTo: "",
    textW: 0,
    textVisible: false,
    textPriority: 2,
  }));
}

/** Snap every transient swipe/edit visual back to rest: slider home and
 *  opaque, icons hidden, strike collapsed. (Row y is the caller's.) */
export function resetSlotMotion(slot: RowSlot): void {
  if (slot.node) jump(slot.node, "translateX", 0);
  if (slot.front) {
    jump(slot.front, "translateX", 0);
    jump(slot.front, "opacity", 1);
  }
  if (slot.check) jump(slot.check, "opacity", 0);
  if (slot.cross) jump(slot.cross, "opacity", 0);
  if (slot.strike) jump(slot.strike, "scaleX", 0);
}

export function renderRow(slot: RowSlot) {
  return (
    <View
      nodeRef={(node) => {
        slot.node = node ?? null;
      }}
      class="absolute left-0 right-0 top-0 h-[62]"
      style={{ zIndex: slot.lift.value, shadow: slot.lift.value ? 3 : 0 }}
    >
      <View
        nodeRef={(node) => {
          slot.check = node ?? null;
        }}
        class="absolute left-0 top-0"
        style={{ width: ROW_H, height: ROW_H, opacity: 0 }}
      >
        {/* Both strokes overshoot the valley center (23, 39.5) by half a
            thickness so the rotated bars overlap into one clean joint. */}
        <View class="absolute bg-[#ffffff]" style={{ insetL: 9.3, insetT: 31.3, width: 19, height: 7, rotate: 45 }} />
        <View class="absolute bg-[#ffffff]" style={{ insetL: 15.3, insetT: 25.8, width: 35, height: 7, rotate: -45 }} />
      </View>
      <View
        nodeRef={(node) => {
          slot.cross = node ?? null;
        }}
        class="absolute right-0 top-0"
        style={{ width: ROW_H, height: ROW_H, opacity: 0 }}
      >
        <View class="absolute bg-[#eb0017]" style={{ insetL: 15, insetT: 28, width: 32, height: 7, rotate: 45 }} />
        <View class="absolute bg-[#eb0017]" style={{ insetL: 15, insetT: 28, width: 32, height: 7, rotate: -45 }} />
      </View>
      <View
        nodeRef={(node) => {
          slot.front = node ?? null;
        }}
        class="absolute inset-0 bg-gradient-to-b from-[#f50018] to-[#e00016]"
      >
        <View class="absolute left-0 right-0 top-0 bg-[#ffffff12]" style={{ height: 1 }} />
        <View class="absolute left-0 right-0 bottom-0 bg-[#0000001a]" style={{ height: 1 }} />
        <View class="absolute inset-0 flex-row items-center pl-3">
          {remoteText(() => slot.text.value ?? "", 296, 20, () => slot.done.value ? "#666666" : "#ffffff", true,
            undefined, () => slot.textVisible, () => slot.textPriority, width => {
              slot.textW = width;
              if (slot.strike) jump(slot.strike, "width", width);
            })}
        </View>
        <View
          nodeRef={(node) => {
            slot.strike = node ?? null;
          }}
          class="absolute bg-[#ffffff]"
          style={{ insetL: 12, insetT: 30, height: 2, width: 0, originX: -0.5, scaleX: 0 }}
        />
      </View>
    </View>
  );
}
