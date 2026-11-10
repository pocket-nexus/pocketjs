// Pocket Link 2 requests and events (docs/POCKET-LINK.md §5.1 to §5.5): id
// allocation, the four steps by which a receiver reads an EVENT, and the
// requester's and responder's tables with the 30 s stall and the 10 s cancel
// grace on an injected clock. No sockets: each call returns what to send.

import {
  LINK2_CANCEL_GRACE_MS,
  LINK2_ID_DEVICE_MAX,
  LINK2_ID_HUB_BIT,
  LINK2_REQUEST_STALL_MS,
} from "../../../contracts/spec/link2.ts";
import { LinkCloseError, idRange } from "./protocol.ts";

export type Side = "device" | "hub";

/** One counter per side for request ids, ids of streams an event opens and,
 *  on the device, channel ids (§5.1). Never reuses an id on a connection. */
export class IdAllocator {
  private next = 1;
  constructor(readonly side: Side) {}
  take(): number {
    if (this.next > LINK2_ID_DEVICE_MAX) throw new LinkCloseError("going_away", "ids exhausted");
    const id = this.next++;
    return this.side === "hub" ? (id | LINK2_ID_HUB_BIT) >>> 0 : id;
  }
}

// ---------------------------------------------------------------------------
// §5.3 Reading an EVENT
// ---------------------------------------------------------------------------

/** What a receiver holds, asked by header id. */
export interface Holdings {
  /** An open request an APP frame started, in either direction, with no REPLY yet. */
  channelRequest(id: number): boolean;
  /** An open request this side sent (system or applet) with no REPLY yet. */
  ownRequest(id: number): boolean;
  /** A channel open on the connection. */
  channel(id: number): boolean;
  /** Any id in use on the connection: a request, a stream or a channel. */
  inUse(id: number): boolean;
}

/** How a system event's header id is read (§5.3, step 4). */
export type SystemEventRule = "zero" | "request" | "channel" | "stream" | "screenshot";

export const SYSTEM_EVENTS: Readonly<Record<string, SystemEventRule>> = {
  features: "zero",
  "catalog.changed": "zero",
  "runtime.status": "zero",
  "runtime.apps": "zero",
  log: "zero",
  "devtools.listen": "zero",
  "agent.hello": "zero",
  "agent.turn": "zero",
  "agent.audio.end": "zero",
  "agent.cancel": "zero",
  "agent.reset": "zero",
  "agent.result": "zero",
  "agent.state": "zero",
  "agent.transcript": "zero",
  "agent.request": "zero",
  "agent.delta": "zero",
  "agent.step": "zero",
  "agent.tool": "zero",
  "agent.usage": "zero",
  "agent.done": "zero",
  "agent.error": "zero",
  "runtime.install": "request",
  "runtime.native": "request",
  "install.head": "request",
  "net.head": "request",
  "channel.close": "channel",
  "agent.audio": "stream",
  "agent.shot": "stream",
  "agent.screen": "stream",
  "agent.glyphs": "stream",
  "runtime.screenshot": "screenshot",
};

export type EventReading =
  /** Step 1: progress of an applet channel's request, whatever its `t`. */
  | { read: "app-progress" }
  /** Step 2: an APP event; `opensStream` when its id is a fresh id of the sender. */
  | { read: "app"; opensStream: boolean }
  /** Step 3, or a late frame of step 4: ignored. */
  | { read: "ignore"; why: string }
  /** Step 4: a system event to deliver; `opensStream` for a fresh id. */
  | { read: "system"; t: string; opensStream: boolean }
  /** An unknown `t` on a fresh id of the sender: ignored, with RESET `refused`. */
  | { read: "reset-refused" }
  /** The id breaks the event's rule: CLOSE `protocol`. */
  | { read: "close"; why: string };

/**
 * The four steps of §5.3, the header id first. `receiver` is the side that
 * reads the event; `t` is the object's `t`, or null when the payload is not a
 * JSON object with a string `t`. One test of the id's range decides "late":
 * no mark and no per-id memory.
 */
export function readEvent(receiver: Side, id: number, app: boolean, t: string | null, holds: Holdings): EventReading {
  const sender: Side = receiver === "device" ? "hub" : "device";
  const range = idRange(id);
  if (id !== 0 && range === null) return { read: "close", why: "id 0x80000000" };

  // Step 1: an open request of an applet channel.
  if (id !== 0 && holds.channelRequest(id)) return { read: "app-progress" };

  // Step 2: the APP flag.
  if (app) {
    if (id === 0) return { read: "app", opensStream: false };
    if (range !== sender || holds.inUse(id)) return { read: "close", why: "an APP event's stream id is not a fresh id of the sender" };
    return { read: "app", opensStream: true };
  }

  // Step 3: a non-zero id of the receiver's own range that names nothing held.
  if (id !== 0 && range === receiver && !holds.inUse(id)) return { read: "ignore", why: "late: an id of the receiver's range that names nothing held" };

  // Step 4: a system event; `t` defines what the id means.
  const fresh = id !== 0 && range === sender && !holds.inUse(id);
  const rule = t === null ? undefined : SYSTEM_EVENTS[t];
  if (rule === undefined) return fresh ? { read: "reset-refused" } : { read: "ignore", why: "unknown or unparsable event" };
  const system = (opensStream: boolean): EventReading => ({ read: "system", t: t as string, opensStream });
  switch (rule) {
    case "zero":
      return id === 0 ? system(false) : { read: "close", why: `${t} requires id 0` };
    case "request":
      if (holds.ownRequest(id)) return system(false);
      return { read: "close", why: `${t} names no open request` };
    case "channel":
      if (holds.channel(id)) return system(false);
      // A close that crossed another: the channel is already closed.
      return fresh || id === 0 ? (id === 0 ? { read: "close", why: "channel.close with id 0" } : { read: "ignore", why: "channel already closed" }) : { read: "close", why: "channel.close on an id that is not a channel" };
    case "stream":
      return fresh ? system(true) : { read: "close", why: `${t}: the stream id is 0, outside the sender's range, or in use` };
    case "screenshot":
      if (holds.ownRequest(id)) return system(false);
      return fresh ? system(true) : { read: "close", why: "runtime.screenshot: bad id" };
  }
}

// ---------------------------------------------------------------------------
// §5.2, §5.4, §5.5 The requester's table
// ---------------------------------------------------------------------------

export type RequesterAction =
  | { action: "cancel"; id: number; error: "timeout" }
  | { action: "free"; id: number; error: "timeout" | "cancelled" };

interface OpenRequest {
  lastFrame: number;
  cancelledAt: number | null;
  /** `devtools.open`, `channel.open`: the id stays in use after its REPLY and no timer runs on it. */
  outlives: boolean;
  replied: boolean;
}

/** A side's open requests. **A request ends with one REPLY**: a second one,
 *  or any frame for an id the table no longer holds, is ignored. */
export class Requester {
  private open = new Map<number, OpenRequest>();
  constructor(private readonly now: () => number) {}

  /** A REQUEST frame is queued. */
  sent(id: number, options: { outlives?: boolean } = {}): void {
    this.open.set(id, { lastFrame: this.now(), cancelledAt: null, outlives: options.outlives ?? false, replied: false });
  }
  holds(id: number): boolean {
    return this.open.has(id);
  }
  /** Still waiting for its REPLY. */
  awaiting(id: number): boolean {
    const request = this.open.get(id);
    return request !== undefined && !request.replied;
  }
  /** An EVENT, DATA, or CREDIT for the request's id arrived. Returns
   *  "deliver", or "discard" after CANCEL and for an id not held. */
  frame(id: number): "deliver" | "discard" {
    const request = this.open.get(id);
    if (request === undefined) return "discard";
    request.lastFrame = this.now();
    return request.cancelledAt === null ? "deliver" : "discard";
  }
  /** The REPLY arrived. "reply" the first time; "ignore" for an id not
   *  awaiting one. The id is freed unless it outlives its reply. */
  reply(id: number): "reply" | "ignore" {
    const request = this.open.get(id);
    if (request === undefined || request.replied) return "ignore";
    if (request.outlives) request.replied = true;
    else this.open.delete(id);
    return "reply";
  }
  /** This side sends CANCEL. False when the id is not awaiting a reply. */
  cancel(id: number): boolean {
    const request = this.open.get(id);
    if (request === undefined || request.replied || request.cancelledAt !== null) return false;
    request.cancelledAt = this.now();
    return true;
  }
  /** Ends an id that outlived its reply (the channel closed, `devtools` left use). */
  release(id: number): void {
    this.open.delete(id);
  }
  /** Run on a timer: requests past the 30 s stall are cancelled, and a
   *  cancelled one is freed 10 s after its CANCEL without a reply. */
  tick(): RequesterAction[] {
    const actions: RequesterAction[] = [];
    const now = this.now();
    for (const [id, request] of this.open) {
      if (request.replied) continue;
      if (request.cancelledAt !== null) {
        if (now - request.cancelledAt >= LINK2_CANCEL_GRACE_MS) {
          this.open.delete(id);
          actions.push({ action: "free", id, error: "cancelled" });
        }
      } else if (now - request.lastFrame >= LINK2_REQUEST_STALL_MS) {
        request.cancelledAt = now;
        actions.push({ action: "cancel", id, error: "timeout" });
      }
    }
    return actions;
  }
  /** The connection closed: every open request fails with `closed` on this side. */
  closeAll(): number[] {
    const ids = [...this.open.keys()];
    this.open.clear();
    return ids;
  }
  get size(): number {
    return this.open.size;
  }
}

// ---------------------------------------------------------------------------
// The responder's table
// ---------------------------------------------------------------------------

/** A side's bound on requests open from its peer (§5.2, §9): one over the
 *  bound is answered `busy` at once. The reply is sent once per id. */
export class Responder {
  private open = new Set<number>();
  constructor(readonly bound: number) {}

  /** A REQUEST arrived. "busy" when the bound is reached. */
  arrived(id: number): "accept" | "busy" {
    if (this.open.size >= this.bound) return "busy";
    this.open.add(id);
    return "accept";
  }
  /** The responder is about to queue its REPLY. False when the id is not
   *  open: it was already answered, so no second REPLY goes out. */
  reply(id: number): boolean {
    return this.open.delete(id);
  }
  /** A CANCEL arrived. True when a `cancelled` REPLY is owed; false when the
   *  request already ended and its normal reply stands. For a request of an
   *  applet channel the endpoint next to the responder answers at once, so a
   *  daemon or guest that never answers holds no place (§5.4). */
  cancel(id: number): boolean {
    return this.open.delete(id);
  }
  holds(id: number): boolean {
    return this.open.has(id);
  }
  get size(): number {
    return this.open.size;
  }
}

/** The sender of a stream gives up after 30 s without a CREDIT while it
 *  holds bytes to send (§5.5). The DevTools stream is exempt: its sender
 *  drops the held line and keeps the stream. */
export class StreamSendTimer {
  private since: number | null = null;
  constructor(private readonly now: () => number, private readonly exempt = false) {}
  /** Bytes are waiting for credit, or no longer. */
  waiting(holdsBytes: boolean): void {
    if (!holdsBytes) this.since = null;
    else if (this.since === null) this.since = this.now();
  }
  /** A CREDIT arrived. */
  credited(): void {
    this.since = null;
  }
  /** "give-up": RESET `cancelled` for an event's stream, `timeout` for a
   *  request's. "drop-line" for the DevTools stream, which stays open. */
  check(): "ok" | "give-up" | "drop-line" {
    if (this.since === null || this.now() - this.since < LINK2_REQUEST_STALL_MS) return "ok";
    this.since = null;
    return this.exempt ? "drop-line" : "give-up";
  }
}
