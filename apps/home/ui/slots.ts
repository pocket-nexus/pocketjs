// apps/home/ui/slots.ts — a long list drawn by a fixed pool of row slots.
//
// Mounting is the expensive part of a frame on an Old 3DS: QuickJS allocates
// for every node and binding, and a row of a dozen nodes costs more than a
// frame. Here the pool mounts once: slot k shows the band row whose index is
// k modulo the pool size, so a row entering the band repaints one slot and
// the others keep theirs (UITableView cell reuse).
//
// The repaint is imperative. A Solid binding that reruns costs about a
// millisecond of QuickJS on an Old 3DS (each run allocates its source and
// cleanup bookkeeping), and a slot driven by bindings reran a dozen of them
// per new row. A painter writes the few texts and offsets that differ, and
// keeps only rarely changing state (highlight, loading) in signals.

import { getFirstChild, replaceText, type NodeMirror } from "@pocketjs/framework/renderer";
import { onFrame } from "@pocketjs/framework/lifecycle";

export interface PlacedRow {
  /** Top in content px. Rows are in order of y. */
  y: number;
  h: number;
}

export interface SlotOptions {
  /** Visible content height. */
  view: number;
  /** Content px kept filled above and below the visible band. */
  overscan: number;
  /** The shortest row; sizes the pool so every band row has a slot. */
  minRowH: number;
}

export interface SlotPool<R> {
  /** Slot indices to mount, one component each. */
  slots: readonly number[];
  /** A mounted slot's painter: called with its current row now and with
   *  every different row (or null) after. */
  attach(slot: number, paint: (row: R | null) => void): void;
}

/** Places the band once per frame, outside the reactive graph: a memo on the
 *  scroll offset would go stale on every scrolled frame. */
export function createSlotPool<R extends PlacedRow>(
  rows: () => readonly R[],
  offset: () => number,
  options: SlotOptions,
): SlotPool<R> {
  const size = Math.ceil((options.view + options.overscan * 2) / options.minRowH) + 1;
  const shown: (R | null)[] = new Array(size).fill(null);
  const painters: (((row: R | null) => void) | undefined)[] = new Array(size);
  let placedRows: readonly R[] | null = null;
  let placedFirst = -1;
  let placedEnd = -1;
  const place = () => {
    const list = rows();
    const top = offset() - options.overscan;
    const bottom = offset() + options.view + options.overscan;
    let first = 0;
    let hi = list.length;
    while (first < hi) {
      const mid = (first + hi) >> 1;
      const row = list[mid]!;
      if (row.y + row.h > top) hi = mid;
      else first = mid + 1;
    }
    let end = first;
    while (end < list.length && end - first < size && list[end]!.y < bottom) end++;
    const sameList = list === placedRows;
    if (sameList && first === placedFirst && end === placedEnd) return;
    placedRows = list;
    placedFirst = first;
    placedEnd = end;
    for (let slot = 0; slot < size; slot++) {
      const index = first + ((slot - (first % size) + size) % size);
      const row = index < end ? list[index]! : null;
      if (row === shown[slot]) continue;
      // A row that left the band stays painted where it is, past the
      // overscan and out of sight, until a row entering the band takes its
      // slot: one repaint per row instead of a clear and a repaint.
      if (row === null && sameList) continue;
      shown[slot] = row;
      painters[slot]?.(row);
    }
  };
  place();
  onFrame(place);
  return {
    slots: Array.from({ length: size }, (_, slot) => slot),
    attach(slot, paint) {
      painters[slot] = paint;
      paint(shown[slot] ?? null);
    },
  };
}

/** Set a <Text>'s content in place. The element must have been mounted with
 *  a non-empty static child, which this replaces. */
export function paintText(element: NodeMirror, value: string): void {
  const node = getFirstChild(element);
  const text = value || " ";
  if (node && node.text !== text) replaceText(node, text);
}
