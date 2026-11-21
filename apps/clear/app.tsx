// Pocket Clear — the classic gesture-driven todo list, rebuilt on the
// PocketJS gesture layer in Vue Vapor JSX. Every interaction is a gesture:
// swipe right to complete, swipe left to delete, tap to edit, long-press to
// reorder, pull down to create (twice as far to go back to the lists), pull
// up past the end to clear the done pile, pinch two rows apart to insert.
//
// Layout model, straight from the reference demo: the screen root clips, and
// each screen is a full-content-height CANVAS translated inside it — the
// scroller drives the canvas, absolute 62px rows ride the canvas, and screen
// switches are vertical canvas moves. The pull-to-create flap folds in real
// 3D (rotateX under a perspective root).
//
// The module split: rows.tsx owns the row pool + row JSX, lists-screen.tsx
// the blue lists canvas, swipe.ts the horizontal swipe visuals, editor.ts
// the edit state + keyboard wiring (keyboard.tsx/kb-layout.ts the keyboard
// itself). This file owns the model-to-slot layout pass, scrolling, the
// pull affordances, screen transitions, and the remaining gestures. ALL
// motion goes through jump()/animate() on captured NodeMirrors — never
// through :style objects, whose reactive re-application would clobber
// in-flight tweens.

import { onMounted, shallowRef } from "vue";
import { Text, View, type NodeMirror } from "@pocketjs/framework/components";
import { animate, jump } from "@pocketjs/framework/animation";
import { onFrame } from "@pocketjs/framework/lifecycle";
import { createGesture } from "@pocketjs/framework/gesture";
import { createScroller } from "@pocketjs/framework/kinetics";
import { reportAppAction } from "@pocketjs/framework/host";
import { after } from "@pocketjs/framework/clock";
import {
  clearDone,
  insertTodo,
  movePending,
  ordered,
  pendingCount,
  removeTodo,
  seedLists,
  setDone,
  MAX_TODOS,
  type Todo,
} from "./model.ts";
import { DONE_FROM, DONE_TEXT, DONE_TO, todoRowColors } from "./palette.ts";
import {
  OVERSCROLL,
  PINCH_COMMIT,
  PULL_BACK,
  PULL_CLEAR,
  PULL_CREATE,
  ROW_H,
  SCREEN_H,
  SCREEN_W,
  SWITCH_MS,
} from "./metrics.ts";
import { KB_H } from "./keyboard-metrics.ts";
import { makeSlots, PARKED_Y, renderRow, resetSlotMotion, type RowSlot } from "./rows.tsx";
import { makeListsScreen } from "./lists-screen.tsx";
import { makeEditor } from "./editor.ts";
import { attachSwipeGesture } from "./swipe.ts";

const VIEW_H = SCREEN_H;

/** Where the todos canvas rests while the lists screen owns the display. */
const TODOS_PARKED_Y = SCREEN_H + 2 * ROW_H;

export default () => {
  const lists = seedLists();
  let activeIndex = 0;
  let screenName: "lists" | "todos" | "switching" = "lists";
  let order: Todo[] = [];
  let contentH = 0;
  let actions = 0;

  const list = () => lists[activeIndex];

  const listsScreen = makeListsScreen(lists);
  let todosCanvas: NodeMirror | null = null;
  let flapNode: NodeMirror | null = null;
  let topSwitchNode: NodeMirror | null = null;
  let previewNode: NodeMirror | null = null;
  let footerNode: NodeMirror | null = null;

  const flapText = shallowRef("Pull to Create Item");
  const hasDone = shallowRef(false);

  const slots = makeSlots(MAX_TODOS);
  const slotByTodo = new Map<number, RowSlot>();

  // -------------------------------------------------------------- scrolling
  const scroller = createScroller({
    max: () => Math.max(0, contentH - VIEW_H),
    extent: () => VIEW_H,
    overscroll: OVERSCROLL,
  });
  const listsScroller = createScroller({
    max: () => Math.max(0, listsScreen.height - VIEW_H),
    extent: () => VIEW_H,
    overscroll: OVERSCROLL,
  });
  let paintedOffset = 0;
  let paintedListsOffset = 0;
  let paintedPull = 0;
  /** Whether the lists canvas sits at its above-the-todos parking spot. */
  let listsParked = false;

  function report(): void {
    actions += 1;
    reportAppAction("clear_gesture", actions);
  }

  // ---------------------------------------------------------------- layout
  function allocSlot(todo: Todo): RowSlot {
    for (const slot of slots) {
      if (slot.todoId === -1 && !slot.busy) {
        slot.todoId = todo.id;
        slot.done.value = todo.done;
        slot.lift.value = 0;
        resetSlotMotion(slot);
        slotByTodo.set(todo.id, slot);
        return slot;
      }
    }
    throw new Error("clear: row pool exhausted");
  }

  /** Re-derive every slot from the model. Structural motion (row y, colors)
   *  animates when `animated`; text and looks snap. */
  function layout(animated: boolean): void {
    const current = list();
    order = ordered(current);
    contentH = order.length * ROW_H;
    const pending = pendingCount(current);
    listsScreen.refresh(activeIndex);
    hasDone.value = order.length > pending;
    if (todosCanvas) jump(todosCanvas, "height", Math.max(contentH, VIEW_H));
    // The pull-to-clear hint hides below the fold until an overscroll reveals it.
    if (footerNode) jump(footerNode, "translateY", Math.max(contentH, VIEW_H));

    // Park stale slots BEFORE allocating: a list switch retires one list's
    // rows and claims another's in the same pass, and the two together can
    // exceed the pool (9 + 14 > 20 froze the device until this ordering).
    const live = new Set<number>();
    for (const todo of order) live.add(todo.id);
    for (const slot of slots) {
      if (slot.todoId !== -1 && !slot.busy && !live.has(slot.todoId)) parkSlot(slot);
    }

    for (let index = 0; index < order.length; index += 1) {
      const todo = order[index];
      const slot = slotByTodo.get(todo.id) ?? allocSlot(todo);
      slot.done.value = todo.done;
      if (editor.editing() !== todo) slot.text.value = todo.text;

      const y = index * ROW_H;
      if (slot.node) {
        if (animated && slot.y !== y && slot.y !== PARKED_Y) {
          animate(slot.node, "translateY", y, { dur: 220, easing: "out" });
        } else {
          jump(slot.node, "translateY", y);
        }
      }
      slot.y = y;

      if (slot.strike && editor.editing() !== todo) {
        jump(slot.strike, "scaleX", todo.done ? 1 : 0);
        jump(slot.strike, "bgColor", todo.done ? DONE_TEXT : "#ffffff");
      }

      const [from, to] = todo.done ? [DONE_FROM, DONE_TO] : todoRowColors(index, pending);
      if (slot.front && (from !== slot.gradFrom || to !== slot.gradTo)) {
        if (animated && slot.gradFrom !== "") {
          animate(slot.front, "gradFrom", from, { dur: 220, easing: "out" });
          animate(slot.front, "gradTo", to, { dur: 220, easing: "out" });
        } else {
          jump(slot.front, "gradFrom", from);
          jump(slot.front, "gradTo", to);
        }
        slot.gradFrom = from;
        slot.gradTo = to;
      }
    }
  }

  function parkSlot(slot: RowSlot): void {
    slotByTodo.delete(slot.todoId);
    slot.todoId = -1;
    slot.y = PARKED_Y;
    slot.gradFrom = "";
    slot.gradTo = "";
    slot.lift.value = 0;
    slot.text.value = "";
    if (slot.node) jump(slot.node, "translateY", PARKED_Y);
    resetSlotMotion(slot);
  }

  /** A deleted row slides out first; park it once the exit tween lands. */
  function parkAfterExit(slot: RowSlot): void {
    after(SWITCH_MS / 1000 + 0.02, () => {
      slot.busy = false;
      slot.y = PARKED_Y;
      slot.text.value = "";
      if (slot.node) jump(slot.node, "translateY", PARKED_Y);
      resetSlotMotion(slot);
    });
  }

  /** Display index under a screen y, or -1 outside the rows. */
  function rowIndexAt(screenY: number): number {
    const index = Math.floor((screenY + scroller.offset()) / ROW_H);
    return index >= 0 && index < order.length ? index : -1;
  }

  // ---------------------------------------------------------------- editor
  const editor = makeEditor({
    list,
    order: () => order,
    slots,
    slotFor: (todoId) => slotByTodo.get(todoId),
    scrollOffset: () => scroller.offset(),
    canvas: () => todosCanvas,
    layout,
    report,
  });
  const kb = editor.kb;

  // ------------------------------------------------------------- creation
  function createAt(index: number): void {
    const todo = insertTodo(list(), index, "");
    if (!todo) return;
    layout(false);
    report();
    editor.open(todo, true);
  }

  // ------------------------------------------------------------ navigation
  /** Park the lists canvas above the todos so a long pull drags it back in. */
  function parkListsForPulldown(): void {
    listsParked = true;
    const canvas = listsScreen.canvas();
    if (canvas) jump(canvas, "translateY", -(listsScreen.height + ROW_H));
    for (let i = 0; i < lists.length; i += 1) {
      const node = listsScreen.rowNode(i);
      if (node) {
        jump(node, "translateY", i * ROW_H);
        jump(node, "opacity", 1);
      }
    }
    listsScroller.scrollTo(0, { immediate: true });
    paintedListsOffset = 0;
  }

  function openList(index: number): void {
    activeIndex = index;
    screenName = "switching";
    const loff = listsScroller.offset();
    // The lists clear away vertically: the tapped row rides to the top edge
    // and fades, rows above stack off the top, rows below drop off the bottom.
    for (let i = 0; i < lists.length; i += 1) {
      const node = listsScreen.rowNode(i);
      if (!node) continue;
      const screenTarget = i <= index ? (i - index) * ROW_H : SCREEN_H + (i - index) * ROW_H;
      animate(node, "translateY", screenTarget + loff, { dur: SWITCH_MS, easing: "out" });
    }
    const tapped = listsScreen.rowNode(index);
    if (tapped) animate(tapped, "opacity", 0, { dur: SWITCH_MS, easing: "out" });
    // The todo stack starts squeezed at the tapped row's screen position and
    // unfolds downward while the canvas rides to the top.
    scroller.scrollTo(0, { immediate: true });
    paintedOffset = 0;
    paintedPull = 0;
    layout(false);
    for (const slot of slots) {
      if (slot.todoId !== -1 && slot.node) jump(slot.node, "translateY", 0);
    }
    if (todosCanvas) {
      jump(todosCanvas, "translateY", index * ROW_H - loff);
      animate(todosCanvas, "translateY", 0, { dur: SWITCH_MS, easing: "out" });
    }
    for (const slot of slots) {
      if (slot.todoId !== -1 && slot.node) {
        animate(slot.node, "translateY", slot.y, { dur: SWITCH_MS, easing: "out" });
      }
    }
    if (flapNode) jump(flapNode, "opacity", 0);
    after(SWITCH_MS / 1000, () => {
      screenName = "todos";
      parkListsForPulldown();
    });
    report();
  }

  function goBack(): void {
    if (editor.editing()) editor.close(false);
    screenName = "switching";
    listsScreen.refresh();
    // Both canvases travel DOWN: the lists land from above, the todos drop
    // off the bottom.
    listsParked = false;
    const canvas = listsScreen.canvas();
    if (canvas) animate(canvas, "translateY", 0, { dur: SWITCH_MS, easing: "out" });
    if (todosCanvas) animate(todosCanvas, "translateY", TODOS_PARKED_Y, { dur: SWITCH_MS, easing: "out" });
    scroller.scrollTo(0, { immediate: true });
    paintedOffset = 0;
    paintedPull = 0;
    if (flapNode) jump(flapNode, "opacity", 0);
    if (topSwitchNode) jump(topSwitchNode, "opacity", 0);
    listsScroller.scrollTo(0, { immediate: true });
    paintedListsOffset = 0;
    after(SWITCH_MS / 1000, () => {
      screenName = "lists";
    });
    report();
  }

  // ------------------------------------------------------------- gestures
  const inTodoList = () =>
    screenName === "todos" && !editor.editing()
      ? { x: 0, y: 0, w: SCREEN_W, h: SCREEN_H }
      : null;
  const inLists = () =>
    screenName === "lists" ? { x: 0, y: 0, w: SCREEN_W, h: SCREEN_H } : null;

  // Vertical pan: kinetic scroll + the three pull affordances.
  createGesture({
    axis: "y",
    region: { rect: inTodoList },
    onPanStart: () => scroller.beginDrag(),
    onPanMove: (c) => scroller.drag(-c.fdy),
    onPanEnd: (c) => {
      const off = scroller.offset();
      const overTop = -off;
      const overBottom = off - Math.max(0, contentH - VIEW_H);
      if (overTop >= PULL_BACK) {
        goBack();
        return;
      }
      if (overTop >= PULL_CREATE) {
        // Snap home (the reference shifts the canvas instantly too), then
        // open the editor on the fresh top row.
        scroller.scrollTo(0, { immediate: true });
        paintedOffset = 0;
        paintedPull = 0;
        if (todosCanvas) jump(todosCanvas, "translateY", 0);
        if (flapNode) jump(flapNode, "opacity", 0);
        createAt(0);
        return;
      }
      if (overBottom >= PULL_CLEAR && hasDone.value) {
        scroller.endDrag(0);
        const removed = clearDone(list());
        if (removed > 0) {
          layout(true);
          report();
        }
        return;
      }
      scroller.endDrag(-c.vy);
    },
    onCancel: () => scroller.endDrag(0),
  });

  // Horizontal pan on a row: complete (right) / delete (left).
  attachSwipeGesture({
    region: inTodoList,
    rowIndexAt,
    rowAt: (index) => {
      const todo = order[index];
      return todo ? { slot: slotByTodo.get(todo.id) ?? null, todo } : null;
    },
    complete(todo) {
      setDone(list(), todo, !todo.done);
      layout(true);
      report();
    },
    remove(todo, slot) {
      slot.busy = true;
      parkAfterExit(slot);
      removeTodo(list(), todo);
      slotByTodo.delete(todo.id);
      slot.todoId = -1;
      layout(true);
      report();
    },
  });

  // Long-press: pick a pending row up and reorder it.
  let dragSlot: RowSlot | null = null;
  let dragFrom = -1;
  let dragTo = -1;
  let dragBaseDy = 0;
  function previewShift(): void {
    for (let i = 0; i < order.length; i += 1) {
      const todo = order[i];
      if (todo.done) break;
      const slot = slotByTodo.get(todo.id);
      if (!slot?.node || slot === dragSlot) continue;
      const without = i - (i > dragFrom ? 1 : 0);
      const target = (without >= dragTo ? without + 1 : without) * ROW_H;
      if (slot.y !== target) {
        animate(slot.node, "translateY", target, { dur: 160, easing: "out" });
        slot.y = target;
      }
    }
  }
  createGesture({
    region: { rect: inTodoList },
    longPressSeconds: 0.45,
    onLongPress: (c) => {
      const index = rowIndexAt(c.startY);
      if (index < 0 || index >= pendingCount(list())) return;
      dragFrom = index;
      dragTo = index;
      dragBaseDy = c.dy;
      dragSlot = slotByTodo.get(order[index].id) ?? null;
      if (dragSlot?.node) {
        dragSlot.lift.value = 30;
        animate(dragSlot.node, "scale", 1.05, { dur: 120, easing: "out" });
      }
    },
    onMove: (c) => {
      if (!dragSlot?.node) return;
      const y = dragFrom * ROW_H + (c.dy - dragBaseDy);
      jump(dragSlot.node, "translateY", y);
      const pending = pendingCount(list());
      const hover = Math.max(0, Math.min(pending - 1, Math.round(y / ROW_H)));
      if (hover !== dragTo) {
        dragTo = hover;
        previewShift();
      }
    },
    onUp: () => {
      const slot = dragSlot;
      dragSlot = null;
      if (!slot?.node || dragFrom < 0) return;
      if (dragTo !== dragFrom) {
        movePending(list(), dragFrom, dragTo);
        report();
      }
      slot.lift.value = 0;
      animate(slot.node, "scale", 1, { dur: 120, easing: "out" });
      layout(true);
      dragFrom = -1;
    },
    onCancel: () => {
      const slot = dragSlot;
      dragSlot = null;
      if (slot?.node) {
        slot.lift.value = 0;
        animate(slot.node, "scale", 1, { dur: 120, easing: "out" });
      }
      dragFrom = -1;
      layout(true);
    },
  });

  // Tap: edit the pending row under the finger; a done row or the empty
  // space below creates at the end of the pending stack (the reference's
  // collection tap).
  createGesture({
    region: { rect: inTodoList },
    onTap: (c) => {
      const index = rowIndexAt(c.y);
      if (index >= 0 && !order[index].done) {
        editor.open(order[index], false);
        return;
      }
      createAt(pendingCount(list()));
    },
  });

  // Pinch two rows apart: insert between them.
  let pinchGap = -1;
  let pinchOpen = 0;
  function pinchRows(open: number): void {
    pinchOpen = open;
    for (let i = 0; i < order.length; i += 1) {
      const slot = slotByTodo.get(order[i].id);
      if (!slot?.node) continue;
      jump(slot.node, "translateY", i * ROW_H + (i >= pinchGap ? open : 0));
    }
    if (previewNode) {
      jump(previewNode, "translateY", pinchGap * ROW_H);
      jump(previewNode, "height", open);
      jump(previewNode, "opacity", Math.min(1, open / ROW_H));
    }
  }
  createGesture({
    axis: "y",
    region: { rect: inTodoList },
    onPinchStart: (p) => {
      pinchGap = Math.max(
        0,
        Math.min(pendingCount(list()), Math.round((p.cy + scroller.offset()) / ROW_H)),
      );
      pinchRows(0);
    },
    onPinchMove: (p) => {
      if (pinchGap < 0) return;
      pinchRows(Math.max(0, Math.min(ROW_H, p.dspan)));
    },
    onPinchEnd: () => {
      if (pinchGap < 0) return;
      const gap = pinchGap;
      const open = pinchOpen;
      pinchGap = -1;
      pinchOpen = 0;
      if (previewNode) {
        jump(previewNode, "height", 0);
        jump(previewNode, "opacity", 0);
      }
      if (open >= PINCH_COMMIT) {
        createAt(gap);
      } else {
        layout(true);
      }
    },
  });

  // Lists screen: kinetic scroll.
  createGesture({
    axis: "y",
    region: { rect: inLists },
    onPanStart: () => listsScroller.beginDrag(),
    onPanMove: (c) => listsScroller.drag(-c.fdy),
    onPanEnd: (c) => listsScroller.endDrag(-c.vy),
    onCancel: () => listsScroller.endDrag(0),
  });

  // Lists screen: tap a list to open it.
  createGesture({
    region: { rect: inLists },
    onTap: (c) => {
      const index = Math.floor((c.y + listsScroller.offset()) / ROW_H);
      if (index >= 0 && index < lists.length) openList(index);
    },
  });

  // While editing, a tap anywhere above the keyboard commits.
  createGesture({
    region: {
      rect: () =>
        screenName === "todos" && editor.editing()
          ? { x: 0, y: 0, w: SCREEN_W, h: SCREEN_H - kb.height() }
          : null,
    },
    onTap: () => editor.close(true),
  });

  // The keyboard claims its panel outright (registered last = top priority).
  // Contacts own holds and drags; a short space commits on release.
  createGesture({
    region: { rect: () => kb.rect() },
    onDown: (c) => kb.pressAt(c.x, c.y, SCREEN_H, c.id),
    onMove: (c) => kb.moveAt(c.x, c.y, c.id),
    onUp: (c) => kb.release(c.id),
    onCancel: (c) => kb.release(c.id, true),
  });

  // ------------------------------------------------------------ frame pump
  /** The pull-down affordances: fold the flap through its first row height,
   *  then hold it flat, then swap to the switch hint while the lists canvas
   *  rides down into view. */
  function paintPull(pull: number): void {
    if (!flapNode) return;
    const listsCanvas = listsScreen.canvas();
    if (pull <= 0) {
      jump(flapNode, "opacity", 0);
      if (topSwitchNode) jump(topSwitchNode, "opacity", 0);
      if (!listsParked) parkListsForPulldown();
      return;
    }
    if (pull >= PULL_BACK) {
      jump(flapNode, "opacity", 0);
      if (topSwitchNode) jump(topSwitchNode, "opacity", 1);
      listsParked = false;
      if (listsCanvas) jump(listsCanvas, "translateY", pull - PULL_BACK - listsScreen.height);
      return;
    }
    if (topSwitchNode) jump(topSwitchNode, "opacity", 0);
    if (!listsParked) parkListsForPulldown();
    const pct = Math.min(1, pull / PULL_CREATE);
    // NEGATIVE rotateX folds the top edge AWAY from the viewer (the engine's
    // positive angle tips it toward the camera and the taper clips away).
    jump(flapNode, "rotateX", (pct - 1) * 90);
    jump(flapNode, "opacity", pct / 2 + 0.5);
    flapText.value = pull >= PULL_CREATE ? "Release to Create Item" : "Pull to Create Item";
  }

  onFrame(() => {
    editor.step();
    const edited = editor.editing(), editedSlot = edited ? slotByTodo.get(edited.id) : undefined;
    const textHeight = edited ? SCREEN_H - kb.height() : SCREEN_H;
    const textOffset = scroller.offset() + Math.max(0, editedSlot ? editedSlot.y - scroller.offset() + ROW_H - textHeight : 0);
    for (const slot of slots) {
      slot.textVisible = screenName !== "lists" && (slot.todoId !== -1 || slot.busy) &&
        (slot === editedSlot || slot.y + ROW_H > textOffset - ROW_H && slot.y < textOffset + textHeight + ROW_H);
      slot.textPriority = slot === editedSlot ? 0 : 2;
    }
    if (screenName === "todos") {
      scroller.step();
      const off = scroller.offset();
      if (off !== paintedOffset && todosCanvas && !editor.editing()) {
        paintedOffset = off;
        jump(todosCanvas, "translateY", -off);
      }
      const pull = -off;
      if (pull !== paintedPull) {
        paintedPull = pull;
        paintPull(pull);
      }
    } else if (screenName === "lists") {
      listsScroller.step();
      const loff = listsScroller.offset();
      const listsCanvas = listsScreen.canvas();
      if (loff !== paintedListsOffset && listsCanvas) {
        paintedListsOffset = loff;
        jump(listsCanvas, "translateY", -loff);
      }
    }
  });

  onMounted(() => {
    for (const slot of slots) {
      if (slot.node) jump(slot.node, "translateY", PARKED_Y);
    }
    if (previewNode) {
      jump(previewNode, "height", 0);
      jump(previewNode, "opacity", 0);
    }
    if (footerNode) jump(footerNode, "translateY", VIEW_H);
  });

  // -------------------------------------------------------------- render
  return (
    <View class="w-full h-full bg-[#000000] overflow-hidden">
      <View
        nodeRef={(node) => {
          todosCanvas = node ?? null;
        }}
        class="absolute left-0 right-0 top-0"
        style={{ height: VIEW_H, translateY: TODOS_PARKED_Y }}
      >
        <View
          nodeRef={(node) => {
            topSwitchNode = node ?? null;
          }}
          class="absolute left-0 right-0 items-center justify-center"
          style={{ translateY: -2 * ROW_H, height: ROW_H, opacity: 0 }}
        >
          <Text class="text-xl font-bold text-white">Switch to Lists</Text>
        </View>
        <View
          class="absolute left-0 right-0"
          style={{ translateY: -ROW_H, height: ROW_H, perspective: 400 }}
        >
          <View
            nodeRef={(node) => {
              flapNode = node ?? null;
            }}
            class="absolute inset-0 flex-row items-center pl-3 bg-gradient-to-b from-[#f50018] to-[#e00016]"
            style={{ originY: 0.5, rotateX: -90, opacity: 0 }}
          >
            <Text class="text-xl font-bold text-white">{flapText.value}</Text>
          </View>
        </View>
        <View
          nodeRef={(node) => {
            previewNode = node ?? null;
          }}
          class="absolute left-0 right-0 top-0 bg-gradient-to-b from-[#f50018] to-[#e00016]"
        />
        <View
          nodeRef={(node) => {
            footerNode = node ?? null;
          }}
          class="absolute left-0 right-0 items-center justify-center"
          style={{ height: 2 * ROW_H }}
        >
          <Text class={hasDone.value ? "text-xl font-bold text-white" : "text-xl font-bold text-[#333333]"}>
            Pull to Clear
          </Text>
        </View>
        {slots.map((slot) => renderRow(slot))}
      </View>

      {listsScreen.view}

      {kb.view}
    </View>
  );
};
