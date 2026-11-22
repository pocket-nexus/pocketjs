// PocketUI ui/input.ts — the pointer and the buttons, over known rectangles.
//
// One recognizer covers the surface (PocketJS's gesture layer gives contact
// lifecycles; framework/src/gesture-core.ts). A contact's meaning is decided
// here from the instance path under it:
//
//   down         the deepest pressable shows its pressed look
//   tap          its onPress
//   long press   its onLongPress; a drag from there is a transfer (ui/transfer.ts)
//   pan          the deepest scroll view that can move that way takes the
//                contact, and the pressed look is withdrawn
//
// The d-pad moves one focus to the nearest control in the pressed direction
// (core/focus.ts), within the topmost layer that has a control. Focus shows
// only after a button was used and hides at the next contact, so a surface
// with both inputs reads as touch until the d-pad is touched (docs/HIG.md
// §3.2 states the same rule for PocketJS's own keyboard and lists).
//
// A pointer (capability input.pointer) that rests on the surface without a
// button down is hover: pointer.ts pointer(), read once a frame. Its press
// reaches here as an ordinary contact. Wheel and trackpad scrolling
// (input.scroll, pointer.ts onScroll) moves the deepest scroll view under the
// pointer that can still move that way.
import { onCleanup } from "solid-js";
import { getOps } from "../../host.ts";
import { BTN, onTextEvent, type TextEvent } from "../../input-api.ts";
import { createGesture, type GestureContact } from "../../gesture.ts";
import { onScroll, pointer } from "../../pointer.ts";
import { createElement, insertNode, setProp, type NodeMirror } from "../../renderer.ts";
import { firstFocus, pickFocus, type Direction, type FocusRect } from "../core/focus.ts";
import type { Instance, PanSession, ScrollTarget, UIRoot } from "./engine.ts";
import { cornerTexture, release, textureOf } from "./raster.ts";
import { REST } from "./theme.ts";

export interface InputOptions {
  surface: "primary" | "auxiliary";
  touch: boolean;
  buttons: boolean;
}

/** What a button press means once focus and scrolling had their turn. */
export type ButtonHandler = (button: number, repeat: boolean) => boolean;

export interface PointerDrag {
  /** the instance the drag started on */
  source: Instance;
  move(x: number, y: number): void;
  end(x: number, y: number, cancelled: boolean): void;
}

/** What typed text goes to: one at a time on a surface. */
export interface TextTarget {
  /** the instance that takes the text, for focus and taps */
  owner: Instance;
  /** one decoded text event; true when it was used */
  event(event: TextEvent): boolean;
  /** typing ended: another target took over, or the surface asked */
  blur(): void;
}

export interface UIInput {
  /** what the keyboard types into now */
  textTarget(): TextTarget | null;
  /** Give the keyboard to `target` (the host shows its keyboard while one is set), or end typing with null. */
  setTextTarget(target: TextTarget | null): void;
  /** the instance with the d-pad's focus, shown or not */
  focused(): Instance | null;
  focus(instance: Instance | null, show?: boolean): void;
  /** whether the focus ring shows: a button was the last input */
  focusVisible(): boolean;
  /** A pointer rests at a point of the surface without pressing, or (null) has left it. */
  hover(point: { x: number; y: number } | null): void;
  /** whether the last input was a button of the pad, shown focus or not (a menu opened by a button takes the focus) */
  byPad(): boolean;
  /** handlers run newest first after the d-pad and confirm; one that returns true ends the press */
  onButton(handler: ButtonHandler): () => void;
  /** called at a long press; returning a drag makes the rest of the contact a transfer */
  onLift: ((source: Instance, x: number, y: number) => PointerDrag | null) | null;
  /** asked before confirm presses the focused control; true: the press was taken (a carried item dropped there) */
  onConfirm: ((focused: Instance) => boolean) | null;
  /** one frame of buttons, from the root's frame hook */
  frame(buttons: number): void;
  /** move focus as the d-pad would */
  move(direction: Direction): boolean;
  /** keep the focus inside this instance's subtree while it is set (a sheet) */
  trap: Instance | null;
}

const REPEAT_AFTER = 22;
const REPEAT_EVERY = 5;
const DPAD: readonly [number, Direction][] = [
  [BTN.UP, "up"],
  [BTN.DOWN, "down"],
  [BTN.LEFT, "left"],
  [BTN.RIGHT, "right"],
];

function contains(ancestor: Instance, instance: Instance | null): boolean {
  for (let at: Instance | null = instance; at; at = at.parent) if (at === ancestor) return true;
  return false;
}

/** The focusable instances under `instance`, with their rectangles in surface coordinates.
 *  A control scrolled out of its scroll view's window counts only in the view the focus is in
 *  (`home`): focus moves to it and the view follows. Controls out of sight in other views do not. */
function collect(instance: Instance, ox: number, oy: number, out: { instance: Instance; rect: FocusRect }[], home: Instance | null, clip: FocusRect | null): void {
  if (instance.hidden || !instance.placed) return;
  const x = ox + instance.x;
  const y = oy + instance.y;
  if (instance.takesFocus) {
    const seen = clip === null || (x < clip.x + clip.w && y < clip.y + clip.h && x + instance.w > clip.x && y + instance.h > clip.y);
    if (seen) out.push({ instance, rect: { x, y, w: instance.w, h: instance.h } });
  }
  let inner = clip;
  if (instance === home) inner = null;
  else if (instance.clips() && inner !== null) {
    // what this instance shows of its children
    const x0 = Math.max(inner.x, x);
    const y0 = Math.max(inner.y, y);
    inner = { x: x0, y: y0, w: Math.max(0, Math.min(inner.x + inner.w, x + instance.w) - x0), h: Math.max(0, Math.min(inner.y + inner.h, y + instance.h) - y0) };
  }
  const [cx, cy] = instance.contentOffset();
  for (const kid of instance.kids()) collect(kid, x + cx, y + cy, out, home, inner);
}

export function attachInput(root: UIRoot, options: InputOptions): UIInput {
  let focused: Instance | null = null;
  let visible = false;
  const handlers: ButtonHandler[] = [];

  // the focus ring: one node over every layer, moved to the focused rectangle
  const ring: NodeMirror = createElement("view");
  let ringStyle: Record<string, number | string> = {};
  setProp(ring, "style", { posType: 1, opacity: 0, hitPass: 1, zIndex: 900 });
  insertNode(root.host, ring, null);
  const ringSides: NodeMirror[] = [];
  const ringCorners: NodeMirror[] = [];
  for (let i = 0; i < 4; i++) {
    const side = createElement("view");
    setProp(side, "style", { posType: 1, hitPass: 1, display: 1 });
    insertNode(ring, side);
    ringSides.push(side);
    const corner = createElement("image");
    setProp(corner, "style", { posType: 1, hitPass: 1, display: 1 });
    insertNode(ring, corner);
    ringCorners.push(corner);
  }
  let ringShape = "";
  let ringKey: string | null = null;
  /** Whether an instance is in what is shown now: a pane a deck has covered keeps its place and is not. */
  const onScreen = (instance: Instance): boolean => {
    for (let at = instance; at.parent; at = at.parent) if (!at.parent.kids().includes(at)) return false;
    return true;
  };
  const paintRing = () => {
    // the theme's ring (the "focus" part: its border, and its `pad` is how far outside the part it sits), unless the part shows the focus itself
    const theme = root.theme;
    const look = visible && focused !== null && focused.look ? focused.look() : undefined;
    const show = visible && focused !== null && focused.placed && theme.traits.focusRing && !focused.props.focusedBackground && look?.showsFocus !== true && onScreen(focused);
    const next: Record<string, number | string> = { opacity: show ? 1 : 0 };
    if (show) {
      const paint = theme.paint("focus", REST);
      const out = typeof paint.pad === "number" ? paint.pad : 1;
      const rect = focused!.frame();
      const w = rect.w + 2 * out;
      const h = rect.h + 2 * out;
      const width = paint.borderWidth ?? 2;
      const color = paint.border ?? theme.color.accent;
      const radius = Math.min(w / 2, h / 2, paint.radius ?? Math.max(0, (look?.radius ?? focused!.props.radius ?? theme.metric.radius) + out));
      next.insetL = rect.x - out;
      next.insetT = rect.y - out;
      next.width = w;
      next.height = h;
      // A ring with round corners is four straight sides and four corner
      // pictures (ui/raster.ts): the core draws a rounded border in steps a
      // logical pixel high. A square one is the node's own border.
      const key = radius >= 1 ? cornerTexture(radius, width, color) : null;
      const shape = `${w}|${h}|${width}|${radius}|${color}|${key !== null}`;
      if (key === null) {
        next.borderWidth = width;
        next.borderColor = color;
        next.radius = radius;
      } else {
        next.borderWidth = 0;
        next.radius = 0;
      }
      if (shape !== ringShape) {
        ringShape = shape;
        const sides: [number, number, number, number][] = [
          [radius, 0, w - 2 * radius, width],
          [radius, h - width, w - 2 * radius, width],
          [0, radius, width, h - 2 * radius],
          [w - width, radius, width, h - 2 * radius],
        ];
        const corners: [number, number, number, number][] = [
          [0, 0, 1, 1],
          [w - radius, 0, -1, 1],
          [0, h - radius, 1, -1],
          [w - radius, h - radius, -1, -1],
        ];
        for (let i = 0; i < 4; i++) {
          const [x, y, sw, sh] = sides[i]!;
          setProp(ringSides[i]!, "style", { insetL: x, insetT: y, width: Math.max(0, sw), height: Math.max(0, sh), bgColor: color, display: key === null || sw <= 0 || sh <= 0 ? 1 : 0 });
          const [cx, cy, fx, fy] = corners[i]!;
          setProp(ringCorners[i]!, "style", { insetL: cx, insetT: cy, width: radius, height: radius, scaleX: fx, scaleY: fy, display: key === null ? 1 : 0 });
          if (key !== null) getOps().setImage(ringCorners[i]!.id, textureOf(key));
        }
        release(ringKey);
        ringKey = key;
      } else release(key);
    }
    setProp(ring, "style", next, ringStyle);
    ringStyle = { ...ringStyle, ...next };
    // keep the ring the last child: layers are added after it
    if (root.host.children[root.host.children.length - 1] !== ring) insertNode(root.host, ring, null);
  };

  const setFocus = (next: Instance | null, show: boolean) => {
    if (next !== focused) {
      focused?.setFocused(false);
      focused = next;
    }
    visible = show;
    if (focused) focused.setFocused(show);
    if (focused && show) reveal(focused);
  };

  /** Scroll every scroll view above `instance` so it is in view. */
  const reveal = (instance: Instance) => {
    let y = instance.y;
    const h = instance.h;
    for (let p = instance.parent; p; p = p.parent) {
      const target = p.scrollTarget();
      if (target) {
        target.reveal({ y, h }, 12);
        y += p.y + p.contentOffset()[1];
      } else y += p.y;
    }
  };

  const scope = (): Instance | null => {
    if (api.trap && api.trap.placed) return api.trap;
    for (let i = root.layers.length - 1; i >= 0; i--) {
      const layer = root.layers[i]!;
      const found: { instance: Instance; rect: FocusRect }[] = [];
      collect(layer, 0, 0, found, null, surfaceRect());
      if (found.length > 0) return layer;
    }
    return null;
  };
  const surfaceRect = (): FocusRect => ({ x: 0, y: 0, w: root.width, h: root.height });
  /** The scroll view the focus is in: its out-of-sight controls are reachable. */
  const homeOf = (instance: Instance | null): Instance | null => {
    for (let at = instance?.parent ?? null; at; at = at.parent) if (at.scrollTarget()) return at;
    return null;
  };

  const move = (direction: Direction): boolean => {
    const within = scope();
    if (!within) return false;
    const found: { instance: Instance; rect: FocusRect }[] = [];
    const origin = within.parent ? within.parent.frame() : { x: 0, y: 0 };
    const [ox, oy] = within.parent ? within.parent.contentOffset() : [0, 0];
    collect(within, origin.x + ox, origin.y + oy, found, focused && contains(within, focused) ? homeOf(focused) : null, surfaceRect());
    if (found.length === 0) return false;
    const rects = found.map((entry) => entry.rect);
    const current = focused && contains(within, focused) ? found.find((entry) => entry.instance === focused) : undefined;
    if (!current || !visible) {
      // focus appears where it was, or on the control marked autoFocus, or at the top-left
      const auto = current ?? found.find((entry) => entry.instance.props.autoFocus);
      setFocus((auto ?? found[firstFocus(rects)]!).instance, true);
      return true;
    }
    const at = pickFocus(current.rect, direction, rects);
    if (at < 0) return false;
    setFocus(found[at]!.instance, true);
    return true;
  };

  // --- buttons ---------------------------------------------------------------
  let held = 0;
  let heldFor = 0;
  // --- a pointer at rest ------------------------------------------------------
  let hovered: Instance | null = null;
  const hover = (point: { x: number; y: number } | null) => {
    const next = point ? (root.hit(point.x, point.y).find((instance) => instance.interactive) ?? null) : null;
    if (next === hovered) return;
    hovered?.setHovered(false);
    hovered = next;
    hovered?.setHovered(true);
    // the pointer and the pad do not both point: a pointer that comes to rest on a control puts the pad's focus away
    if (next && visible) setFocus(focused, false);
  };
  // the host's pointer: hover while no button is down; a press is a contact (gesture below)
  let pointing = false;
  const followPointer = () => {
    const now = pointer();
    if (now && now.surface === options.surface && now.buttons === 0) {
      pointing = true;
      hover(now);
    } else if (pointing) {
      pointing = false;
      hover(null);
    }
  };
  // a wheel or a trackpad: the deepest view under the pointer that can still move that way
  onCleanup(
    onScroll((event) => {
      if (event.surface !== options.surface || event.dy === 0) return false;
      for (const instance of root.hit(event.x, event.y)) {
        const target = instance.scrollTarget();
        if (!target || target.max() <= 0) continue;
        const room = event.dy > 0 ? target.max() - target.offset() : target.offset();
        if (room <= 0) continue;
        target.scroller.nudge(event.dy);
        return true;
      }
      return false;
    }),
  );
  let pad = false;
  const press = (button: number, repeat: boolean) => {
    pad = true;
    for (const [mask, direction] of DPAD) {
      if (button & mask) {
        if (move(direction)) return;
        // no control that way: scroll the view the focus is in
        let target: ScrollTarget | null = null;
        for (let p: Instance | null = focused; p && !target; p = p.parent) target = p.scrollTarget();
        if (target && (direction === "up" || direction === "down")) {
          target.scroller.nudge(direction === "down" ? 48 : -48);
          return;
        }
        break;
      }
    }
    if (button & BTN.CIRCLE && !repeat && visible && focused && api.onConfirm?.(focused)) return;
    if (button & BTN.CIRCLE && !repeat && visible && focused?.interactive) {
      const target = focused;
      target.setPressed(true);
      target.tapped(-1, -1);
      pressedByButton = target;
      return;
    }
    for (let i = handlers.length - 1; i >= 0; i--) if (handlers[i]!(button, repeat)) return;
  };
  let pressedByButton: Instance | null = null;

  const frame = (buttons: number) => {
    paintRing();
    followPointer();
    if (!options.buttons) return;
    // while a host keyboard types, it sends the pad as keys (arrows, Enter, Backspace): the buttons are not also commands
    if (text && getOps().textSession) {
      held = buttons;
      return;
    }
    const down = buttons & ~held;
    if (buttons !== 0 && buttons === held) heldFor++;
    else heldFor = 0;
    held = buttons;
    if (pressedByButton && !(buttons & BTN.CIRCLE)) {
      pressedByButton.setPressed(false);
      pressedByButton = null;
    }
    if (down) {
      for (let bit = 1; bit <= 0x8000; bit <<= 1) if (down & bit) press(bit, false);
    } else if (heldFor > REPEAT_AFTER && (heldFor - REPEAT_AFTER) % REPEAT_EVERY === 0) {
      for (const [mask] of DPAD) if (buttons & mask) press(mask, true);
    }
  };

  // --- the pointer -----------------------------------------------------------
  let pressTarget: Instance | null = null;
  let scrollTarget: ScrollTarget | null = null;
  let pan: PanSession | null = null;
  let drag: PointerDrag | null = null;
  /** what the contact that just lifted was pressing, for the tap that follows the up edge */
  let lifted: Instance | null = null;
  const releasePress = () => {
    pressTarget?.setPressed(false);
    pressTarget = null;
  };
  if (options.touch) {
    const handle = createGesture({
      surface: options.surface,
      axis: "any",
      onDown(c: GestureContact) {
        hover(null);
        pad = false;
        if (visible) setFocus(focused, false);
        const path = root.hit(c.x, c.y);
        // a contact that lands on a moving list stops it and is not a press
        let moving = false;
        for (const instance of path) {
          const target = instance.scrollTarget();
          if (target && target.scroller.state() === "fling") {
            target.scroller.stop();
            moving = true;
          }
        }
        lifted = null;
        pressTarget = moving ? null : (path.find((instance) => instance.interactive) ?? null);
        pressTarget?.setPressed(true);
      },
      onTap(c: GestureContact) {
        // the up edge arrives before the tap it completes
        const target = pressTarget ?? lifted;
        lifted = null;
        releasePress();
        if (target) {
          if (target.takesFocus) setFocus(target, false);
          const frame = target.frame();
          target.tapped(c.x - frame.x, c.y - frame.y);
        } else if (text) api.setTextTarget(null);
        // a tap anywhere but the field ends typing
        if (target && text && target !== text.owner) api.setTextTarget(null);
      },
      onLongPress(c: GestureContact) {
        const target = pressTarget;
        if (!target) return;
        const carried = api.onLift?.(target, c.x, c.y) ?? null;
        if (carried) {
          drag = carried;
          releasePress();
          return;
        }
        if (target.props.onLongPress) {
          releasePress();
          target.props.onLongPress();
        }
      },
      onMove(c: GestureContact) {
        drag?.move(c.x, c.y);
      },
      onPanStart(c: GestureContact) {
        if (drag) return;
        releasePress();
        const path = root.hit(c.startX, c.startY);
        const vertical = Math.abs(c.dy) >= Math.abs(c.dx);
        scrollTarget = null;
        // what the contact started on may want the drag itself, whichever way it goes
        const first = path[0];
        if (first) {
          const frame = first.frame();
          pan = first.claimDrag(c.startX - frame.x, c.startY - frame.y);
          if (pan) return;
        }
        if (vertical) {
          for (const instance of path) {
            const target = instance.scrollTarget();
            if (target && target.max() > 0) {
              scrollTarget = target;
              break;
            }
          }
        } else {
          for (const instance of path) {
            pan = instance.claimPan(c.dx, c.dy);
            if (pan) break;
          }
        }
        scrollTarget?.scroller.beginDrag();
      },
      onPanMove(c: GestureContact) {
        if (drag) return drag.move(c.x, c.y);
        if (pan) return pan.move(c.dx, c.dy);
        scrollTarget?.scroller.drag(-c.fdy);
      },
      onPanEnd(c: GestureContact) {
        if (drag) {
          drag.end(c.x, c.y, false);
          drag = null;
          return;
        }
        if (pan) {
          pan.end(c.vx, c.vy, false);
          pan = null;
          return;
        }
        scrollTarget?.scroller.endDrag(-c.vy);
        scrollTarget = null;
      },
      onUp(c: GestureContact) {
        if (drag) {
          drag.end(c.x, c.y, false);
          drag = null;
        }
        lifted = pressTarget;
        releasePress();
      },
      onCancel(c: GestureContact) {
        if (drag) {
          drag.end(c.x, c.y, true);
          drag = null;
        }
        releasePress();
        if (pan) {
          pan.end(0, 0, true);
          pan = null;
        }
        if (scrollTarget) {
          scrollTarget.scroller.endDrag(0);
          scrollTarget = null;
        }
      },
    });
    onCleanup(() => handle.dispose());
  }

  // --- text -----------------------------------------------------------------
  let text: TextTarget | null = null;
  const stopText = onTextEvent((event) => (text ? text.event(event) : false));
  onCleanup(() => {
    stopText();
    if (text) getOps().textSession?.(false);
  });

  let relanding = false;
  root.afterLayout.add(() => {
    if (!relanding) return;
    relanding = false;
    if (visible && focused === null) move("down");
  });
  root.onForget = (instance) => {
    if (text && instance === text.owner) api.setTextTarget(null);
    if (instance === focused) {
      focused = null;
      // what had the focus is gone (a pane replaced, a row removed): the focus lands again once what replaced it is laid out
      relanding = visible;
    }
    if (instance === hovered) hovered = null;
    if (instance === pressTarget) pressTarget = null;
    if (instance === lifted) lifted = null;
    if (instance.scrollTarget() === scrollTarget) scrollTarget = null;
    if (instance === pressedByButton) pressedByButton = null;
    if (instance === api.trap) api.trap = null;
  };

  const api: UIInput = {
    focused: () => focused,
    focus: (instance, show = visible) => setFocus(instance, show),
    focusVisible: () => visible,
    byPad: () => pad,
    hover,
    onButton(handler) {
      handlers.push(handler);
      return () => {
        const at = handlers.lastIndexOf(handler);
        if (at >= 0) handlers.splice(at, 1);
      };
    },
    onLift: null,
    onConfirm: null,
    textTarget: () => text,
    setTextTarget(target) {
      if (target === text) return;
      const previous = text;
      text = target;
      previous?.blur();
      // the host shows its keyboard while a session is open (HostOps.textSession)
      if ((previous === null) !== (target === null)) getOps().textSession?.(target !== null);
    },
    frame,
    move,
    trap: null,
  };
  return api;
}
