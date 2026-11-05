// Hardware text input (capability input.text): the frame's text events, as
// the host's keyboard driver reported them.
//
// A host with a keyboard appends text events to each input frame
// (contracts/spec/input.ts TEXT_EVENT_KINDS); the guest receives them as the
// ninth frame argument and this module latches them for the frame.
// Handlers registered with onTextEvent() run at the start of the frame,
// newest first, before button handlers; a handler that returns true keeps
// the event from the handlers registered before it. The system keyboard's
// session (osk-controller.ts) registers one while it is open, so a text
// field typed on by a real keyboard fills the same way it does on screen.
//
// A key event names an editing key as KeyboardEvent.key does: Enter,
// Backspace, Delete, Escape, Tab, ArrowLeft, ArrowRight, ArrowUp, ArrowDown,
// Home, End; a held modifier comes first, as in Control+z or Alt+ArrowLeft.

import { TEXT_EVENT_KINDS } from "../../contracts/spec/input.ts";
import { hasFeature } from "./platform.ts";

export type TextEvent =
  | { kind: "key"; key: string; pressed: boolean; repeat: boolean }
  | { kind: "commit"; text: string }
  | { kind: "composition"; text: string; selectionStart: number; selectionEnd: number }
  | { kind: "compositionEnd" };

/** One event as a guest binding hands it over: the wire kind and fields. */
export interface TextEventRecord {
  kind: number;
  text?: string;
  selectionStart?: number;
  selectionEnd?: number;
  repeat?: boolean;
}

export type TextEventHandler = (event: TextEvent) => boolean | void;

/** True when the build's target declares input.text: a keyboard sends text
 *  events, so a text field needs no on-screen keyboard to be typed on. */
export const hasTextInput: boolean = hasFeature("input.text");

const handlers: TextEventHandler[] = [];
let pending: readonly TextEvent[] = [];

/** Convert a guest-side record to the app-facing event; null for a kind this
 *  build does not know. */
export function decodeTextEvent(record: TextEventRecord): TextEvent | null {
  switch (record.kind) {
    case TEXT_EVENT_KINDS.KEY_DOWN:
    case TEXT_EVENT_KINDS.KEY_UP:
      return { kind: "key", key: record.text ?? "", pressed: record.kind === TEXT_EVENT_KINDS.KEY_DOWN, repeat: record.repeat === true };
    case TEXT_EVENT_KINDS.COMMIT:
      return { kind: "commit", text: record.text ?? "" };
    case TEXT_EVENT_KINDS.COMPOSITION:
      return { kind: "composition", text: record.text ?? "", selectionStart: record.selectionStart ?? 0, selectionEnd: record.selectionEnd ?? 0 };
    case TEXT_EVENT_KINDS.COMPOSITION_END:
      return { kind: "compositionEnd" };
    default:
      return null;
  }
}

/** Latch the frame's events (the ninth frame argument). */
export function __setTextEvents(records: readonly TextEventRecord[] | undefined): void {
  if (!records || records.length === 0) {
    pending = [];
    return;
  }
  const events: TextEvent[] = [];
  for (const record of records) {
    const event = decodeTextEvent(record);
    if (event) events.push(event);
  }
  pending = events;
}

/** Run the frame's events through the handlers, newest first. */
export function __dispatchTextEvents(): void {
  if (pending.length === 0) return;
  const events = pending;
  pending = [];
  for (const event of events) {
    for (let i = handlers.length - 1; i >= 0; i--) {
      if (handlers[i]!(event) === true) break;
    }
  }
}

export function __resetTextInput(): void {
  handlers.length = 0;
  pending = [];
}

/** Receive the frame's text events until the returned function runs. A
 *  handler that returns true consumes the event. */
export function onTextEvent(handler: TextEventHandler): () => void {
  handlers.push(handler);
  return () => {
    const at = handlers.lastIndexOf(handler);
    if (at >= 0) handlers.splice(at, 1);
  };
}
