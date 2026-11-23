// PocketUI ui/transfer.ts — moving a thing onto another: a session onto a
// message being written, a file onto a pane.
//
// The application says what can be moved (a source and the item it gives)
// and what takes it (a target, what it accepts and what a drop does). How
// the move is made is the surface's `transfer` idiom:
//
//   drag    a long press lifts the item: a chip follows the contact, a
//           target under it that accepts the item shows it would, letting go
//           there drops, letting go anywhere else puts it back.
//   carry   a command picks the focused item up; the legend says so; the
//           focus moves as it always does; confirm on a target drops, back
//           puts it down where it was.
//
// Both end in the same `drop(item)`. A transfer never commits before the
// release or the confirm, and is cancelled by anything else that takes the
// contact or the buttons.
import { createSignal, getOwner, onCleanup, type Accessor, type Owner } from "solid-js";
import { animate, jump } from "../../animation.ts";
import { BTN } from "../../input-api.ts";
import { element, HSTACK, ZSTACK, type Instance, type UINode } from "./engine.ts";
import type { UI } from "./mount.ts";
import { TEXT } from "./textview.ts";

export interface TransferItem {
  /** what kind of thing it is: targets accept by this */
  type: string;
  id: string;
  /** what the chip says while it is carried */
  label: string;
}

export interface DropTarget {
  /** the instance whose rectangle takes the drop */
  within: () => Instance | null | undefined;
  accepts: (item: TransferItem) => boolean;
  drop: (item: TransferItem) => void;
}

export interface TransferCenter {
  /** what is being moved now, and by which idiom */
  carrying: Accessor<TransferItem | null>;
  /** the target the item would drop on if let go now */
  over: Accessor<DropTarget | null>;
  /** make an instance a source: a long press on it (or inside it) lifts what `item` gives */
  source(instance: () => Instance | null | undefined, item: () => TransferItem | null): () => void;
  target(target: DropTarget): () => void;
  /** pick `item` up with the buttons (the `carry` idiom) */
  carry(item: TransferItem): void;
  cancel(): void;
}

const within = (ancestor: Instance, instance: Instance | null): boolean => {
  for (let at: Instance | null = instance; at; at = at.parent) if (at === ancestor) return true;
  return false;
};

export function createTransferCenter(ui: UI, owner: Owner | null = getOwner()): TransferCenter {
  const [carrying, setCarrying] = createSignal<TransferItem | null>(null);
  const [over, setOver] = createSignal<DropTarget | null>(null);
  const sources: { instance: () => Instance | null | undefined; item: () => TransferItem | null }[] = [];
  const targets: DropTarget[] = [];
  let chip: { instance: Instance; remove(): void } | null = null;
  let stopButtons: (() => void) | null = null;

  const targetAt = (x: number, y: number, item: TransferItem): DropTarget | null => {
    for (let i = targets.length - 1; i >= 0; i--) {
      const target = targets[i]!;
      const instance = target.within();
      if (!instance?.placed || !target.accepts(item)) continue;
      const frame = instance.frame();
      if (x >= frame.x && y >= frame.y && x < frame.x + frame.w && y < frame.y + frame.h) return target;
    }
    return null;
  };

  const showChip = (item: TransferItem, x: number, y: number) => {
    chip = ui.root.addLayer(
      element(ZSTACK, {
        children: element(HSTACK, {
          anchor: "topLeading",
          part: "drag",
          maxWidth: 220,
          children: element(TEXT, { value: item.label, lines: 1 }) as UINode,
        }) as UINode,
      }),
      owner,
    );
    moveChip(x, y);
  };
  const moveChip = (x: number, y: number) => {
    const node = chip?.instance.kids()[0]?.node;
    if (!node) return;
    // the chip rides above the contact, where a finger does not cover it
    jump(node, "translateX", Math.round(x + 6));
    jump(node, "translateY", Math.round(y - 30));
  };
  const hideChip = (dropped: boolean) => {
    const held = chip;
    chip = null;
    if (!held) return;
    const node = held.instance.kids()[0]?.node;
    if (node && ui.idioms().transition !== "cut") {
      animate(node, "opacity", 0, { dur: dropped ? 90 : 160 });
      if (dropped) animate(node, "scale", 0.8, { dur: 90 });
      let frames = 12;
      const wait = () => {
        if (--frames > 0) return;
        ui.root.frameHooks.delete(wait);
        held.remove();
      };
      ui.root.frameHooks.add(wait);
    } else held.remove();
  };

  const finish = (target: DropTarget | null) => {
    const item = carrying();
    stopButtons?.();
    stopButtons = null;
    setCarrying(null);
    setOver(null);
    hideChip(target !== null);
    if (item && target) target.drop(item);
  };

  // drag: a long press on a source lifts its item
  ui.input.onLift = (pressed, x, y) => {
    if (ui.idioms().transfer !== "drag") return null;
    const source = sources.find((entry) => {
      const instance = entry.instance();
      return instance ? within(instance, pressed) : false;
    });
    const item = source?.item();
    if (!item) return null;
    setCarrying(item);
    showChip(item, x, y);
    return {
      source: pressed,
      move(mx, my) {
        moveChip(mx, my);
        const target = targetAt(mx, my, item);
        if (target !== over()) setOver(target);
      },
      end(ex, ey, cancelled) {
        finish(cancelled ? null : targetAt(ex, ey, item));
      },
    };
  };

  const center: TransferCenter = {
    carrying,
    over,
    source(instance, item) {
      const entry = { instance, item };
      sources.push(entry);
      return () => {
        const at = sources.indexOf(entry);
        if (at >= 0) sources.splice(at, 1);
      };
    },
    target(target) {
      targets.push(target);
      return () => {
        const at = targets.indexOf(target);
        if (at >= 0) targets.splice(at, 1);
        if (over() === target) setOver(null);
      };
    },
    carry(item) {
      if (carrying()) finish(null);
      setCarrying(item);
      // while it is carried: confirm on a target drops, back puts it down
      stopButtons = ui.input.onButton((button) => {
        if (button & BTN.CROSS) {
          finish(null);
          return true;
        }
        return false;
      });
      ui.input.onConfirm = (focused) => {
        const target = targets.find((entry) => {
          const instance = entry.within();
          return instance ? within(instance, focused) && entry.accepts(item) : false;
        });
        if (!target) return false;
        ui.input.onConfirm = null;
        finish(target);
        return true;
      };
      const stop = stopButtons;
      stopButtons = () => {
        stop();
        ui.input.onConfirm = null;
      };
    },
    cancel: () => finish(null),
  };
  if (getOwner()) onCleanup(() => finish(null));
  return center;
}
