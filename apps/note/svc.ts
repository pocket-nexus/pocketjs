// apps/note/svc.ts — the widget host protocol over the spec svc channel
// (ops 30..32, HostOps svcOpen/svcPoll/svcSend).
//
// The desktop widget host is the app's companion process: it forwards the
// real keyboard, mouse and window into the guest as JSON lines, and the
// guest sends intents (save, quit) back. One poll per frame, per the
// HostOps contract. Hosts without the channel (goldens, programs/sim, PSP)
// feature-detect to null and the app runs standalone on its sample doc —
// an unmodified-app base case, per docs/RUNTIMES.md rule 5.
//
// host → guest lines:
//   {t:"hello", w, h}          logical viewport at boot
//   {t:"resize", w, h}         live window resize (relayout follows)
//   {t:"load", text}           document content from the host's file
//   {t:"ch", s}                typed characters (batched, layout applied)
//   {t:"key", k}               named key: Backspace Delete Enter Tab Left
//                              Right Up Down Home End PageUp PageDown Escape
//                              Copy Cut Undo Redo (⌘-chords arrive as keys)
//   {t:"paste", text}          insert the system clipboard (⌘V — the host
//                              reads it and pushes the text)
//   {t:"ime", s, c}            IME composition: preedit text + caret char
//                              index within it (null clears); commits
//                              arrive as plain {t:"ch"} lines
//   {t:"mouse", x, y, d, sh}   pointer moved / pressed / released — d is
//                              the primary-button state (a line is sent on
//                              every press/release even without movement),
//                              sh the shift modifier (extends selections)
//   {t:"scroll", dy}           wheel delta in logical px
//
// guest → host lines:
//   {t:"save", text}           persist the document (debounced by the app)
//   {t:"quit"}                 close the widget
//   {t:"menu", open}           the ••• menu is up — the host stops claiming
//                              header drags so backdrop clicks can close it
//   {t:"copy", text}           put text on the system clipboard (⌘C)
//   {t:"caret", x, y, h}       caret rect (logical px) — the host docks the
//                              IME candidate window next to it

import { getOps } from "@pocketjs/framework";

export interface HostEvent {
  t: "hello" | "resize" | "load" | "ch" | "key" | "mouse" | "scroll" | "paste" | "ime";
  w?: number;
  h?: number;
  text?: string;
  s?: string;
  k?: string;
  x?: number;
  y?: number;
  /** Primary mouse button held ("mouse" events). */
  d?: boolean;
  /** Shift held (mouse presses and named keys) — extends selections. */
  sh?: boolean;
  dy?: number;
  /** IME preedit caret (char index into s), null when composition ends. */
  c?: number | null;
}

export interface Svc {
  /** Drain and parse this frame's host lines (call once per frame). */
  poll(): HostEvent[];
  send(
    line:
      | { t: "save"; text: string }
      | { t: "quit" }
      | { t: "menu"; open: boolean }
      | { t: "copy"; text: string }
      | { t: "caret"; x: number; y: number; h: number },
  ): void;
}

/** Probe the channel; null = standalone (no widget host on the other end). */
export function connectSvc(): Svc | null {
  const ops = getOps();
  if (!ops.svcOpen || !ops.svcPoll || !ops.svcSend || !ops.svcOpen("note")) return null;
  const poll = ops.svcPoll.bind(ops);
  const send = ops.svcSend.bind(ops);
  return {
    poll() {
      const batch = poll();
      if (!batch) return [];
      const events: HostEvent[] = [];
      for (const line of batch.split("\n")) {
        if (line === "") continue;
        try {
          events.push(JSON.parse(line) as HostEvent);
        } catch {
          // A malformed line is a host bug; skip it rather than wedge.
        }
      }
      return events;
    },
    send(line) {
      send(JSON.stringify(line));
    },
  };
}
