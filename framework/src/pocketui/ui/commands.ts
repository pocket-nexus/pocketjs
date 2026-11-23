// PocketUI ui/commands.ts — the application's commands on this surface
// (core/commands.ts holds the rule; this file binds it to the pad, the keys
// and the screen).
//
//   useCommands(() => [...])   declares the commands of the component's scope
//   useBack(() => boolean)     declares what Back does here; the innermost
//                              one that returns true ends the press
//
// The pad: Triangle (X on a letters pad) is `action`, Square (Y) is
// `option`, START is `menu`; Cross (B) is back. Circle (A) presses the
// focused control and the d-pad moves the focus (ui/input.ts), so those two
// never reach a command. A scope whose pane holds the focus is asked before
// its siblings.
import { createContext, createMemo, createSignal, getOwner, onCleanup, useContext, type Accessor } from "solid-js";
import { getOps } from "../../host.ts";
import { BTN, onTextEvent } from "../../input-api.ts";
import { glyph } from "../../modality.ts";
import { bindCommands, legendOf, normalizeChord, type Bound, type ButtonIntent, type Command, type CommandScope } from "../core/commands.ts";
import type { Instance } from "./engine.ts";
import type { UI } from "./mount.ts";

interface Scope extends CommandScope {
  /** the pane the commands belong to: asked first while it holds the focus */
  within?: () => Instance | null | undefined;
}

export interface CommandCenter {
  bound: Accessor<Bound>;
  /** the legend's entries: the button's name on this pad and what it does now */
  legend: Accessor<{ glyph: string; label: string }[]>;
  /** run a command by id; false when it is not offered or is disabled */
  run(id: string): boolean;
  /** Back, as the pad's Cross or a bar's control gives it; false when nothing took it */
  back(): boolean;
  canBack: Accessor<boolean>;
  push(scope: Scope): () => void;
  pushBack(handler: () => boolean, available?: () => boolean): () => void;
  /** what the menu command opens: set by the kit (ui/kit.tsx CommandMenu) */
  openMenu: (() => void) | null;
}

const BUTTONS: Record<ButtonIntent, number> = { action: BTN.TRIANGLE, option: BTN.SQUARE, menu: BTN.START };
const GLYPHS: Record<string, Parameters<typeof glyph>[0]> = { confirm: "circle", back: "cross", action: "triangle", option: "square", menu: "start" };

export function createCommandCenter(ui: UI): CommandCenter {
  const [scopes, setScopes] = createSignal<Scope[]>([]);
  const [backs, setBacks] = createSignal<{ handler: () => boolean; available?: () => boolean }[]>([]);
  const [focusTick, setFocusTick] = createSignal(0);
  let lastFocused: Instance | null = null;
  let lastVisible = false;
  let lastTyping = false;
  /** a host keyboard has the pad: its buttons type keys (arrows, Enter, Backspace) and are not commands */
  const padTypes = () => ui.input.textTarget() !== null && typeof getOps().textSession === "function";
  ui.root.frameHooks.add(() => {
    const focused = ui.input.focused();
    const visible = ui.input.focusVisible();
    const typing = padTypes();
    if (focused !== lastFocused || visible !== lastVisible || typing !== lastTyping) {
      lastFocused = focused;
      lastVisible = visible;
      lastTyping = typing;
      setFocusTick((n) => n + 1);
    }
  });
  const ordered = createMemo(() => {
    focusTick();
    const focused = ui.input.focused();
    const list = scopes();
    if (!focused) return list;
    // the scope whose pane holds the focus is innermost
    const holds = (scope: Scope) => {
      const pane = scope.within?.();
      if (!pane) return false;
      for (let at: Instance | null = focused; at; at = at.parent) if (at === pane) return true;
      return false;
    };
    return [...list.filter((scope) => !holds(scope)), ...list.filter(holds)];
  });
  const bound = createMemo(() => {
    const idioms = ui.idioms();
    return bindCommands(ordered(), { buttons: ui.env().input.buttons, bar: idioms.commands.bar, keys: idioms.commands.shortcuts });
  });
  const canBack = createMemo(() => backs().some((entry) => entry.available?.() ?? true));
  const legend = createMemo(() => {
    focusTick();
    const fixed: { intent: string; label: string }[] = [];
    // a legend names what the buttons do now: while they type, nothing here
    if (padTypes()) return [];
    const focused = ui.input.focused();
    const carried = ui.transfer?.carrying();
    if (carried) {
      // while a thing is carried the two buttons mean its two endings
      fixed.push({ intent: "confirm", label: "Drop" }, { intent: "back", label: "Put Back" });
      return fixed.map((entry) => ({ glyph: glyph(GLYPHS[entry.intent]!), label: entry.label }));
    }
    if (ui.input.focusVisible() && focused?.interactive) fixed.push({ intent: "confirm", label: "Select" });
    if (canBack()) fixed.push({ intent: "back", label: "Back" });
    return legendOf(bound(), fixed).map((entry) => ({ glyph: glyph(GLYPHS[entry.intent]!), label: entry.label }));
  });
  const center: CommandCenter = {
    bound,
    legend,
    run(id) {
      const command = bound().all.find((entry) => entry.id === id);
      if (!command || command.disabled) return false;
      command.run();
      return true;
    },
    back() {
      const list = backs();
      for (let i = list.length - 1; i >= 0; i--) if (list[i]!.handler()) return true;
      return false;
    },
    canBack,
    push(scope) {
      setScopes((list) => [...list, scope]);
      return () => setScopes((list) => list.filter((entry) => entry !== scope));
    },
    pushBack(handler, available) {
      const entry = { handler, available };
      setBacks((list) => [...list, entry]);
      return () => setBacks((list) => list.filter((item) => item !== entry));
    },
    openMenu: null,
  };
  ui.input.onButton((button) => {
    if (button & BTN.CROSS) return center.back();
    for (const intent of ["action", "option", "menu"] as const) {
      if (!(button & BUTTONS[intent])) continue;
      const command = bound().buttons[intent];
      if (command) {
        command.run();
        return true;
      }
      // a pad always has a way to the menu
      if (intent !== "action" && center.openMenu) {
        center.openMenu();
        return true;
      }
    }
    return false;
  });
  const stop = onTextEvent((event) => {
    if (event.kind !== "key" || !event.pressed) return false;
    if (event.key === "Escape") return center.back();
    const command = bound().keys.get(normalizeChord(event.key));
    if (!command) return false;
    command.run();
    return true;
  });
  if (getOwner()) onCleanup(stop);
  return center;
}

const CommandContext = createContext<CommandCenter>();
export const CommandProvider = CommandContext.Provider;

export function useCommandCenter(): CommandCenter {
  const center = useContext(CommandContext);
  if (!center) throw new Error("PocketUI: commands used outside <PocketUI>");
  return center;
}

/** Declare the commands that apply while this component is mounted. */
export function useCommands(commands: () => readonly Command[], options: { id?: string; within?: () => Instance | null | undefined } = {}): void {
  const center = useCommandCenter();
  const memo = createMemo(commands);
  onCleanup(center.push({ id: options.id ?? "scope", commands: memo, within: options.within }));
}

/** Declare what Back does while this component is mounted: return true when it did something. */
export function useBack(handler: () => boolean, available?: () => boolean): void {
  onCleanup(useCommandCenter().pushBack(handler, available));
}
