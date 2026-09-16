// VirtualList: the apps/im thread pattern, generalized.
//
// Two-node contract (the one Gallery documents in components.ts): an
// UNTRANSFORMED overflow-hidden viewport — its scissor comes from its own
// world box, so the clip node must never move — wrapping a full-content-
// height canvas whose translateY is a plain signal binding (paint-only: one
// setProp per moving frame, no relayout). Only the rows intersecting the
// viewport ± overscan are mounted; a thousand-row list costs the core a
// dozen nodes.
//
// Input layers, resolved by what the host delivers rather than by target:
//   touch   pan/fling through the gesture layer + kinetic scroller; a down
//           press-highlights the row under the finger (native `active:`
//           variant), a pan CLAIMS the contact and cancels the highlight,
//           a tap routes through pressNode() so touch taps, d-pad CIRCLE,
//           and cursor clicks land in the same onPress handler. On hosts
//           without touch (PSP) the recognizer simply never sees contacts.
//   d-pad   focusRows (default): a focus controller drives a focused index
//           with keep-in-view chase scrolling; rows unmounting off-window
//           never strand focus — the controller holds the authoritative
//           index and re-asserts it when the target row mounts. With
//           focusRows: false the d-pad scrolls the im way (bindDpadScroll).
//   cursor  rows are focusable, so hover-is-focus and click work as-is.
//
// No JSX and no class strings on purpose: composition is direct component
// calls with live getters (the components.ts style, testable under plain
// bun test), and all geometry is style-object based so nothing here depends
// on the pass-1 class harvest.

import { For, createEffect, createMemo, createSignal, onCleanup, onMount, untrack } from "solid-js";
import type { JSX as SolidJSX } from "solid-js";
import { ENUMS } from "../../contracts/spec/spec.ts";
import { createGesture, type GestureContact } from "./gesture.ts";
import {
  focusNode,
  getFocused,
  resolveTouchHit,
  pressNode,
  pushFocusController,
  setActiveNode,
  type FocusDirection,
} from "./input.ts";
import { bindDpadScroll, createScroller, type Scroller } from "./kinetics.ts";
import { onFrame } from "./frame.ts";
import { View } from "./primitives.ts";
import type { NodeMirror } from "./renderer.ts";
import type { SurfaceId } from "./display.ts";

export interface VirtualListHandle {
  scroller: Scroller;
  /** Shift the offset after a prepend so the viewport content does not move
   *  (the im rebase invariant). `addedPx` = height added ABOVE the window. */
  rebase(addedPx: number): void;
  rebaseRows(addedRows: number): void;
  scrollToIndex(index: number, align?: "start" | "center" | "end" | "nearest", animate?: boolean): void;
  focusedIndex(): number | null;
  /** Programmatic row focus (fresh-results entry point): scrolls the row
   *  into view and focuses it once mounted — the same path the d-pad walk
   *  takes. No-op with focusRows: false. */
  focusRow(index: number): void;
}

export interface VirtualListProps {
  /** UI output whose contacts drive this list. Default: primary. */
  surface?: SurfaceId;
  count: number;
  /** Fixed row height in logical px (uniform-row v1). */
  rowHeight: number;
  /** Viewport height in logical px. */
  height: number;
  renderRow: (index: number) => SolidJSX.Element;
  /** Extra px mounted beyond each viewport edge. Default 60 (im OVERSCAN). */
  overscan?: number;
  /** Inject a scroller (snap points, shared state). Its `max` should match
   *  this list's content. Default: one sized to count·rowHeight − height. */
  controller?: Scroller;
  /** Rows are Focusable and the d-pad drives a focused index (default).
   *  false: rows are plain views and the d-pad scrolls the im way. */
  focusRows?: boolean;
  onRowPress?: (index: number) => void;
  /** Fired every frame while the offset is within nearStartPx of the top —
   *  guard with your own loading/hasMore flags (the im convention). */
  onNearStart?: () => void;
  nearStartPx?: number;
  onNearEnd?: () => void;
  nearEndPx?: number;
  /** Follow appends while the user sits at the end (target-judged). */
  stickToBottom?: boolean;
  /** Gate d-pad/touch input (e.g. `() => !osk.isOpen()`). Default on. */
  inputActive?: () => boolean;
  /** Extra style merged onto the viewport (height/overflow stay owned here). */
  style?: Record<string, number | string>;
  ref?: (handle: VirtualListHandle) => void;
}

const DEFAULT_OVERSCAN = 60;
const DEFAULT_NEAR_PX = 36;

function isWithin(node: NodeMirror, ancestor: NodeMirror): boolean {
  let n: NodeMirror | null = node;
  while (n) {
    if (n === ancestor) return true;
    n = n.parent;
  }
  return false;
}

export function VirtualList(props: VirtualListProps): SolidJSX.Element {
  const overscan = () => props.overscan ?? DEFAULT_OVERSCAN;
  const focusRows = props.focusRows !== false;
  const active = () => (props.inputActive ? props.inputActive() : true);
  const total = () => props.count * props.rowHeight;

  const scroller =
    props.controller ??
    createScroller({
      max: () => Math.max(0, total() - props.height),
    });
  const offset = scroller.offset;

  let viewportNode: NodeMirror | undefined;
  const rowNodes = new Map<number, NodeMirror>();
  const [focusedIndex, setFocusedIndex] = createSignal<number | null>(null);
  /** A d-pad move targeting a row that has not mounted yet (chase scroll in
   *  flight). Asserted by the window effect the frame it appears. */
  let pendingFocus: number | null = null;

  // ---- windowing ----------------------------------------------------------

  const range = createMemo<readonly [number, number]>(
    (prev) => {
      const first = Math.max(0, Math.floor((offset() - overscan()) / props.rowHeight));
      const last = Math.min(
        props.count - 1,
        Math.floor((offset() + props.height + overscan() - 1) / props.rowHeight),
      );
      // Reference-stable across idle frames so <For> skips its diff.
      if (prev && prev[0] === first && prev[1] === last) return prev;
      return [first, last] as const;
    },
    [0, -1] as const,
  );

  const visible = createMemo<number[]>(() => {
    const [first, last] = range();
    const out: number[] = [];
    for (let i = first; i <= last; i++) out.push(i);
    return out;
  });

  // ---- focus (d-pad) ------------------------------------------------------

  const currentIndex = (): number | null => {
    const f = getFocused();
    if (f) {
      for (const [i, n] of rowNodes) {
        if (isWithin(f, n)) return i;
      }
    }
    return untrack(focusedIndex);
  };

  function scrollToIndex(
    index: number,
    align: "start" | "center" | "end" | "nearest" = "nearest",
    animate = true,
  ): void {
    const rowTop = index * props.rowHeight;
    const rowBottom = rowTop + props.rowHeight;
    const o = untrack(offset);
    let to: number;
    switch (align) {
      case "start":
        to = rowTop;
        break;
      case "center":
        to = rowTop - (props.height - props.rowHeight) / 2;
        break;
      case "end":
        to = rowBottom - props.height;
        break;
      default: {
        if (rowTop < o) to = rowTop;
        else if (rowBottom > o + props.height) to = rowBottom - props.height;
        else return; // already fully in view
      }
    }
    if (animate) scroller.chaseTo(to);
    else scroller.scrollTo(to, { immediate: true });
  }

  function focusIndex(index: number): void {
    setFocusedIndex(index);
    scrollToIndex(index, "nearest");
    const node = rowNodes.get(index);
    if (node) {
      pendingFocus = null;
      focusNode(node);
    } else {
      pendingFocus = index; // mounts within a frame or two of the chase
    }
  }

  const moveFocus = (direction: FocusDirection): boolean => {
    if (direction !== "up" && direction !== "down") return false; // leave the list
    if (!active() || props.count === 0) return false;
    const at = currentIndex();
    if (at === null) {
      focusIndex(Math.max(0, Math.min(props.count - 1, Math.floor(untrack(offset) / props.rowHeight))));
      return true;
    }
    const next = direction === "down" ? at + 1 : at - 1;
    if (next < 0 || next >= props.count) return true; // clamp at the ends
    focusIndex(next);
    return true;
  };

  onMount(() => {
    if (focusRows) {
      if (viewportNode) onCleanup(pushFocusController(viewportNode, moveFocus));
      // Re-assert a focus move whose row was not mounted yet.
      createEffect(() => {
        visible();
        if (pendingFocus === null) return;
        const node = rowNodes.get(pendingFocus);
        if (node) {
          pendingFocus = null;
          focusNode(node);
        }
      });
    } else {
      bindDpadScroll(scroller, { active });
    }
  });

  // ---- touch --------------------------------------------------------------

  const rowFromContact = (c: GestureContact): { index: number; node: NodeMirror | null } | null => {
    // The contact's hit fact (or its cold-query fallback) names the exact
    // node under the finger; the row is whichever mounted row's subtree
    // contains it. Bounds semantics make this total for full-bleed rows; a
    // hit on the canvas/viewport itself is a row GAP — a separator tap, and
    // separators don't press (the UIKit convention).
    const hit = resolveTouchHit(c.x, c.y, c.hit, c.surface);
    if (hit) {
      for (const [i, n] of rowNodes) {
        if (isWithin(hit, n)) return { index: i, node: n };
      }
    }
    return null;
  };

  createGesture({
    surface: props.surface,
    region: { node: () => viewportNode },
    axis: "y",
    onDown: (c) => {
      if (!active()) return;
      scroller.stop(); // a finger down arrests any fling in flight
      if (!focusRows) return;
      const row = rowFromContact(c);
      if (row?.node) setActiveNode(row.node);
    },
    onPanStart: () => {
      if (!active()) return;
      setActiveNode(null);
      scroller.beginDrag();
    },
    onPanMove: (c) => {
      if (!active()) return;
      scroller.drag(-c.fdy); // content follows the finger
    },
    onPanEnd: (c) => {
      if (!active()) return;
      scroller.endDrag(-c.vy);
    },
    onTap: (c) => {
      if (!active()) return;
      const row = rowFromContact(c);
      if (!row) return;
      setActiveNode(null);
      setFocusedIndex(row.index);
      if (row.node && focusRows) {
        pressNode(row.node); // same onPress path as CIRCLE and cursor clicks
      } else {
        props.onRowPress?.(row.index);
      }
    },
    onCancel: () => {
      setActiveNode(null);
      if (scroller.state() === "tracking") scroller.endDrag(0); // no fling out of a modal open
    },
  });

  // ---- per-frame pump + data-flow invariants ------------------------------

  onFrame(() => {
    scroller.step();
    // Keep the focused index in sync when focus entered a row through linear
    // traversal or removal repair (paths the controller does not see).
    if (focusRows) {
      const f = getFocused();
      if (f) {
        for (const [i, n] of rowNodes) {
          if (isWithin(f, n)) {
            if (untrack(focusedIndex) !== i) setFocusedIndex(i);
            break;
          }
        }
      }
    }
    const o = untrack(offset);
    if (props.onNearStart && o < (props.nearStartPx ?? DEFAULT_NEAR_PX)) props.onNearStart();
    if (props.onNearEnd) {
      const max = Math.max(0, total() - props.height);
      if (o > max - (props.nearEndPx ?? DEFAULT_NEAR_PX)) props.onNearEnd();
    }
  });

  // Stick-to-bottom: follow appends while the INTENT was at the PREVIOUS
  // end (the im rule — at-bottom is judged before the append grew the range,
  // and on the target rather than the eased position).
  let prevCount = props.count;
  createEffect(() => {
    const count = props.count;
    untrack(() => {
      if (props.stickToBottom && count > prevCount) {
        const prevMax = Math.max(0, prevCount * props.rowHeight - props.height);
        if (scroller.intent() >= prevMax - 8) {
          scroller.chaseTo(Math.max(0, count * props.rowHeight - props.height));
        }
      }
      prevCount = count;
    });
  });

  // Handle methods run in CALLER reactive scopes (effects, event handlers):
  // untrack every props read so an effect that calls focusRow(0) does not
  // silently subscribe to count/rowHeight and re-fire on every append.
  const handle: VirtualListHandle = {
    scroller,
    rebase: (px) => scroller.rebase(px),
    rebaseRows: (rows) => untrack(() => scroller.rebase(rows * props.rowHeight)),
    scrollToIndex: (index, align, animate) => untrack(() => scrollToIndex(index, align, animate)),
    focusedIndex,
    focusRow(index: number): void {
      untrack(() => {
        if (!focusRows || props.count === 0) return;
        focusIndex(Math.max(0, Math.min(props.count - 1, index)));
      });
    },
  };
  props.ref?.(handle);

  // ---- the two-node contract ----------------------------------------------

  const row = (index: number): SolidJSX.Element =>
    View({
      focusable: focusRows,
      onPress: props.onRowPress ? () => props.onRowPress!(index) : undefined,
      style: {
        posType: ENUMS.PosType.Absolute,
        insetT: index * props.rowHeight,
        insetL: 0,
        insetR: 0,
        height: props.rowHeight,
      },
      ref: (node: NodeMirror) => {
        rowNodes.set(index, node);
        onCleanup(() => {
          if (rowNodes.get(index) === node) rowNodes.delete(index);
        });
      },
      get children() {
        return props.renderRow(index);
      },
    });

  return View({
    get style() {
      return {
        overflow: ENUMS.Overflow.Hidden,
        height: props.height,
        // Full parent width by default (SIZE_FULL): a plain View is a flex
        // ROW, so an unsized viewport inside one lays out at width 0 and the
        // whole list silently paints nothing (found the hard way — the mock
        // host has no layout, so only a real core catches it).
        width: -1,
        ...props.style,
      };
    },
    ref: (node: NodeMirror) => {
      viewportNode = node;
    },
    children: View({
      get style() {
        return {
          posType: ENUMS.PosType.Absolute,
          insetT: 0,
          insetL: 0,
          insetR: 0,
          height: total(),
          translateY: -offset(),
        };
      },
      children: For({
        get each() {
          return visible();
        },
        children: row,
      }),
    }),
  });
}
