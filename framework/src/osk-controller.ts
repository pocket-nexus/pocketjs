// The OSK text-editing session, JSX-free (bun test imports this directly;
// the keyboard VIEW in osk.tsx is just one input method driving it — a host
// with a real keyboard could call insert()/backspace() itself).

import { createSignal, type Accessor } from "solid-js";
import { virtualFrame } from "./clock.ts";
import { peekOps } from "./host.ts";
import { onTextEvent, type TextEvent } from "./text-input.ts";

export interface CreateOskOptions {
  /** The app-owned text signal the OSK edits. */
  value: Accessor<string>;
  setValue: (next: string) => void;
  /** ↵ / ✓ / START. Closes afterwards unless closeOnCommit is false. */
  onCommit?: (text: string) => void;
  /** × / ▼ — closed without committing. */
  onClose?: () => void;
  maxLength?: number;
  closeOnCommit?: boolean;
}

export interface OskController {
  open(): void;
  close(): void;
  isOpen: Accessor<boolean>;
  /** Caret index into value(), clamped live against external edits. */
  caret: Accessor<number>;
  /** value() with the caret marker inserted while open. */
  display(marker?: string): string;
  insert(text: string): void;
  backspace(): void;
  moveCaret(delta: number): void;
  commit(): void;
  cancel(): void;
  /** Virtual frame of the last open() — same-frame presses must not type. */
  openedFrame(): number;
}

/** The keyboard opened last and still open: where typed text goes when no
 * finger types it (the agent's `type` tool, contracts/spec/agent.ts). */
let openController: OskController | null = null;

export function openOsk(): OskController | null {
  return openController !== null && openController.isOpen() ? openController : null;
}

export function createOsk(opts: CreateOskOptions): OskController {
  const [isOpen, setOpen] = createSignal(false);
  const [caretRaw, setCaretRaw] = createSignal(0);
  let opened = -1;
  // A real keyboard (input.text) types into the open session the way the
  // on-screen keys do; the subscription lasts while the session is open.
  let releaseKeyboard: (() => void) | null = null;

  const caret = () => Math.min(caretRaw(), opts.value().length);

  const typed = (event: TextEvent): boolean => {
    if (event.kind === "commit") {
      controller.insert(event.text);
      return true;
    }
    if (event.kind !== "key" || !event.pressed) return false;
    switch (event.key) {
      case "Backspace":
        controller.backspace();
        return true;
      case "Delete": {
        const c = caret();
        const v = opts.value();
        if (c < v.length) opts.setValue(v.slice(0, c) + v.slice(c + 1));
        return true;
      }
      case "Enter":
        controller.commit();
        return true;
      case "Escape":
        controller.cancel();
        return true;
      case "ArrowLeft":
        controller.moveCaret(-1);
        return true;
      case "ArrowRight":
        controller.moveCaret(1);
        return true;
      case "Home":
        controller.moveCaret(-opts.value().length);
        return true;
      case "End":
        controller.moveCaret(opts.value().length);
        return true;
      default:
        return false;
    }
  };

  const controller: OskController = {
    open() {
      setCaretRaw(opts.value().length);
      opened = virtualFrame();
      setOpen(true);
      openController = controller;
      releaseKeyboard?.();
      releaseKeyboard = onTextEvent(typed);
      // a host with its keyboard elsewhere shows it now (osk.tsx keyboardElsewhere)
      peekOps()?.textSession?.(true);
    },
    close() {
      setOpen(false);
      if (openController === controller) openController = null;
      releaseKeyboard?.();
      releaseKeyboard = null;
      peekOps()?.textSession?.(false);
    },
    isOpen,
    caret,
    display(marker = "|") {
      const v = opts.value();
      if (!isOpen()) return v;
      const c = caret();
      return v.slice(0, c) + marker + v.slice(c);
    },
    insert(text) {
      const v = opts.value();
      if (opts.maxLength !== undefined && v.length + text.length > opts.maxLength) return;
      const c = caret();
      opts.setValue(v.slice(0, c) + text + v.slice(c));
      setCaretRaw(c + text.length);
    },
    backspace() {
      const c = caret();
      if (c === 0) return;
      const v = opts.value();
      opts.setValue(v.slice(0, c - 1) + v.slice(c));
      setCaretRaw(c - 1);
    },
    moveCaret(delta) {
      setCaretRaw(Math.max(0, Math.min(caret() + delta, opts.value().length)));
    },
    commit() {
      opts.onCommit?.(opts.value());
      if (opts.closeOnCommit !== false) controller.close();
    },
    cancel() {
      opts.onClose?.();
      controller.close();
    },
    openedFrame: () => opened,
  };
  return controller;
}
