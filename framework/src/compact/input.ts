// Compact navigation input: one vocabulary of keys for every screen of a
// keyboard-driven panel, and the same vocabulary from a d-pad when the
// target has no keyboard.
//
// A keyboard sends text events (framework text-input.ts). The kit reads them
// in two passes. Raw key handlers come first: a text field registered with
// `useKey` takes the characters and editing keys it wants and returns true.
// What is left is read as navigation (`useNav`): the arrows, and the keys
// F, X, Z and C as up, down, left and right (the CardputerZero's arrows sit
// on its Fn layer; its launcher reads these four the same way); Enter is ok;
// Escape and Backspace are back; Escape held a second is home; `/` is
// search; Space is pause; Tab is action. Shift held with a direction asks
// for a fine step. A held direction repeats after REPEAT_DELAY_S at
// REPEAT_RATE_HZ.
//
// Handlers are scoped: the kit's app frame names the scope that receives
// input (the top scene, or the open dialog), so a scene under another never
// hears a key.

import { BTN } from "../../../contracts/spec/spec.ts";
import { simulationHz } from "../clock.ts";
import { onFrame } from "../frame.ts";
import { hasTextInput, onTextEvent, type TextEvent } from "../text-input.ts";
import { HOME_HOLD_S, REPEAT_DELAY_S, REPEAT_RATE_HZ } from "./tokens.ts";

export type NavKey = "up" | "down" | "left" | "right" | "ok" | "back" | "home" | "search" | "pause" | "action";

export interface NavEvent {
  key: NavKey;
  /** Shift held: a fine step for an adjustment. */
  fine: boolean;
  /** A held key repeating. */
  repeat: boolean;
}

export type NavHandler = (event: NavEvent) => boolean | void;
export type KeyHandler = (event: TextEvent) => boolean | void;
export type Scope = number | string;

interface Registration<H> {
  scope: Scope;
  handler: H;
}

const navHandlers: Registration<NavHandler>[] = [];
const keyHandlers: Registration<KeyHandler>[] = [];
let activeScope: Scope = 0;
let installed = false;

/** Frames a direction key has been held, by key name. */
const held = new Map<string, number>();
let shiftHeld = false;
let escapeHeldFrames = -1;
let escapeWentHome = false;
/** A raw key handler took the Escape press (a field closing): its release
 *  is not back. */
let escapeTaken = false;
let previousButtons = 0;

const DIRECTION_OF: Record<string, NavKey> = {
  ArrowUp: "up", ArrowDown: "down", ArrowLeft: "left", ArrowRight: "right",
  f: "up", F: "up", x: "down", X: "down", z: "left", Z: "left", c: "right", C: "right",
};

/** The navigation meaning of a key name, or null for a key that has none. */
export function navKeyOf(name: string): NavKey | null {
  const bare = name.startsWith("Shift+") ? name.slice(6) : name;
  if (DIRECTION_OF[bare]) return DIRECTION_OF[bare]!;
  switch (bare) {
    case "Enter":
      return "ok";
    case "Backspace":
      return "back";
    case "Home":
      return "home";
    case "/":
      return "search";
    case " ":
      return "pause";
    case "Tab":
      return "action";
    default:
      return null;
  }
}

/** The scope whose handlers receive input (the app frame sets it). */
export function setActiveScope(scope: Scope): void {
  activeScope = scope;
}

export function activeInputScope(): Scope {
  return activeScope;
}

function dispatchNav(event: NavEvent): boolean {
  for (let i = navHandlers.length - 1; i >= 0; i--) {
    const entry = navHandlers[i]!;
    if (entry.scope !== activeScope && entry.scope !== GLOBAL_SCOPE) continue;
    if (entry.handler(event) === true) return true;
  }
  return false;
}

function dispatchKey(event: TextEvent): boolean {
  for (let i = keyHandlers.length - 1; i >= 0; i--) {
    const entry = keyHandlers[i]!;
    if (entry.scope !== activeScope && entry.scope !== GLOBAL_SCOPE) continue;
    if (entry.handler(event) === true) return true;
  }
  return false;
}

/** Handlers in this scope hear input whatever scope is active: the app
 *  frame's own keys. */
export const GLOBAL_SCOPE: Scope = "global";

function keyDown(name: string, repeat: boolean): void {
  if (name === "Shift") {
    shiftHeld = true;
    return;
  }
  if (name === "Escape") {
    if (!repeat && escapeHeldFrames < 0) {
      escapeHeldFrames = 0;
      escapeWentHome = false;
    }
    return;
  }
  const nav = navKeyOf(name);
  if (!nav) return;
  const fine = shiftHeld || name.startsWith("Shift+");
  if (isDirection(nav) && !repeat) held.set(name, 0);
  // The kernel's own repeat is ignored: the kit repeats held directions at
  // its own cadence, and other keys act once per press.
  if (repeat) return;
  dispatchNav({ key: nav, fine, repeat: false });
}

function keyUp(name: string): void {
  if (name === "Shift") {
    shiftHeld = false;
    return;
  }
  if (name === "Escape") {
    const wentHome = escapeWentHome;
    escapeHeldFrames = -1;
    escapeWentHome = false;
    if (!wentHome) dispatchNav({ key: "back", fine: false, repeat: false });
    return;
  }
  held.delete(name);
}

function isDirection(key: NavKey): boolean {
  return key === "up" || key === "down" || key === "left" || key === "right";
}

function onText(event: TextEvent): boolean | void {
  if (dispatchKey(event)) {
    if (event.kind === "key" && event.key === "Escape" && event.pressed && !event.repeat) escapeTaken = true;
    return true;
  }
  if (event.kind !== "key") return;
  if (event.key === "Escape" && escapeTaken) {
    if (!event.pressed) escapeTaken = false;
    return true;
  }
  if (event.pressed) keyDown(event.key, event.repeat);
  else keyUp(event.key);
  return true;
}

function frame(buttons: number): void {
  const hz = simulationHz();
  const delay = Math.max(1, Math.round(REPEAT_DELAY_S * hz));
  const every = Math.max(1, Math.round(hz / REPEAT_RATE_HZ));
  for (const [name, frames] of held) {
    const next = frames + 1;
    held.set(name, next);
    if (next === delay || (next > delay && (next - delay) % every === 0)) {
      const nav = navKeyOf(name);
      if (nav) dispatchNav({ key: nav, fine: shiftHeld || name.startsWith("Shift+"), repeat: true });
    }
  }
  if (escapeHeldFrames >= 0) {
    escapeHeldFrames++;
    if (!escapeWentHome && escapeHeldFrames >= Math.round(HOME_HOLD_S * hz)) {
      escapeWentHome = true;
      dispatchNav({ key: "home", fine: false, repeat: false });
    }
  }
  if (!hasTextInput) buttonFrame(buttons, delay, every);
}

const BUTTON_NAV: [number, NavKey][] = [
  [BTN.UP, "up"],
  [BTN.DOWN, "down"],
  [BTN.LEFT, "left"],
  [BTN.RIGHT, "right"],
  [BTN.CIRCLE, "ok"],
  [BTN.START, "ok"],
  [BTN.CROSS, "back"],
  [BTN.TRIANGLE, "action"],
  [BTN.SQUARE, "search"],
  [BTN.SELECT, "home"],
];

/** Without a keyboard, the d-pad and face buttons speak the vocabulary. */
function buttonFrame(buttons: number, delay: number, every: number): void {
  const down = buttons & ~previousButtons;
  previousButtons = buttons;
  const fine = (buttons & (BTN.LTRIGGER | BTN.RTRIGGER)) !== 0;
  for (const [mask, nav] of BUTTON_NAV) {
    const name = `btn:${mask}`;
    if (down & mask) {
      if (isDirection(nav)) held.set(name, 0);
      dispatchNav({ key: nav, fine, repeat: false });
    } else if (buttons & mask && isDirection(nav)) {
      const frames = (held.get(name) ?? 0) + 1;
      held.set(name, frames);
      if (frames === delay || (frames > delay && (frames - delay) % every === 0)) dispatchNav({ key: nav, fine, repeat: true });
    } else if (!(buttons & mask)) {
      held.delete(name);
    }
  }
}

/** Install the kit's listeners once. The app frame calls it; a test may too. */
export function installCompactInput(): void {
  if (installed) return;
  installed = true;
  if (hasTextInput) onTextEvent(onText);
  onFrame(frame);
}

/** Tests: forget every handler and held key. */
export function __resetCompactInput(): void {
  navHandlers.length = 0;
  keyHandlers.length = 0;
  held.clear();
  shiftHeld = false;
  escapeHeldFrames = -1;
  escapeWentHome = false;
  escapeTaken = false;
  previousButtons = 0;
  activeScope = 0;
}

/** Tests and hosts without text events: feed one key event. */
export function __feedKey(event: TextEvent): void {
  onText(event);
}

/** Tests: run one frame of repeats and holds. */
export function __feedFrame(buttons = 0): void {
  frame(buttons);
}

/** Hear navigation in `scope` until the returned function runs. A handler
 *  that returns true consumes the event. */
export function onNavIn(scope: Scope, handler: NavHandler): () => void {
  const entry = { scope, handler };
  navHandlers.push(entry);
  return () => {
    const at = navHandlers.lastIndexOf(entry);
    if (at >= 0) navHandlers.splice(at, 1);
  };
}

/** Hear raw key events in `scope`, before navigation reads them. */
export function onKeyIn(scope: Scope, handler: KeyHandler): () => void {
  const entry = { scope, handler };
  keyHandlers.push(entry);
  return () => {
    const at = keyHandlers.lastIndexOf(entry);
    if (at >= 0) keyHandlers.splice(at, 1);
  };
}

/** The keys a hint names, as the panel spells them. */
export const KEY_LABEL = {
  arrows: hasTextInput ? "FXZC" : "Pad",
  updown: hasTextInput ? "F/X" : "Up/Down",
  leftright: hasTextInput ? "Z/C" : "Left/Right",
  ok: hasTextInput ? "Enter" : "O",
  back: hasTextInput ? "Esc" : "X",
  search: hasTextInput ? "/" : "Square",
  pause: hasTextInput ? "Space" : "Start",
  action: hasTextInput ? "Tab" : "Triangle",
  fine: hasTextInput ? "Shift" : "L/R",
} as const;
