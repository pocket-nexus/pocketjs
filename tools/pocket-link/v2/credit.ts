// Pocket Link 2 credit (docs/POCKET-LINK.md §5.6, §7.2, §7.3): byte credit of
// one stream direction, the window of an applet channel's inbound stream, the
// head step that gates a response's bytes, and the event window counted in
// units. State machines without sockets or timers; the caller sends the
// frames each call asks for.

import {
  LINK2_APP_EVENT_UNIT,
  LINK2_APP_EVENT_WINDOW,
  LINK2_APP_STREAM_WINDOW,
  LINK2_MAX_CREDIT,
} from "../../../contracts/spec/link2.ts";
import { LinkCloseError } from "./protocol.ts";

/** The sender's side of one stream direction: bytes granted and not yet used.
 *  Credit starts at 0. */
export class SendCredit {
  private available = 0;
  /** A CREDIT frame arrived. A grant that raises the outstanding credit over
   *  16 MiB closes the connection with `flow`. */
  grant(bytes: number): void {
    if (this.available + bytes > LINK2_MAX_CREDIT) throw new LinkCloseError("flow", "grant over 16 MiB outstanding");
    this.available += bytes;
  }
  /** Bytes the sender may put in its next DATA frame, at most `want`. */
  take(want: number): number {
    const n = Math.min(want, this.available);
    this.available -= n;
    return n;
  }
  get credit(): number {
    return this.available;
  }
}

/** The receiver's side of one stream direction: what it granted and has not
 *  received. DATA past it closes the connection with `flow`. */
export class ReceiveCredit {
  private outstanding = 0;
  /** Records a grant the receiver is about to send; returns the bytes. */
  grant(bytes: number): number {
    if (this.outstanding + bytes > LINK2_MAX_CREDIT) throw new LinkCloseError("flow", "grant over 16 MiB outstanding");
    this.outstanding += bytes;
    return bytes;
  }
  received(bytes: number): void {
    if (bytes > this.outstanding) throw new LinkCloseError("flow", "DATA past credit");
    this.outstanding -= bytes;
  }
  get granted(): number {
    return this.outstanding;
  }
}

/**
 * One inbound stream of an applet channel at the device (§5.6): **the bytes
 * granted and not yet received plus the bytes held for the guest never exceed
 * 16 KiB**, and credit is granted only against a `read` the guest has
 * pending, for at most what that read asked for. Streams share nothing: each
 * has an instance of its own.
 */
export class AppletStreamWindow {
  private outstanding = 0;
  private held = 0;
  private wanted = 0;
  constructor(private readonly window: number = LINK2_APP_STREAM_WINDOW) {}

  /** The guest called `read(into)` for up to `bytes`; one read is pending at a time. */
  read(bytes: number): void {
    this.wanted = Math.max(0, bytes);
  }
  /** Bytes to grant now with a CREDIT frame; 0 when nothing is due. While a
   *  read is pending the whole window is granted, not the read's size alone:
   *  the bytes of the next reads are in flight while the guest takes this
   *  one's. A stream nobody reads is granted nothing. */
  grant(): number {
    if (this.wanted <= 0) return 0;
    const due = this.window - this.outstanding - this.held;
    if (due <= 0) return 0;
    this.outstanding += due;
    return due;
  }
  /** A DATA frame's bytes arrived. */
  received(bytes: number): void {
    if (bytes > this.outstanding) throw new LinkCloseError("flow", "DATA past credit");
    this.outstanding -= bytes;
    this.held += bytes;
  }
  /** Hands the pending read its bytes, at most `budget` (the per-frame share
   *  of §7.3). A read that received bytes is complete; the next `read` opens
   *  the window again. */
  take(budget: number = Number.POSITIVE_INFINITY): number {
    const n = Math.min(this.held, this.wanted, budget);
    if (n <= 0) return 0;
    this.held -= n;
    this.wanted = 0;
    return n;
  }
  /** Granted and not received, plus held: at most the window. */
  get occupied(): number {
    return this.outstanding + this.held;
  }
  get heldBytes(): number {
    return this.held;
  }
  get pendingRead(): number {
    return this.wanted;
  }
}

/** Shares the per-frame stream bytes among the streams with a pending read
 *  in turn (§7.3): the stream served first changes each frame. Returns the
 *  bytes each stream handed its guest read. */
export function shareFrameBytes(streams: readonly AppletStreamWindow[], frame: number, budget: number): number[] {
  const taken = streams.map(() => 0);
  let left = budget;
  for (let step = 0; step < streams.length && left > 0; step++) {
    const index = (frame + step) % streams.length;
    const n = streams[index].take(left);
    taken[index] = n;
    left -= n;
  }
  return taken;
}

/**
 * The head step of an applet request's response (§7.2), at the endpoint next
 * to the responder: bytes written before a progress event are refused before
 * they reach the wire, and the requester's endpoint hands the response stream
 * over at the first progress event, never at the REPLY.
 */
export class ResponseGate {
  private head = false;
  private replied = false;
  /** The responder sent a progress event on the request id. */
  progress(): void {
    if (this.replied) throw new Error("progress after the reply");
    this.head = true;
  }
  /** May the responder's bytes go to the wire? */
  get mayWrite(): boolean {
    return this.head && !this.replied;
  }
  write(): void {
    if (!this.mayWrite) throw new Error(this.replied ? "bytes after the reply" : "bytes before a progress event");
  }
  reply(): void {
    this.replied = true;
  }
}

/** Units an applet event costs: one per started 512 bytes of its JSON object. */
export const eventUnits = (jsonBytes: number) => Math.max(1, Math.ceil(jsonBytes / LINK2_APP_EVENT_UNIT));

/** The sender's side of a channel's event window: units granted and unspent.
 *  A sender with too few units keeps the event on its own side ("full"). */
export class EventSender {
  private units = 0;
  /** A CREDIT frame on the channel id arrived. */
  grant(units: number): void {
    this.units += units;
  }
  /** Spends the event's units and returns true, or returns false: full. */
  send(jsonBytes: number): boolean {
    const cost = eventUnits(jsonBytes);
    if (cost > this.units) return false;
    this.units -= cost;
    return true;
  }
  get available(): number {
    return this.units;
  }
}

/**
 * The receiver's side of a channel's event window. It grants `window` units
 * after the `channel.open` REPLY and **regrants an event's units when the
 * event leaves its queue for any reason**: taken, discarded or refused. An
 * event past the granted units is `overflow`: the receiver closes the channel
 * (not the link).
 */
export class EventReceiver {
  private outstanding = 0;
  private owed = 0;
  constructor(readonly window: number = LINK2_APP_EVENT_WINDOW) {}

  /** The first grant, queued after the REPLY of `channel.open`. */
  open(): number {
    this.outstanding = this.window;
    return this.window;
  }
  /** An event of the channel arrived. Returns its cost in units, or
   *  "overflow" when the sender had no units for it. */
  arrived(jsonBytes: number): number | "overflow" {
    const cost = eventUnits(jsonBytes);
    if (cost > this.outstanding) return "overflow";
    this.outstanding -= cost;
    return cost;
  }
  /** The event left the queue: the guest or daemon took it, or the endpoint
   *  discarded or refused it. Its units are owed back. */
  left(cost: number): void {
    this.owed += cost;
  }
  /** One CREDIT per turn of the loop: the units to regrant now, 0 for none. */
  regrant(): number {
    const units = this.owed;
    this.owed = 0;
    this.outstanding += units;
    return units;
  }
  /** Units the sender may still spend, as this side counts them. */
  get granted(): number {
    return this.outstanding;
  }
}
