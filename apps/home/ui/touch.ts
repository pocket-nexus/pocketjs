// apps/home/ui/touch.ts — one stylus recognizer per screen, hit-tested
// against the targets the visible page lays out.
//
// Pages place their rows and buttons by arithmetic (a row is an offset, not
// a wrapper View), so the same numbers that position a row also name its hit
// rectangle: the router asks the current page for its targets on the down
// edge and on the tap, never per frame. A page that scrolls hands over its
// scroller and the vertical band it occupies; a page that pages sideways
// (the springboard) hands over a horizontal pan.
//
// Every painted target answers the stylus. The pressed id is set PRESS_DELAY
// frames after the down edge, unless the contact has started a pan by then,
// and held for PRESS_LINGER frames after the release; a tap shorter than the
// delay sets it at the release. A scroll that starts on a row never lights
// it (UITableView's delayed highlight), which on an Old 3DS also saves the
// two restyles of a row that lit and unlit within a few frames.

import { createSignal, type Accessor } from "solid-js";
import { createGesture } from "@pocketjs/framework/gesture";
import { onFrame } from "@pocketjs/framework/lifecycle";
import type { Scroller } from "@pocketjs/framework/kinetics";

export const PRESS_LINGER = 5;
export const PRESS_DELAY = 5;

export interface Target {
  id: string;
  x: number;
  y: number;
  w: number;
  h: number;
  /** Fired by a tap that went down and up on this target. */
  run?: () => void;
  /** Fired by a stationary hold. */
  hold?: () => void;
}

export interface TouchPage {
  /** Hit targets in surface coordinates; later entries win overlaps. */
  targets(): readonly Target[];
  /** A vertically scrolling band: [top, bottom) in surface px. */
  scroll?: { scroller: Scroller; top: number; bottom: number };
  /** A sideways pan (springboard pages). */
  panX?: { start(): void; move(dx: number): void; end(dx: number, vx: number): void };
  /** A tap that landed on no target. */
  background?: () => void;
}

export interface Press {
  /** The pressed target id, or "" when nothing is pressed. */
  id: Accessor<string>;
  is(id: string): boolean;
  down(id: string): void;
  /** Keep the highlight PRESS_LINGER more frames, then clear it. */
  release(): void;
  clear(): void;
}

export function createPress(): Press {
  const [id, setId] = createSignal("");
  let linger = 0;
  onFrame(() => {
    if (linger > 0 && --linger === 0) setId("");
  });
  return {
    id,
    is: (target) => id() === target,
    down(target) {
      linger = 0;
      setId(target);
    },
    release() {
      if (id() !== "") linger = PRESS_LINGER;
    },
    clear() {
      linger = 0;
      setId("");
    },
  };
}

function hitAt(page: TouchPage, x: number, y: number): Target | null {
  const targets = page.targets();
  for (let index = targets.length - 1; index >= 0; index--) {
    const target = targets[index]!;
    if (x >= target.x && x < target.x + target.w && y >= target.y && y < target.y + target.h) return target;
  }
  return null;
}

export interface TouchRouterOptions {
  surface: "primary" | "auxiliary";
  page: () => TouchPage | null;
  press: Press;
  /** False while a transition owns the screen. */
  active?: () => boolean;
  /** Any contact on the surface (the input-mode switch to touch). */
  onTouch?: () => void;
}

export function createTouchRouter(options: TouchRouterOptions): void {
  let downTarget: Target | null = null;
  let mode: "" | "x" | "y" = "";
  let scrolled: Scroller | null = null;
  let highlightIn = 0;
  const active = () => options.active?.() ?? true;
  const finish = () => {
    downTarget = null;
    mode = "";
    scrolled = null;
    highlightIn = 0;
  };
  onFrame(() => {
    if (highlightIn > 0 && --highlightIn === 0 && downTarget) options.press.down(downTarget.id);
  });

  createGesture({
    surface: options.surface,
    onDown(contact) {
      options.onTouch?.();
      finish();
      if (!active()) return;
      const page = options.page();
      if (!page) return;
      if (page.scroll && contact.y >= page.scroll.top && contact.y < page.scroll.bottom) page.scroll.scroller.stop();
      downTarget = hitAt(page, contact.x, contact.y);
      if (downTarget) highlightIn = PRESS_DELAY;
    },
    onPanStart(contact) {
      options.press.clear();
      downTarget = null;
      highlightIn = 0;
      if (!active()) return;
      const page = options.page();
      if (!page) return;
      if (page.panX && Math.abs(contact.dx) > Math.abs(contact.dy)) {
        mode = "x";
        page.panX.start();
        page.panX.move(contact.dx);
      } else if (page.scroll && contact.startY >= page.scroll.top && contact.startY < page.scroll.bottom) {
        mode = "y";
        scrolled = page.scroll.scroller;
        scrolled.beginDrag();
        scrolled.drag(-contact.dy);
      }
    },
    onPanMove(contact) {
      if (mode === "y") scrolled?.drag(-contact.fdy);
      else if (mode === "x") options.page()?.panX?.move(contact.dx);
    },
    onPanEnd(contact) {
      if (mode === "y") scrolled?.endDrag(-contact.vy);
      else if (mode === "x") options.page()?.panX?.end(contact.dx, contact.vx);
      finish();
    },
    onTap(contact) {
      const pressed = downTarget;
      if (pressed && highlightIn > 0) options.press.down(pressed.id);
      options.press.release();
      finish();
      if (!active()) return;
      const page = options.page();
      if (!page) return;
      const hit = hitAt(page, contact.x, contact.y);
      if (pressed && hit && hit.id === pressed.id) pressed.run?.();
      else if (!pressed && !hit) page.background?.();
    },
    onLongPress() {
      const pressed = downTarget;
      options.press.clear();
      downTarget = null;
      if (active() && pressed?.hold) pressed.hold();
    },
    onUp() {
      // A release that was neither a tap nor a pan (a hold) clears here.
      if (mode === "") options.press.release();
    },
    onCancel() {
      options.press.clear();
      if (mode === "y" && scrolled?.state() === "tracking") scrolled.endDrag(0);
      finish();
    },
  });
}
