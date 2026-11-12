// Pocket Link 2: what both ends of a link share after `ready`
// (docs/POCKET-LINK.md §4 to §8). One Peer per connection: the FIFO write
// queue with the one-chunk rule (§8.1), the request tables of both directions,
// the four steps of reading an EVENT (§5.3), byte streams with credit (§5.6),
// keepalive (§4.6), the `features` event (§6.1) and applet channels with the
// guest-shaped API of §7.3. The device side (device.ts) and the Hub side
// (hub.ts) add the handshake and the system messages of §6.
//
// Time comes from an injected `now()`; every timed rule runs in `tick()`,
// which the owner calls on an interval (or a test calls after moving its
// clock).

import {
  LINK2_APP_EVENT_WINDOW,
  LINK2_APP_EVENT_WINDOW_HUB,
  LINK2_APP_FRAME_JSON,
  LINK2_APP_FRAME_MESSAGES,
  LINK2_APP_FRAME_STREAM,
  LINK2_APP_NAME_BYTES,
  LINK2_APP_OUTBOUND,
  LINK2_APP_STREAM_WINDOW,
  LINK2_APP_WAITING_REQUESTS,
  LINK2_CHANNEL_REQUESTS,
  LINK2_CHANNEL_STREAMS,
  LINK2_ERROR_MESSAGE_BYTES,
  LINK2_FEATURES_INTERVAL_MS,
  LINK2_FLAG,
  LINK2_FRAME,
  LINK2_PING_MS,
  LINK2_REQUEST_STALL_MS,
  LINK2_SILENCE_MS,
  LINK2_WINDOW,
  type Link2ChannelCloseReason,
  type Link2CloseName,
  type Link2ResetName,
} from "../../../contracts/spec/link2.ts";
import type { Carrier } from "./carrier.ts";
import { AppletStreamWindow, EventReceiver, EventSender, ReceiveCredit, ResponseGate, SendCredit } from "./credit.ts";
import {
  type Link2Frame,
  Link2FrameDecoder,
  LinkCloseError,
  appMessageLimit,
  encodeCancel,
  encodeClose,
  encodeCredit,
  encodeData,
  encodeJsonFrame,
  encodePing,
  encodePong,
  encodeReset,
  encodedPrefix,
  idRange,
  jsonBytes,
  parseClose,
  parseCredit,
  parseFeatures,
  parseJsonPayload,
  parseReset,
} from "./protocol.ts";
import { IdAllocator, Keepalive, Requester, Responder, type Side, StreamSendTimer, readEvent } from "./requests.ts";

export type Json = Record<string, unknown>;

/** An error reply (§5.2), or what a side reports for a request of its own:
 *  `closed` when the connection or the channel ended under it. */
export class LinkError extends Error {
  constructor(readonly code: string, message: string = code, readonly extra: Json = {}) {
    super(message);
  }
}
const asLinkError = (error: unknown): LinkError =>
  error instanceof LinkError ? error : new LinkError("internal", error instanceof Error ? error.message : String(error));

const APP_NAME = /^[a-z0-9._-]+$/;
const validAppName = (t: unknown): t is string => typeof t === "string" && t.length > 0 && t.length <= LINK2_APP_NAME_BYTES && APP_NAME.test(t);

// ---------------------------------------------------------------------------
// Streams
// ---------------------------------------------------------------------------

/**
 * Stream bytes an applet channel's writers hold toward the wire, under the
 * channel's bound (§7.6: LINK_APP_OUTBOUND at the device), and the writers
 * waiting for room in it. **Room comes back whenever any writer of the
 * channel has a DATA frame written or ends**, so every waiting writer is
 * woken then, not only the one whose frame left. JSON messages do not count
 * here (§7.6).
 */
export class OutboundQueue {
  /** Bytes written to the channel's streams and not yet handed to the carrier. */
  bytes = 0;
  private waiters: (() => void)[] = [];
  constructor(readonly bound: number) {}

  /** Bytes one write may take now: the whole bound while the queue is empty. */
  get room(): number {
    return this.bytes === 0 ? this.bound : Math.max(0, this.bound - this.bytes);
  }
  /** False when `n` bytes would pass the bound and the queue holds some already. */
  fits(n: number): boolean {
    return this.bytes === 0 || this.bytes + n <= this.bound;
  }
  /** @internal */
  add(n: number): void {
    this.bytes += n;
  }
  /** @internal Bytes left the queue: written to the carrier, or dropped with their stream. */
  release(n: number): void {
    this.bytes -= n;
    this.wake();
  }
  /** @internal Wakes every waiting writer; each checks for room again. */
  wake(): void {
    for (const wake of this.waiters.splice(0)) wake();
  }
  /** Resolves at the next release. `first`: ahead of the writers already
   *  waiting, for a writer that was woken and found no room, so writers of one
   *  channel take the room in turn. */
  wait(first = false): Promise<void> {
    return new Promise<void>((resolve) => {
      if (first) this.waiters.unshift(resolve);
      else this.waiters.push(resolve);
    });
  }
}

/** The sending end of one stream direction. Bytes wait here for credit; at
 *  most one DATA frame of the stream sits in the write queue at a time. */
export class StreamWriter {
  private readonly credit = new SendCredit();
  private readonly chunks: Uint8Array[] = [];
  private pendingBytes = 0;
  private ending = false;
  private queued = false;
  private settled = false;
  /** The bound these bytes count against: the channel's, else none. */
  private readonly outbound: OutboundQueue | null;
  private readonly timer: StreamSendTimer;
  private finish!: () => void;
  private abort!: (error: LinkError) => void;
  /** Resolves when the END frame has left; rejects when the stream is reset. */
  readonly finished: Promise<void>;
  /** Bytes of this stream handed to the carrier. */
  sent = 0;
  /** @internal The applet channel the stream belongs to. */
  readonly channel: AppletChannel | null;

  constructor(
    private readonly peer: Peer,
    readonly id: number,
    private readonly options: { exempt?: boolean; onGiveUp?: () => void; onCredit?: () => void; channel?: AppletChannel } = {},
  ) {
    this.channel = options.channel ?? null;
    this.outbound = this.channel?.outbound ?? null;
    this.timer = new StreamSendTimer(peer.now, options.exempt ?? false);
    this.finished = new Promise<void>((resolve, reject) => {
      this.finish = resolve;
      this.abort = reject;
    });
    this.finished.catch(() => {});
  }

  get buffered(): number {
    return this.pendingBytes;
  }
  /** Credit granted and not yet claimed by bytes written to this stream. */
  get creditFree(): number {
    return Math.max(0, this.credit.credit - this.pendingBytes);
  }
  get done(): boolean {
    return this.settled;
  }
  /** False ("full") when the bytes would pass the channel's outbound bound
   *  and it holds bytes already; nothing is taken then. */
  write(bytes: Uint8Array): boolean {
    if (this.settled || this.ending) return false;
    if (bytes.length === 0) return true;
    if (this.outbound !== null && !this.outbound.fits(bytes.length)) return false;
    this.chunks.push(bytes);
    this.pendingBytes += bytes.length;
    this.outbound?.add(bytes.length);
    this.pump();
    return true;
  }
  /** Writes every byte: as much as the channel's queue has room for, then
   *  the rest as room comes back. Throws when the stream ends first. */
  async writeAll(bytes: Uint8Array): Promise<void> {
    let woken = false;
    for (let at = 0; at < bytes.length; ) {
      if (this.settled || this.ending) throw new LinkError("transfer", "the stream ended");
      const room = this.outbound === null ? bytes.length - at : this.outbound.room;
      if (room > 0 && this.write(bytes.subarray(at, Math.min(bytes.length, at + room)))) {
        at = Math.min(bytes.length, at + room);
        woken = false;
        continue;
      }
      // Woken and still no room: the next room goes to this writer before the ones that just wrote.
      await this.outbound!.wait(woken);
      woken = true;
    }
  }
  /** No more bytes: the last DATA frame carries END. */
  end(): void {
    if (this.settled || this.ending) return;
    this.ending = true;
    this.pump();
  }
  /** Abandons the stream with RESET (§5.6). */
  close(code: Link2ResetName = "cancelled"): void {
    if (this.settled) return;
    this.peer.sendReset(this.id, code);
    this.dead(new LinkError("transfer", `reset: ${code}`));
  }

  /** @internal */
  grant(bytes: number): void {
    if (this.settled) return;
    this.credit.grant(bytes);
    this.timer.credited();
    this.pump();
    this.options.onCredit?.();
  }
  /** @internal The stream is over without a frame: reset by the peer, or its owner ended. */
  dead(error: LinkError): void {
    if (this.settled) return;
    this.settled = true;
    const dropped = this.pendingBytes;
    this.chunks.length = 0;
    this.pendingBytes = 0;
    this.peer.forgetWriter(this);
    this.abort(error);
    // Its own writeAll ends, and the bytes it held are room for the channel's other writers.
    this.outbound?.release(dropped);
  }
  /** @internal */
  tick(): void {
    if (this.settled) return;
    this.timer.waiting(this.pendingBytes > 0 && this.credit.credit === 0 && !this.queued);
    const state = this.timer.check();
    if (state === "ok") return;
    if (this.options.onGiveUp) this.options.onGiveUp();
    else this.close("cancelled");
  }

  private pump(): void {
    if (this.queued || this.settled) return;
    const limit = this.peer.limit;
    if (this.pendingBytes === 0) {
      if (!this.ending) return;
      this.queued = true;
      this.peer.enqueue(encodeData(this.id, new Uint8Array(0), true, limit), () => this.complete());
      return;
    }
    const n = this.credit.take(Math.min(this.pendingBytes, limit));
    if (n === 0) return;
    const out = new Uint8Array(n);
    let filled = 0;
    while (filled < n) {
      const head = this.chunks[0];
      const take = Math.min(head.length, n - filled);
      out.set(head.subarray(0, take), filled);
      filled += take;
      if (take === head.length) this.chunks.shift();
      else this.chunks[0] = head.subarray(take);
    }
    this.pendingBytes -= n;
    const last = this.ending && this.pendingBytes === 0;
    this.queued = true;
    this.peer.enqueue(encodeData(this.id, out, last, limit), () => {
      this.sent += n;
      this.outbound?.release(n);
      if (last) this.complete();
      else {
        this.queued = false;
        this.pump();
      }
    });
  }
  private complete(): void {
    if (this.settled) return;
    this.settled = true;
    this.peer.forgetWriter(this);
    this.finish();
  }
}

export interface AutoIntake {
  /** Bytes granted and not yet consumed, at most. */
  window: number;
  /** The declared length of the direction, when the message states one. */
  total?: number;
  /** The consumer. Credit for these bytes returns when it resolves. */
  onData: (bytes: Uint8Array) => void | Promise<void>;
}

/** The receiving end of one stream direction. Two ways to take bytes: an
 *  automatic window that refills as a consumer writes bytes on (the system
 *  streams), or `read()` calls that each open the window (applet streams). */
export class StreamReader {
  private readonly credit = new ReceiveCredit();
  private readonly window: AppletStreamWindow | null;
  private readonly held: Uint8Array[] = [];
  private pending: { max: number; resolve: (bytes: Uint8Array | null) => void; reject: (error: LinkError) => void } | null = null;
  private ended = false;
  private settled = false;
  private failure: LinkError | null = null;
  private unconsumed = 0;
  private started = false;
  private finish!: (bytes: number) => void;
  private abort!: (error: LinkError) => void;
  /** Resolves with the byte count at END (after the consumer took them); rejects on a reset or a wrong length. */
  readonly finished: Promise<number>;
  /** Bytes received so far. */
  received = 0;
  /** @internal The time of the last DATA frame, for the responder's 30 s rule. */
  lastData: number;
  /** @internal The applet channel the stream belongs to. */
  readonly channel: AppletChannel | null;

  constructor(
    private readonly peer: Peer,
    readonly id: number,
    private readonly intake: { auto: AutoIntake } | { read: { window: number; immediate: boolean; channel?: AppletChannel } },
  ) {
    this.window = "read" in intake ? new AppletStreamWindow(intake.read.window) : null;
    this.channel = "read" in intake ? (intake.read.channel ?? null) : null;
    this.lastData = peer.now();
    this.finished = new Promise<number>((resolve, reject) => {
      this.finish = resolve;
      this.abort = reject;
    });
    this.finished.catch(() => {});
  }

  /** Automatic intake: the first grant. A request's response stream starts
   *  with the request or at its head event; `total` may arrive with the head. */
  start(total?: number): void {
    if (!("auto" in this.intake) || this.started) return;
    if (total !== undefined) this.intake.auto.total = total;
    this.started = true;
    this.grantAuto();
  }
  /** Up to `max` bytes; null at END. One read is pending at a time, and it
   *  completes as soon as any bytes are handed over. */
  read(max?: number): Promise<Uint8Array | null> {
    const intake = this.intake;
    if (this.window === null || !("read" in intake)) return Promise.reject(new LinkError("internal", "an automatic stream has no read()"));
    if (this.pending !== null) return Promise.reject(new LinkError("internal", "one read is pending per stream"));
    if (this.failure !== null) return Promise.reject(this.failure);
    if (this.ended && this.held.length === 0) return Promise.resolve(null);
    const size = Math.max(1, Math.min(max ?? intake.read.window, intake.read.window));
    this.readFrame = intake.read.channel?.frameCount ?? 0;
    return new Promise((resolve, reject) => {
      this.pending = { max: size, resolve, reject };
      this.window!.read(size);
      if (intake.read.immediate) this.handOver(Number.POSITIVE_INFINITY);
      if (this.pending === null) return;
      this.grantDue();
      intake.read.channel?.wake();
    });
  }
  /** Abandons the stream: RESET `cancelled`, or `refused` for one never taken. */
  close(code: Link2ResetName = "cancelled"): void {
    if (this.settled) return;
    this.peer.sendReset(this.id, code);
    this.dead(new LinkError("transfer", `reset: ${code}`));
  }
  get wantsBytes(): boolean {
    return this.pending !== null;
  }
  /** @internal The channel's frame count at this reader's last `read`. */
  readFrame = 0;
  get heldBytes(): number {
    return this.window?.heldBytes ?? this.unconsumed;
  }

  /** @internal A DATA frame of this stream. Throws `flow` for bytes past credit. */
  data(bytes: Uint8Array, end: boolean): void {
    if (this.settled || this.ended) return;
    this.lastData = this.peer.now();
    this.received += bytes.length;
    if (this.window !== null) {
      this.window.received(bytes.length);
      if (bytes.length > 0) this.held.push(bytes);
      if (end) this.ended = true;
      if ("read" in this.intake && this.intake.read.immediate) this.handOver(Number.POSITIVE_INFINITY);
      else if ("read" in this.intake) this.intake.read.channel?.wake();
      if (end && this.held.length === 0) this.settleEnd();
      return;
    }
    const auto = (this.intake as { auto: AutoIntake }).auto;
    this.credit.received(bytes.length);
    if (end) this.ended = true;
    if (bytes.length === 0) return this.autoDone();
    this.unconsumed += bytes.length;
    // The consumer sees every chunk at once and in order; a chunk's credit returns when its promise resolves.
    let taken: void | Promise<void>;
    try {
      taken = auto.onData(bytes);
    } catch (error) {
      taken = Promise.reject(error);
    }
    const consumed = () => {
      this.unconsumed -= bytes.length;
      this.autoDone();
    };
    if (taken instanceof Promise) {
      taken.then(consumed, (error) => {
        if (this.settled) return;
        this.peer.sendReset(this.id, "storage");
        this.dead(asLinkError(error));
      });
    } else consumed();
  }
  private autoDone(): void {
    if (this.settled) return;
    if (this.ended) {
      if (this.unconsumed === 0) this.settleEnd();
    } else this.grantAuto();
  }
  /** @internal Hands the pending read its bytes, at most `budget`. Returns the bytes handed. */
  handOver(budget: number): number {
    if (this.window === null || this.pending === null) return 0;
    if (this.held.length === 0) {
      if (this.ended) this.settleEnd();
      return 0;
    }
    const n = this.window.take(Math.min(budget, this.pending.max));
    if (n <= 0) return 0;
    const out = new Uint8Array(n);
    let filled = 0;
    while (filled < n) {
      const head = this.held[0];
      const take = Math.min(head.length, n - filled);
      out.set(head.subarray(0, take), filled);
      filled += take;
      if (take === head.length) this.held.shift();
      else this.held[0] = head.subarray(take);
    }
    const { resolve } = this.pending;
    this.pending = null;
    resolve(out);
    if (this.ended && this.held.length === 0) this.settleEnd();
    return n;
  }
  /** @internal Sends the CREDIT a pending read is due. */
  grantDue(): void {
    if (this.window === null || this.ended || this.settled) return;
    const due = this.window.grant();
    if (due > 0) this.peer.sendCredit(this.id, due);
  }
  /** @internal The stream is over without END: reset, or its owner ended. */
  dead(error: LinkError): void {
    if (this.settled) return;
    this.settled = true;
    this.failure = error;
    this.held.length = 0;
    this.peer.forgetReader(this);
    this.abort(error);
    if (this.pending !== null) {
      const { reject } = this.pending;
      this.pending = null;
      reject(error);
    }
  }

  private settleEnd(): void {
    if (this.settled) return;
    this.settled = true;
    const total = "auto" in this.intake ? this.intake.auto.total : undefined;
    this.peer.forgetReader(this);
    if (total !== undefined && total !== this.received) {
      const error = new LinkError("transfer", `the stream carried ${this.received} bytes of ${total}`);
      this.failure = error;
      this.abort(error);
      return;
    }
    this.finish(this.received);
    if (this.pending !== null) {
      const { resolve } = this.pending;
      this.pending = null;
      resolve(null);
    }
  }
  private grantAuto(): void {
    if (!this.started || this.ended || this.settled) return;
    const auto = (this.intake as { auto: AutoIntake }).auto;
    const outstanding = this.credit.granted;
    let room = auto.window - outstanding - this.unconsumed;
    const left = auto.total === undefined ? Number.POSITIVE_INFINITY : auto.total - this.received - outstanding;
    room = Math.min(room, left);
    if (room <= 0) return;
    // One grant per half window, so a long stream costs a CREDIT per few frames.
    if (outstanding > 0 && room < auto.window / 2 && room < left) return;
    this.peer.sendCredit(this.id, this.credit.grant(room));
  }
}

// ---------------------------------------------------------------------------
// Calls
// ---------------------------------------------------------------------------

/** A request this side sent. */
export interface Call {
  readonly id: number;
  /** The reply's value, or a LinkError. */
  readonly reply: Promise<Json>;
  /** Sends CANCEL; the reply promise settles at the REPLY or 10 s later. */
  cancel(): void;
  /** The request's body stream, when it was asked for. */
  readonly body: StreamWriter | null;
  /** The response stream of a system request that declared one. */
  readonly response: StreamReader | null;
}

interface OutCall {
  id: number;
  t: string;
  feature: string | null;
  channel: AppletChannel | null;
  resolve: (value: Json) => void;
  reject: (error: LinkError) => void;
  onProgress: ((t: string, args: Json, stream?: StreamReader) => void) | null;
  onReply: ((value: Json) => void) | null;
  body: StreamWriter | null;
  response: StreamReader | null;
  outlives: boolean;
  settled: boolean;
}

/** A request the peer sent, as its handler sees it. */
export class IncomingCall {
  /** @internal */ replied = false;
  /** @internal */ readonly gate = new ResponseGate();
  /** @internal */ out: StreamWriter | null = null;
  /** @internal */ bodyReader: StreamReader | null = null;
  /** @internal */ feature: string | null = null;
  /** @internal */ bound: Responder | null = null;
  /** @internal */ jsonBytes = 0;
  private cancels: (() => void)[] = [];
  /** True once the requester sent CANCEL; the endpoint has answered `cancelled`. */
  cancelled = false;

  constructor(
    private readonly peer: Peer,
    readonly id: number,
    readonly t: string,
    readonly args: Json,
    /** @internal */ readonly channel: AppletChannel | null,
    /** @internal */ readonly hasBody: boolean,
  ) {}

  onCancel(listener: () => void): void {
    this.cancels.push(listener);
  }
  /** A progress event on the request id. For an applet's request it costs
   *  event units; false means the window is full and nothing was sent. */
  progress(object: Json): boolean {
    if (this.replied || this.cancelled) return false;
    if (this.channel !== null) {
      if (!this.channel.spendUnits(object)) return false;
    }
    this.gate.progress();
    this.peer.enqueue(encodeJsonFrame(LINK2_FRAME.event, this.id, object, { limit: this.peer.limit }));
    return true;
  }
  /** The stream for response bytes. **A progress event comes first** (the
   *  head step, §7.2): without one this throws, before a byte reaches the wire. */
  respond(): StreamWriter {
    if (this.out !== null) return this.out;
    this.gate.write();
    this.out = this.peer.newWriter(this.id, {
      channel: this.channel ?? undefined,
      onGiveUp: () => this.fail(new LinkError("timeout", "no credit for the response in 30 s")),
    });
    return this.out;
  }
  /** A system request's body: bytes to `onData` under `window`, resolved at END. */
  readBody(intake: AutoIntake): Promise<number> {
    this.bodyReader = this.peer.newReader(this.id, { auto: intake });
    this.bodyReader.start();
    return this.bodyReader.finished;
  }
  /** An applet request's body stream, when the request carried BODY. */
  get body(): StreamReader | null {
    return this.bodyReader;
  }

  /** @internal */
  async reply(value: Json): Promise<void> {
    if (this.replied || this.cancelled) return;
    if (this.out !== null && !this.out.done) {
      this.out.end();
      try {
        await this.out.finished;
      } catch {
        // A reset stream: the request still ends with its REPLY (§5.6).
      }
    }
    if (this.replied || this.cancelled) return;
    this.finish();
    this.peer.enqueue(encodeJsonFrame(LINK2_FRAME.reply, this.id, value, { limit: this.peer.limit }));
  }
  /** @internal */
  fail(error: unknown): void {
    if (this.replied || this.cancelled) return;
    const e = asLinkError(error);
    this.finish();
    this.out?.dead(e);
    this.bodyReader?.dead(e);
    this.peer.replyError(this.id, e);
  }
  /** @internal The requester's CANCEL, or the call's channel or group ended. */
  end(send: LinkError | null): void {
    if (this.replied || this.cancelled) return;
    this.cancelled = true;
    this.finish();
    const e = send ?? new LinkError("closed");
    this.out?.dead(e);
    this.bodyReader?.dead(e);
    if (send !== null) this.peer.replyError(this.id, send);
    for (const listener of this.cancels) listener();
  }
  private finish(): void {
    this.replied = true;
    this.gate.reply();
    this.bound?.reply(this.id);
    this.peer.forgetIncoming(this);
  }
}

export type Handler = (call: IncomingCall) => Json | void | Promise<Json | void>;
export type SystemEventHandler = (object: Json, open: ((intake: AutoIntake) => StreamReader) | null, id: number) => void;

// ---------------------------------------------------------------------------
// Applet channels
// ---------------------------------------------------------------------------

export interface ChannelConfig {
  /** Event units this side grants its peer (§5.6). */
  eventWindow: number;
  /** The window of each inbound stream. */
  streamWindow: number;
  /** Per frame toward the applet or daemon: messages, JSON bytes, stream bytes. */
  frameMessages: number;
  frameJson: number;
  frameStream: number;
  /** Stream bytes queued from the applet or daemon toward the wire, all streams of the channel together. */
  outbound: number;
  /** Hand messages over as they arrive; false leaves it to `frame()` calls. */
  auto: boolean;
}
/** The device's host toward its guest (§7.3, §7.6). */
export const DEVICE_CHANNEL: ChannelConfig = {
  eventWindow: LINK2_APP_EVENT_WINDOW,
  streamWindow: LINK2_APP_STREAM_WINDOW,
  frameMessages: LINK2_APP_FRAME_MESSAGES,
  frameJson: LINK2_APP_FRAME_JSON,
  frameStream: LINK2_APP_FRAME_STREAM,
  outbound: LINK2_APP_OUTBOUND,
  auto: true,
};
/** Hub toward a daemon: the same rules with Hub's windows and no frame budget. */
export const HUB_CHANNEL: ChannelConfig = {
  eventWindow: LINK2_APP_EVENT_WINDOW_HUB,
  streamWindow: LINK2_WINDOW.hub,
  frameMessages: Number.POSITIVE_INFINITY,
  frameJson: Number.POSITIVE_INFINITY,
  frameStream: Number.POSITIVE_INFINITY,
  outbound: LINK2_WINDOW.hub,
  auto: true,
};

export interface AppletCall {
  readonly t: string;
  readonly args: Json;
  readonly cancelled: boolean;
  onCancel(listener: () => void): void;
  /** False when the event window is full: try again in a later frame. */
  progress(t: string, args?: Json): boolean;
  /** The stream for response bytes; throws before a progress event (§7.2). */
  respond(): StreamWriter;
  /** The request's body, when it carried one. */
  readonly body: StreamReader | null;
}
export type AppletHandler = (args: Json, call: AppletCall) => Json | void | Promise<Json | void>;
export type AppletEventHandler = (args: Json, stream?: StreamReader) => void;

type InboxEntry =
  | { kind: "event"; t: string; args: Json; bytes: number; cost: number; stream: number }
  | { kind: "progress"; call: OutCall; t: string; args: Json; bytes: number; cost: number }
  | { kind: "reply"; call: OutCall; outcome: Json | LinkError; bytes: number }
  | { kind: "request"; call: IncomingCall; bytes: number };

/**
 * One applet channel at one end (§7): the guest's side on a device, the
 * daemon's side in Hub. The API is the shape of §7.3: `request`, `on`,
 * `emit`, `onEvent`, stream handles and `state()`.
 */
export class AppletChannel {
  private status: "open" | "closed" = "open";
  private reason: string | null = null;
  private readonly sender = new EventSender();
  private readonly receiver: EventReceiver;
  private readonly responder = new Responder(LINK2_CHANNEL_REQUESTS);
  private readonly handlers = new Map<string, AppletHandler>();
  private readonly eventHandlers = new Map<string, AppletEventHandler>();
  private readonly inbox: InboxEntry[] = [];
  private readonly readers = new Set<StreamReader>();
  private readonly reserved = new Set<number>();
  private readonly refusedResponses = new Set<number>();
  /** Replies handed over whose response stream still holds bytes for a pending read. */
  private readonly trailers: { call: OutCall; outcome: Json | LinkError }[] = [];
  private readonly closeListeners: ((reason: string) => void)[] = [];
  private waitingRequests = 0;
  private frames = 0;
  private scheduled = false;
  /** @internal Stream bytes queued toward the wire, shared by the channel's writers. */
  readonly outbound: OutboundQueue;
  /** Counters a test or a status page reads. */
  readonly stats = { eventsIn: 0, eventsOut: 0, unitsRegranted: 0 };

  constructor(
    /** @internal */ readonly peer: Peer,
    readonly id: number,
    readonly app: string,
    readonly hash: string,
    readonly generation: number,
    readonly config: ChannelConfig,
  ) {
    this.receiver = new EventReceiver(config.eventWindow);
    this.outbound = new OutboundQueue(config.outbound);
  }

  /** `open` or `closed`, with the close reason. A channel object exists from its accepting REPLY. */
  state(): { state: "open" | "closed"; reason: string | null } {
    return { state: this.status, reason: this.reason };
  }
  onClose(listener: (reason: string) => void): void {
    this.closeListeners.push(listener);
  }
  /** Units the peer granted this side and it has not spent. */
  get units(): number {
    return this.sender.available;
  }
  /** Messages waiting for the applet or daemon. */
  get waiting(): number {
    return this.inbox.length;
  }

  // --- the applet's or daemon's calls -------------------------------------

  request(t: string, args: Json = {}, options: { body?: boolean; onProgress?: (t: string, args: Json, stream?: StreamReader) => void } = {}): Call {
    const refuse = (error: LinkError): Call => {
      const reply = Promise.reject(error);
      reply.catch(() => {});
      return { id: 0, reply, cancel() {}, body: null, response: null };
    };
    if (this.status !== "open") return refuse(new LinkError("no_channel"));
    if (!validAppName(t)) return refuse(new LinkError("malformed", "an operation name is 1 to 64 bytes of [a-z0-9._-]"));
    const object = { t, ...args };
    if (jsonBytes(object) > appMessageLimit(this.peer.limit)) return refuse(new LinkError("too_large"));
    return this.peer.request(object, { channel: this, body: options.body, onProgress: options.onProgress });
  }
  on(t: string, handler: AppletHandler): void {
    this.handlers.set(t, handler);
  }
  /** False when the channel is not open, the object is over LINK_APP_MSG, or
   *  the event window is full. */
  emit(t: string, args: Json = {}): boolean {
    return this.send(t, args, 0);
  }
  /** An event that opens a stream toward the peer; null where `emit` gives false. */
  emitStream(t: string, args: Json = {}): StreamWriter | null {
    const id = this.peer.ids.take();
    if (!this.send(t, args, id)) return null;
    return this.peer.newWriter(id, { channel: this });
  }
  onEvent(t: string, handler: AppletEventHandler): void {
    this.eventHandlers.set(t, handler);
  }
  /** Ends the channel from this side (§7.5). */
  close(reason: Link2ChannelCloseReason): void {
    if (this.status !== "open") return;
    this.peer.enqueue(encodeJsonFrame(LINK2_FRAME.event, this.id, { t: "channel.close", reason }, { limit: this.peer.limit }));
    this.ended(reason);
  }

  /**
   * One frame of the applet's loop: hands over at most 4 messages or 8 KiB
   * of JSON (a first message whatever its size) and at most 16 KiB of stream
   * bytes, shared in turn among the streams with a pending read, then sends
   * the credit that became due. Returns what was handed over.
   */
  frame(): { messages: number; bytes: number } {
    if (this.status !== "open") return { messages: 0, bytes: 0 };
    let messages = 0;
    let json = 0;
    while (this.inbox.length > 0 && messages < this.config.frameMessages) {
      const entry = this.inbox[0];
      if (messages > 0 && json + entry.bytes > this.config.frameJson) break;
      this.inbox.shift();
      messages += 1;
      json += entry.bytes;
      this.deliver(entry);
      if (this.status !== "open") return { messages, bytes: 0 };
    }
    const waiting = [...this.readers].filter((reader) => reader.wantsBytes && reader.heldBytes > 0);
    let left = this.config.frameStream;
    let bytes = 0;
    for (let step = 0; step < waiting.length && left > 0; step++) {
      const n = waiting[(this.frames + step) % waiting.length].handOver(left);
      left -= n;
      bytes += n;
    }
    for (const reader of this.readers) if (reader.wantsBytes && reader.heldBytes === 0) reader.handOver(0);
    // A REPLY is the trailer: it reaches the applet after the response's bytes while the applet
    // reads them. The window is granted whole, so bytes can wait here between two reads: a stream
    // read in this frame or the one before keeps the REPLY behind what it still holds; one the
    // applet stopped reading does not.
    for (const trailer of this.trailers.splice(0)) {
      const reader = trailer.call.response;
      if (reader !== null && reader.heldBytes > 0 && this.frames - reader.readFrame <= 1) this.trailers.push(trailer);
      else this.peer.settleReply(trailer.call, trailer.outcome);
    }
    this.frames += 1;
    this.settle();
    return { messages, bytes };
  }

  // --- the peer's frames ---------------------------------------------------

  /** @internal Frames this channel has run. */
  get frameCount(): number {
    return this.frames;
  }
  /** @internal Schedules a hand-over when the channel runs its own frames. */
  wake(): void {
    if (!this.config.auto || this.scheduled || this.status !== "open") return;
    this.scheduled = true;
    setImmediate(() => {
      this.scheduled = false;
      if (this.status !== "open") return;
      const handed = this.frame();
      if (handed.messages > 0 || handed.bytes > 0 || this.inbox.length > 0 || this.trailers.length > 0) this.wake();
    });
  }
  /** @internal The first grant of event units, after the REPLY of `channel.open`. */
  grantUnits(): void {
    this.peer.sendCredit(this.id, this.receiver.open());
  }
  /** @internal A CREDIT frame on the channel id. */
  unitsGranted(units: number): void {
    this.sender.grant(units);
  }
  /** @internal Spends the units of an event this side sends; false when full. */
  spendUnits(object: Json): boolean {
    if (this.status !== "open") return false;
    return this.sender.send(jsonBytes(object));
  }
  /** @internal An event of the channel arrived: an APP event, or progress on one of its requests. */
  eventArrived(bytes: number): number | null {
    const cost = this.receiver.arrived(bytes);
    if (cost === "overflow") {
      this.close("overflow");
      return null;
    }
    this.stats.eventsIn += 1;
    return cost;
  }
  /** @internal An event left this side's queue: taken, discarded or refused. */
  unitsLeft(cost: number): void {
    this.receiver.left(cost);
    this.wake();
  }
  /** @internal */
  appEvent(t: string, args: Json, bytes: number, stream: number): void {
    const cost = this.eventArrived(bytes);
    if (cost === null) return;
    if (stream !== 0) {
      if (this.streamsIn() >= LINK2_CHANNEL_STREAMS) {
        this.peer.sendReset(stream, "refused");
        stream = 0;
      } else this.reserved.add(stream);
    }
    this.inbox.push({ kind: "event", t, args, bytes, cost, stream });
    this.wake();
  }
  /** @internal */
  progressArrived(call: OutCall, t: string, args: Json, bytes: number, discard: boolean): void {
    const cost = this.eventArrived(bytes);
    if (cost === null) return;
    if (discard || call.settled) {
      // A request already cancelled: the event is discarded and its units return (§5.6).
      this.unitsLeft(cost);
      return;
    }
    this.inbox.push({ kind: "progress", call, t, args, bytes, cost });
    this.wake();
  }
  /** @internal The REPLY of one of this side's requests: handed over in order, after its progress events. */
  replyArrived(call: OutCall, outcome: Json | LinkError, bytes: number): void {
    this.inbox.push({ kind: "reply", call, outcome, bytes });
    this.wake();
  }
  /** @internal A REQUEST with APP for this channel. */
  requestArrived(call: IncomingCall, bytes: number): void {
    if (this.responder.arrived(call.id) === "busy") return this.peer.replyError(call.id, new LinkError("busy", "8 requests are open on the channel"));
    if (this.waitingRequests > 0 && this.waitingRequests + bytes > LINK2_APP_WAITING_REQUESTS) {
      this.responder.reply(call.id);
      return this.peer.replyError(call.id, new LinkError("busy", "8 KiB of requests wait for the applet"));
    }
    call.bound = this.responder;
    call.jsonBytes = bytes;
    this.peer.registerIncoming(call);
    if (call.hasBody) {
      if (this.streamsIn() >= LINK2_CHANNEL_STREAMS) this.peer.sendReset(call.id, "refused");
      else this.reserved.add(call.id);
    }
    this.waitingRequests += bytes;
    this.inbox.push({ kind: "request", call, bytes });
    this.wake();
  }
  /** @internal The requester cancelled a request not yet handed over. */
  requestWithdrawn(call: IncomingCall): void {
    const index = this.inbox.findIndex((entry) => entry.kind === "request" && entry.call === call);
    if (index < 0) return;
    this.waitingRequests -= this.inbox[index].bytes;
    this.inbox.splice(index, 1);
    this.reserved.delete(call.id);
  }
  /** @internal */
  holdsStream(id: number): boolean {
    return this.reserved.has(id);
  }
  /** @internal `channel.close` arrived, the connection ended, or this side closed. */
  ended(reason: string): void {
    if (this.status !== "open") return;
    this.status = "closed";
    this.reason = reason;
    for (const entry of this.inbox.splice(0)) if (entry.kind === "event" || entry.kind === "progress") this.receiver.left(entry.cost);
    this.trailers.length = 0;
    this.reserved.clear();
    this.readers.clear();
    this.peer.channelEnded(this);
    for (const listener of this.closeListeners) listener(reason);
  }
  /** @internal */
  forgetReader(reader: StreamReader): void {
    this.readers.delete(reader);
  }

  private streamsIn(): number {
    return this.readers.size + this.reserved.size;
  }
  private reader(id: number): StreamReader {
    this.reserved.delete(id);
    const reader = this.peer.newReader(id, { read: { window: this.config.streamWindow, immediate: this.config.frameStream === Number.POSITIVE_INFINITY, channel: this } });
    this.readers.add(reader);
    return reader;
  }
  private send(t: string, args: Json, id: number): boolean {
    if (this.status !== "open" || !validAppName(t)) return false;
    const object = { t, ...args };
    const bytes = jsonBytes(object);
    if (bytes > appMessageLimit(this.peer.limit)) return false;
    if (!this.sender.send(bytes)) return false;
    this.stats.eventsOut += 1;
    // A JSON message goes to the write queue at once; the outbound bound counts stream bytes alone (§7.6).
    this.peer.enqueue(encodeJsonFrame(LINK2_FRAME.event, id, object, { channel: this.id, limit: this.peer.limit }));
    return true;
  }
  private settle(): void {
    if (this.status !== "open") return;
    const units = this.receiver.regrant();
    if (units > 0) {
      this.stats.unitsRegranted += units;
      this.peer.sendCredit(this.id, units);
    }
    for (const reader of this.readers) reader.grantDue();
  }
  private deliver(entry: InboxEntry): void {
    if (entry.kind === "event") {
      const handler = this.eventHandlers.get(entry.t);
      this.receiver.left(entry.cost);
      if (entry.stream !== 0) {
        // A stream the applet has no handler for is reset (§7.2).
        if (handler === undefined || handler.length < 2) {
          this.reserved.delete(entry.stream);
          this.peer.sendReset(entry.stream, "refused");
          handler?.(entry.args);
          return;
        }
        handler(entry.args, this.reader(entry.stream));
        return;
      }
      handler?.(entry.args);
      return;
    }
    if (entry.kind === "progress") {
      this.receiver.left(entry.cost);
      const call = entry.call;
      if (call.settled) return;
      if (call.response === null && !this.refusedResponses.has(call.id)) {
        // The head step: the response stream is handed over at the first progress event.
        if (this.streamsIn() >= LINK2_CHANNEL_STREAMS) {
          this.peer.sendReset(call.id, "refused");
          this.refusedResponses.add(call.id);
        } else call.response = this.reader(call.id);
      }
      call.onProgress?.(entry.t, entry.args, call.response ?? undefined);
      return;
    }
    if (entry.kind === "reply") {
      this.trailers.push({ call: entry.call, outcome: entry.outcome });
      return;
    }
    const call = entry.call;
    this.waitingRequests -= entry.bytes;
    if (call.cancelled || call.replied) return;
    const handler = this.handlers.get(call.t);
    if (handler === undefined) {
      this.reserved.delete(call.id);
      return call.fail(new LinkError("unknown_message", `no handler for ${call.t}`));
    }
    if (call.hasBody && this.reserved.has(call.id)) call.bodyReader = this.reader(call.id);
    const { t: _t, ...args } = call.args;
    const api: AppletCall = {
      t: call.t,
      args,
      get cancelled() {
        return call.cancelled;
      },
      onCancel: (listener) => call.onCancel(listener),
      progress: (name, more = {}) => (validAppName(name) ? call.progress({ t: name, ...more }) : false),
      respond: () => call.respond(),
      body: call.bodyReader,
    };
    Promise.resolve()
      .then(() => handler(args, api))
      .then(
        (value) => call.reply(value ?? {}),
        (error) => call.fail(error),
      );
  }
}

// ---------------------------------------------------------------------------
// Peer
// ---------------------------------------------------------------------------

export interface PeerOptions {
  side: Side;
  carrier: Carrier;
  /** The decoder that read the handshake, already put in `ready(limit)`. */
  decoder: Link2FrameDecoder;
  /** The payload limit of the connection (§4.4). */
  limit: number;
  now: () => number;
  /** This side's and the peer's feature lists at `ready`. */
  features: string[];
  peerFeatures: string[];
  onClose?: (info: CloseInfo) => void;
  /** The peer's list changed: `before` and `after` as in-use sets. */
  onFeatures?: (cameIntoUse: string[], leftUse: string[]) => void;
}
export interface CloseInfo {
  /** Who ended it: this side with a CLOSE, the peer with a CLOSE, or the carrier. */
  by: "local" | "peer" | "carrier";
  code: Link2CloseName | null;
  reason: string;
}

export class Peer {
  readonly side: Side;
  readonly limit: number;
  readonly now: () => number;
  readonly ids: IdAllocator;
  readonly carrier: Carrier;
  /** Counters a test or a status page reads. */
  readonly stats = { framesIn: 0, framesOut: 0, bytesOut: 0, rttMs: 0, lateEvents: 0, queueMax: 0 };

  private readonly decoder: Link2FrameDecoder;
  private readonly queue: { bytes: Uint8Array; written?: () => void }[] = [];
  private writing = false;
  private closing = false;
  private closeInfo: CloseInfo | null = null;
  private readonly options: PeerOptions;

  private readonly requester: Requester;
  private readonly outCalls = new Map<number, OutCall>();
  private readonly inCalls = new Map<number, IncomingCall>();
  private readonly handlers = new Map<string, { fn: Handler; feature: string | null; bound: Responder | null }>();
  private readonly events = new Map<string, { fn: SystemEventHandler; feature: string | null }>();
  private readonly readers = new Map<number, StreamReader>();
  private readonly writers = new Map<number, StreamWriter>();
  private readonly streamFeature = new Map<number, string>();
  private readonly channels = new Map<number, AppletChannel>();
  /** Credit that arrived for a request's stream before this side opened its writer. */
  private readonly earlyCredit = new Map<number, number>();
  /** Request ids whose empty body ended before this side opened its reader. */
  private readonly earlyEnd = new Set<number>();
  /** A RESET that came for a stream this side has not taken yet (see earlyEnd). */
  private readonly earlyReset = new Map<number, LinkError>();
  private readonly keepalive: Keepalive;
  private pings = new Map<number, number>();
  private pingCounter = 0;

  private local: string[];
  private remote: string[];
  private wanted: string[] | null = null;
  private featuresSentAt = Number.NEGATIVE_INFINITY;

  constructor(options: PeerOptions) {
    this.options = options;
    this.side = options.side;
    this.limit = options.limit;
    this.now = options.now;
    this.carrier = options.carrier;
    this.decoder = options.decoder;
    this.ids = new IdAllocator(options.side);
    this.requester = new Requester(options.now);
    this.keepalive = new Keepalive(options.now, options.side === "device" ? LINK2_PING_MS : Number.POSITIVE_INFINITY, LINK2_SILENCE_MS);
    this.local = [...options.features];
    this.remote = [...options.peerFeatures];
    this.carrier.onData = (bytes) => this.feed(bytes);
    this.carrier.onClose = () => this.ended({ by: "carrier", code: null, reason: "the connection ended" });
  }

  get open(): boolean {
    return this.closeInfo === null && !this.closing;
  }
  /**
   * §2.4: a newer connection of the same device reached `ready`. This
   * connection's requests, streams and channels end as at a connection loss,
   * frames that still arrive are discarded, and only the socket stays open,
   * for the PONG that tells a live console from a half-open connection.
   */
  retire(): void {
    if (this.retired || this.closeInfo !== null) return;
    this.retired = true;
    this.teardown(new LinkError("closed", "replaced by a newer connection"));
  }
  private retired = false;
  get closed(): CloseInfo | null {
    return this.closeInfo;
  }

  // --- writing (§8.1) ------------------------------------------------------

  /** Queues one frame. Frames leave in the order they were queued. */
  enqueue(bytes: Uint8Array, written?: () => void): void {
    if (this.closeInfo !== null || this.closing) return;
    this.queue.push({ bytes, written });
    if (this.queue.length > this.stats.queueMax) this.stats.queueMax = this.queue.length;
    this.pump();
  }
  private pump(): void {
    if (this.writing || this.closeInfo !== null) return;
    const item = this.queue.shift();
    if (item === undefined) return;
    this.writing = true;
    this.stats.framesOut += 1;
    this.stats.bytesOut += item.bytes.length;
    this.carrier.write(item.bytes, () => {
      this.writing = false;
      item.written?.();
      this.pump();
    });
  }
  sendCredit(id: number, amount: number): void {
    if (amount > 0) this.enqueue(encodeCredit(id, amount));
  }
  sendReset(id: number, code: Link2ResetName): void {
    this.enqueue(encodeReset(id, code));
  }
  /** @internal */
  replyError(id: number, error: LinkError): void {
    const object = { code: error.code, message: encodedPrefix(error.message, LINK2_ERROR_MESSAGE_BYTES), ...error.extra };
    this.enqueue(encodeJsonFrame(LINK2_FRAME.reply, id, object, { error: true, limit: this.limit }));
  }

  /** Ends the link with CLOSE (§4.8). */
  close(code: Link2CloseName, reason = ""): void {
    if (this.closeInfo !== null || this.closing) return;
    this.queue.push({ bytes: encodeClose(code, reason) });
    this.closing = true;
    const info: CloseInfo = { by: "local", code, reason };
    const finish = () => {
      this.carrier.close();
      this.ended(info);
    };
    const flush = () => {
      if (this.writing) return void setImmediate(flush);
      const item = this.queue.shift();
      if (item === undefined) return finish();
      this.writing = true;
      this.carrier.write(item.bytes, () => {
        this.writing = false;
        flush();
      });
    };
    flush();
    // The carrier may be gone already: do not wait on its write callback.
    setTimeout(finish, 1000).unref?.();
  }

  // --- requests ------------------------------------------------------------

  /** Registers the handler of a system request `t`. `feature` names its
   *  group (§6.1); `bound` is the responder's bound it counts against (§9). */
  handle(t: string, fn: Handler, options: { feature?: string; bound?: Responder } = {}): void {
    this.handlers.set(t, { fn, feature: options.feature ?? null, bound: options.bound ?? null });
  }
  /** Registers the handler of a system event `t`. For an event that opens a
   *  stream, `open` takes the stream; leaving it uncalled resets it `refused`. */
  onEvent(t: string, fn: SystemEventHandler, options: { feature?: string } = {}): void {
    this.events.set(t, { fn, feature: options.feature ?? null });
  }

  /** Sends a request. `object` carries `t` and the fields. */
  request(
    object: Json & { t: string },
    options: {
      feature?: string;
      channel?: AppletChannel;
      body?: boolean;
      response?: AutoIntake;
      /** Grant the response window in the same write as the request (§6.5). */
      grantNow?: boolean;
      onProgress?: (t: string, args: Json, stream?: StreamReader) => void;
      /** Runs in the turn that reads an accepting REPLY, before the frame behind it is read:
       *  what the REPLY opens (a channel) exists when its first CREDIT arrives. */
      onReply?: (value: Json) => void;
      outlives?: boolean;
    } = {},
  ): Call {
    const id = this.ids.take();
    let resolve!: (value: Json) => void;
    let reject!: (error: LinkError) => void;
    const reply = new Promise<Json>((ok, no) => {
      resolve = ok;
      reject = no;
    });
    reply.catch(() => {});
    const call: OutCall = {
      id,
      t: object.t,
      feature: options.feature ?? null,
      channel: options.channel ?? null,
      resolve,
      reject,
      onProgress: options.onProgress ?? null,
      onReply: options.onReply ?? null,
      body: null,
      response: null,
      outlives: options.outlives ?? false,
      settled: false,
    };
    this.outCalls.set(id, call);
    this.requester.sent(id, { outlives: call.outlives });
    this.enqueue(encodeJsonFrame(LINK2_FRAME.request, id, object, { channel: call.channel?.id, body: call.channel !== null && options.body === true, limit: this.limit }));
    if (options.body) {
      call.body = this.newWriter(id, {
        channel: call.channel ?? undefined,
        onGiveUp: () => this.stall(call),
      });
    }
    if (options.response) {
      call.response = this.newReader(id, { auto: options.response });
      if (options.grantNow) call.response.start();
    }
    return {
      id,
      reply,
      cancel: () => {
        if (this.requester.cancel(id)) this.enqueue(encodeCancel(id));
      },
      body: call.body,
      get response() {
        return call.response;
      },
    };
  }
  private stall(call: OutCall): void {
    if (this.requester.cancel(call.id)) this.enqueue(encodeCancel(call.id));
    this.settleCall(call, new LinkError("timeout", "30 s without a frame for the request"), false);
  }
  private settleCall(call: OutCall, outcome: Json | LinkError, free: boolean): void {
    if (!call.settled) {
      call.settled = true;
      if (outcome instanceof LinkError) call.reject(outcome);
      else {
        call.onReply?.(outcome);
        call.resolve(outcome);
      }
    }
    if (!free) return;
    const error = outcome instanceof LinkError ? outcome : new LinkError("closed");
    if (!call.outlives || outcome instanceof LinkError) {
      this.outCalls.delete(call.id);
      this.earlyEnd.delete(call.id);
      this.earlyReset.delete(call.id);
      call.body?.dead(error);
      if (outcome instanceof LinkError) call.response?.dead(error);
    }
  }
  /** Ends an id that outlived its REPLY (`devtools.open`, `channel.open`). */
  release(id: number): void {
    this.requester.release(id);
    const call = this.outCalls.get(id);
    this.outCalls.delete(id);
    const error = new LinkError("closed");
    this.readers.get(id)?.dead(error);
    this.writers.get(id)?.dead(error);
    call?.body?.dead(error);
  }

  /** Sends a system event. `id` is 0, an open request's id, or a fresh id
   *  when the event opens a stream. */
  event(object: Json & { t: string }, id = 0): void {
    this.enqueue(encodeJsonFrame(LINK2_FRAME.event, id, object, { limit: this.limit }));
  }
  /** Sends a system event that opens a stream toward the peer. */
  eventStream(object: Json & { t: string }, options: { feature?: string; id?: number } = {}): StreamWriter {
    const id = options.id ?? this.ids.take();
    this.event(object, id);
    if (options.feature) this.streamFeature.set(id, options.feature);
    return this.newWriter(id);
  }

  // --- streams -------------------------------------------------------------

  newWriter(id: number, options: ConstructorParameters<typeof StreamWriter>[2] = {}): StreamWriter {
    const writer = new StreamWriter(this, id, options);
    this.writers.set(id, writer);
    const early = this.earlyCredit.get(id);
    if (early !== undefined) {
      this.earlyCredit.delete(id);
      writer.grant(early);
    }
    return writer;
  }
  newReader(id: number, intake: ConstructorParameters<typeof StreamReader>[2], feature?: string): StreamReader {
    const reader = new StreamReader(this, id, intake);
    this.readers.set(id, reader);
    if (feature) this.streamFeature.set(id, feature);
    const reset = this.earlyReset.get(id);
    this.earlyReset.delete(id);
    if (reset !== undefined) queueMicrotask(() => reader.dead(reset));
    else if (this.earlyEnd.delete(id)) queueMicrotask(() => reader.data(new Uint8Array(0), true));
    return reader;
  }
  /** @internal */
  forgetWriter(writer: StreamWriter): void {
    if (this.writers.get(writer.id) === writer) this.writers.delete(writer.id);
  }
  /** @internal */
  forgetReader(reader: StreamReader): void {
    if (this.readers.get(reader.id) === reader) this.readers.delete(reader.id);
    for (const channel of this.channels.values()) channel.forgetReader(reader);
  }
  /** @internal */
  registerIncoming(call: IncomingCall): void {
    this.inCalls.set(call.id, call);
  }
  /** @internal */
  forgetIncoming(call: IncomingCall): void {
    if (this.inCalls.get(call.id) === call) this.inCalls.delete(call.id);
    this.earlyCredit.delete(call.id);
    this.earlyEnd.delete(call.id);
    this.earlyReset.delete(call.id);
  }

  // --- channels ------------------------------------------------------------

  /** A channel that the REPLY of `channel.open` opened, at this end. */
  addChannel(id: number, app: string, hash: string, generation: number, config: ChannelConfig): AppletChannel {
    const channel = new AppletChannel(this, id, app, hash, generation, config);
    this.channels.set(id, channel);
    return channel;
  }
  channel(id: number): AppletChannel | undefined {
    return this.channels.get(id);
  }
  get channelCount(): number {
    return this.channels.size;
  }
  /** @internal The channel closed: its requests fail with `closed` on this side, its streams drop, no frame is sent for them. */
  channelEnded(channel: AppletChannel): void {
    this.channels.delete(channel.id);
    const error = new LinkError("closed", `the channel closed: ${channel.state().reason}`);
    for (const call of [...this.outCalls.values()]) {
      if (call.channel !== channel) continue;
      this.requester.release(call.id);
      this.settleCall(call, error, true);
      this.readers.get(call.id)?.dead(error);
      this.writers.get(call.id)?.dead(error);
    }
    for (const call of [...this.inCalls.values()]) if (call.channel === channel) call.end(null);
    for (const writer of [...this.writers.values()]) if (writer.channel === channel) writer.dead(error);
    for (const reader of [...this.readers.values()]) if (reader.channel === channel) reader.dead(error);
    // The `channel.open` request id outlived its REPLY as the channel id.
    this.requester.release(channel.id);
    this.outCalls.delete(channel.id);
    this.inCalls.delete(channel.id);
  }

  // --- features (§6.1) -----------------------------------------------------

  get features(): string[] {
    return this.local;
  }
  get peerFeatures(): string[] {
    return this.remote;
  }
  inUse(feature: string): boolean {
    return this.local.includes(feature) && this.remote.includes(feature);
  }
  /** This side's list changes. At most one `features` event a second: a
   *  change inside the second goes out at its end, with the list as it stands. */
  setFeatures(list: string[]): void {
    this.wanted = [...list];
    this.flushFeatures();
  }
  private flushFeatures(): void {
    if (this.wanted === null || this.now() - this.featuresSentAt < LINK2_FEATURES_INTERVAL_MS) return;
    const next = this.wanted;
    this.wanted = null;
    if (next.length === this.local.length && next.every((f) => this.local.includes(f))) return;
    const before = this.local.filter((f) => this.remote.includes(f));
    for (const feature of this.local) if (!next.includes(feature)) this.dropGroup(feature);
    this.local = next;
    this.featuresSentAt = this.now();
    this.event({ t: "features", features: next });
    this.featuresChanged(before);
  }
  /** The side that drops a group ends its own part in it first, and queues
   *  all of this before its `features` event. */
  private dropGroup(feature: string): void {
    const gone = new LinkError("unsupported", `${feature} left use`);
    for (const call of [...this.inCalls.values()]) if (call.feature === feature) call.fail(gone);
    for (const call of [...this.outCalls.values()]) {
      if (call.feature !== feature) continue;
      if (this.requester.awaiting(call.id)) {
        if (this.requester.cancel(call.id)) this.enqueue(encodeCancel(call.id));
        this.settleCall(call, gone, false);
      } else {
        // An id that outlived its REPLY: its stream belongs to no request.
        this.sendReset(call.id, "cancelled");
        this.release(call.id);
      }
    }
    for (const [id, group] of [...this.streamFeature]) {
      if (group !== feature) continue;
      this.streamFeature.delete(id);
      if (this.readers.has(id) || this.writers.has(id)) {
        this.sendReset(id, "cancelled");
        this.readers.get(id)?.dead(gone);
        this.writers.get(id)?.dead(gone);
      }
    }
    if (feature === "channel") for (const channel of [...this.channels.values()]) channel.close("feature");
  }
  private featuresChanged(before: string[]): void {
    const after = this.local.filter((f) => this.remote.includes(f));
    const came = after.filter((f) => !before.includes(f));
    const left = before.filter((f) => !after.includes(f));
    if (came.length > 0 || left.length > 0) this.options.onFeatures?.(came, left);
  }

  // --- time ----------------------------------------------------------------

  /** Runs the timed rules: keepalive, the 30 s stall, the cancel grace, the
   *  stream senders' limit, and a pending `features` event. */
  tick(): void {
    if (!this.open) return;
    const life = this.keepalive.tick();
    if (life === "silence") return this.close("silence", "10 s without a frame");
    if (life === "ping") {
      this.pingCounter = (this.pingCounter + 1) >>> 0;
      this.pings.set(this.pingCounter, this.now());
      this.enqueue(encodePing(this.pingCounter));
    }
    for (const action of this.requester.tick()) {
      const call = this.outCalls.get(action.id);
      if (action.action === "cancel") {
        this.enqueue(encodeCancel(action.id));
        if (call) this.settleCall(call, new LinkError("timeout", "30 s without a frame for the request"), false);
      } else if (call) {
        this.settleCall(call, new LinkError(action.error), true);
        this.readers.get(action.id)?.dead(new LinkError(action.error));
      }
    }
    for (const writer of [...this.writers.values()]) writer.tick();
    const now = this.now();
    for (const call of [...this.inCalls.values()]) {
      const body = call.bodyReader;
      if (body !== null && call.channel === null && now - body.lastData >= LINK2_REQUEST_STALL_MS) call.fail(new LinkError("timeout", "30 s without a byte of the request's stream"));
    }
    this.flushFeatures();
  }
  /** Sends a PING now (Hub may also ping, §4.6). Resolves with the round trip in ms. */
  ping(): void {
    this.pingCounter = (this.pingCounter + 1) >>> 0;
    this.pings.set(this.pingCounter, this.now());
    this.enqueue(encodePing(this.pingCounter));
  }
  /** Set by the owner to learn of a PONG (the counted replacement of §2.4). */
  onPong: (() => void) | null = null;

  // --- reading -------------------------------------------------------------

  private feed(bytes: Uint8Array): void {
    if (this.closeInfo !== null) return;
    this.decoder.write(bytes);
    this.read();
  }
  /** Reads what the handshake's decoder holds behind `ready`: bytes of the
   *  read that carried `ready` (device) or `auth` (Hub), read by the linked rules. */
  readBuffered(): void {
    if (this.closeInfo !== null) return;
    this.read();
  }
  private read(): void {
    const skipped = this.decoder.skipped;
    for (;;) {
      if (this.closeInfo !== null) return;
      let frame: Link2Frame | null;
      try {
        frame = this.decoder.next();
      } catch (error) {
        return this.broke(error);
      }
      if (frame === null) break;
      this.stats.framesIn += 1;
      this.keepalive.received();
      try {
        this.frame(frame);
      } catch (error) {
        return this.broke(error);
      }
    }
    // A frame of an unknown type is skipped by its length and is a frame for the 10 s rule.
    if (this.decoder.skipped !== skipped) this.keepalive.received();
  }
  private broke(error: unknown): void {
    if (error instanceof LinkCloseError) this.close(error.code, error.message);
    else this.close("protocol", error instanceof Error ? error.message : String(error));
  }
  private ended(info: CloseInfo): void {
    if (this.closeInfo !== null) return;
    this.closeInfo = info;
    this.queue.length = 0;
    this.teardown(new LinkError("closed", info.reason || "the connection closed"));
    this.options.onClose?.(info);
  }
  private teardown(error: LinkError): void {
    for (const channel of [...this.channels.values()]) channel.ended("connection");
    for (const call of [...this.outCalls.values()]) {
      call.outlives = false;
      this.settleCall(call, error, true);
    }
    this.requester.closeAll();
    for (const call of [...this.inCalls.values()]) call.end(null);
    for (const reader of [...this.readers.values()]) reader.dead(error);
    for (const writer of [...this.writers.values()]) writer.dead(error);
  }

  private frame(frame: Link2Frame): void {
    if (this.retired && frame.type !== LINK2_FRAME.pong && frame.type !== LINK2_FRAME.close) return;
    switch (frame.type) {
      case LINK2_FRAME.ping:
        return this.enqueue(encodePong(frame));
      case LINK2_FRAME.pong: {
        const counter = new DataView(frame.payload.buffer, frame.payload.byteOffset, 4).getUint32(0, true);
        const sent = this.pings.get(counter);
        if (sent !== undefined) {
          this.stats.rttMs = this.now() - sent;
          this.pings.delete(counter);
        }
        this.onPong?.();
        return;
      }
      case LINK2_FRAME.close: {
        const close = parseClose(frame);
        this.carrier.close();
        return this.ended({ by: "peer", code: close.code, reason: close.reason });
      }
      case LINK2_FRAME.request:
        return this.onRequest(frame);
      case LINK2_FRAME.reply:
        return this.onReply(frame);
      case LINK2_FRAME.event:
        return this.onEventFrame(frame);
      case LINK2_FRAME.cancel:
        return this.onCancel(frame.id);
      case LINK2_FRAME.data:
        return this.onData(frame);
      case LINK2_FRAME.credit:
        return this.onCredit(frame);
      case LINK2_FRAME.reset:
        return this.onReset(frame);
    }
  }

  private onRequest(frame: Link2Frame): void {
    const { channel: channelId, object, bytes } = parseJsonPayload(frame);
    const id = frame.id;
    const sender: Side = this.side === "device" ? "hub" : "device";
    if (idRange(id) !== sender || this.idInUse(id)) throw new LinkCloseError("protocol", "a REQUEST id is not a fresh id of its sender");
    if ((frame.flags & LINK2_FLAG.app) !== 0) {
      const channel = this.channels.get(channelId as number);
      if (channel === undefined) return this.replyError(id, new LinkError("no_channel"));
      if (bytes > appMessageLimit(this.limit)) return this.replyError(id, new LinkError("too_large"));
      if (object === null || typeof object.t !== "string") return this.replyError(id, new LinkError("malformed"));
      const call = new IncomingCall(this, id, object.t, object, channel, (frame.flags & LINK2_FLAG.body) !== 0);
      return channel.requestArrived(call, bytes);
    }
    if (object === null || typeof object.t !== "string") return this.replyError(id, new LinkError("malformed", "not a JSON object with a string t"));
    const entry = this.handlers.get(object.t);
    if (entry === undefined) return this.replyError(id, new LinkError("unknown_message", `unknown request ${object.t}`));
    if (entry.feature !== null && !this.inUse(entry.feature)) return this.replyError(id, new LinkError("unsupported", `${entry.feature} is not in use`));
    if (entry.bound !== null && entry.bound.arrived(id) === "busy") return this.replyError(id, new LinkError("busy"));
    const call = new IncomingCall(this, id, object.t, object, null, false);
    call.feature = entry.feature;
    call.bound = entry.bound;
    this.inCalls.set(id, call);
    // The handler starts in this turn, so a stream it takes exists before the request's next frame is read.
    let result: ReturnType<Handler>;
    try {
      result = entry.fn(call);
    } catch (error) {
      return call.fail(error);
    }
    Promise.resolve(result).then(
      (value) => call.reply(value ?? {}),
      (error) => call.fail(error),
    );
  }

  private onReply(frame: Link2Frame): void {
    const call = this.outCalls.get(frame.id);
    if (call === undefined || this.requester.reply(frame.id) !== "reply") return;
    const parsed = parseJsonPayload(frame);
    const object = parsed.object ?? {};
    let outcome: Json | LinkError = object;
    if ((frame.flags & LINK2_FLAG.error) !== 0) {
      const { code, message, ...extra } = object;
      outcome = new LinkError(typeof code === "string" ? code : "internal", typeof message === "string" ? message : "", extra);
      // An id that would have outlived its REPLY ends here: nothing was opened.
      if (call.outlives) this.requester.release(frame.id);
      call.outlives = false;
    }
    // An applet's reply is handed over in the channel's order, behind its progress events and bytes.
    if (call.channel !== null && !call.settled) return call.channel.replyArrived(call, outcome, parsed.bytes);
    this.settleCall(call, outcome, true);
  }
  /** @internal */
  settleReply(call: OutCall, outcome: Json | LinkError): void {
    this.settleCall(call, outcome, true);
  }

  private onCancel(id: number): void {
    const call = this.inCalls.get(id);
    if (call === undefined) return;
    if (call.channel !== null) call.channel.requestWithdrawn(call);
    // The endpoint next to the responder answers the CANCEL itself (§5.4).
    call.end(new LinkError("cancelled"));
  }

  private idInUse(id: number): boolean {
    if (this.outCalls.has(id) || this.inCalls.has(id) || this.readers.has(id) || this.writers.has(id) || this.channels.has(id)) return true;
    for (const channel of this.channels.values()) if (channel.holdsStream(id)) return true;
    return false;
  }

  private onEventFrame(frame: Link2Frame): void {
    const app = (frame.flags & LINK2_FLAG.app) !== 0;
    const { channel: channelId, object, bytes } = parseJsonPayload(frame);
    const t = object !== null && typeof object.t === "string" ? object.t : null;
    const id = frame.id;
    const reading = readEvent(this.side, id, app, t, {
      channelRequest: (rid) => {
        const out = this.outCalls.get(rid);
        if (out !== undefined && out.channel !== null && this.requester.awaiting(rid)) return true;
        const incoming = this.inCalls.get(rid);
        return incoming !== undefined && incoming.channel !== null;
      },
      ownRequest: (rid) => this.outCalls.has(rid) && this.requester.awaiting(rid),
      channel: (cid) => this.channels.has(cid),
      inUse: (uid) => this.idInUse(uid),
    });
    switch (reading.read) {
      case "close":
        throw new LinkCloseError("protocol", reading.why);
      case "ignore":
        this.stats.lateEvents += 1;
        return;
      case "reset-refused":
        return this.sendReset(id, "refused");
      case "app-progress": {
        const call = this.outCalls.get(id);
        if (call === undefined || call.channel === null) return;
        const deliver = this.requester.frame(id) === "deliver";
        if (object === null || t === null || bytes > appMessageLimit(this.limit)) {
          // No name, or over LINK_APP_MSG: dropped, and the units its sender spent return (§5.6).
          const cost = call.channel.eventArrived(bytes);
          if (cost !== null) call.channel.unitsLeft(cost);
          return;
        }
        const { t: _t, ...args } = object;
        return call.channel.progressArrived(call, t, args, bytes, !deliver);
      }
      case "app": {
        const channel = this.channels.get(channelId as number);
        const refuse = () => {
          if (reading.opensStream) this.sendReset(id, "refused");
        };
        if (channel === undefined) return refuse();
        if (bytes > appMessageLimit(this.limit) || object === null || t === null) {
          // Dropped, and its units return: the sender spent them (§5.6).
          const cost = channel.eventArrived(bytes);
          if (cost !== null) channel.unitsLeft(cost);
          return refuse();
        }
        const { t: _t, ...args } = object;
        return channel.appEvent(t, args, bytes, reading.opensStream ? id : 0);
      }
      case "system": {
        const object2 = object as Json;
        if (reading.t === "features") return this.onFeatures(object2);
        if (reading.t === "channel.close") {
          const reason = typeof object2.reason === "string" ? object2.reason : "closed";
          return this.channels.get(id)?.ended(reason);
        }
        const entry = this.events.get(reading.t);
        if (id !== 0 && !reading.opensStream) this.requester.frame(id);
        if (!reading.opensStream) {
          if (id !== 0) {
            const call = this.outCalls.get(id);
            if (call !== undefined && !call.settled) call.onProgress?.(reading.t, object2, call.response ?? undefined);
            return;
          }
          if (entry !== undefined && (entry.feature === null || this.inUse(entry.feature))) entry.fn(object2, null, 0);
          return;
        }
        let opened: StreamReader | null = null;
        if (entry !== undefined && (entry.feature === null || this.inUse(entry.feature))) {
          entry.fn(
            object2,
            (intake) => {
              opened = this.newReader(id, { auto: intake }, entry.feature ?? undefined);
              opened.start();
              return opened;
            },
            id,
          );
        }
        if (opened === null) this.sendReset(id, "refused");
        return;
      }
    }
  }

  private onFeatures(object: Json): void {
    const list = parseFeatures(object.features);
    if (list === null) throw new LinkCloseError("protocol", "a features event without a valid list");
    const before = this.local.filter((f) => this.remote.includes(f));
    this.remote = list;
    this.featuresChanged(before);
  }

  private onData(frame: Link2Frame): void {
    if (this.outCalls.has(frame.id)) {
      if (this.requester.frame(frame.id) === "discard") return;
    }
    const reader = this.readers.get(frame.id);
    const end = (frame.flags & LINK2_FLAG.end) !== 0;
    if (reader === undefined) {
      // An empty stream's END needs no credit and may arrive before this side takes the stream: a
      // request's body before the responder's handler runs, or an applet's response whose head
      // event, END and REPLY came in one write, before the applet took the head event (§7.2).
      if (end && frame.payload.length === 0 && (this.inCalls.has(frame.id) || this.outCalls.has(frame.id))) this.earlyEnd.add(frame.id);
      return;
    }
    reader.data(frame.payload, end);
  }

  private onCredit(frame: Link2Frame): void {
    const amount = parseCredit(frame);
    const channel = this.channels.get(frame.id);
    if (channel !== undefined) return channel.unitsGranted(amount);
    if (this.outCalls.has(frame.id)) this.requester.frame(frame.id);
    const writer = this.writers.get(frame.id);
    if (writer !== undefined) return writer.grant(amount);
    // The grant may come in the same write as the request (§5.6), ahead of the writer.
    if (this.inCalls.has(frame.id) || this.outCalls.has(frame.id)) this.earlyCredit.set(frame.id, (this.earlyCredit.get(frame.id) ?? 0) + amount);
  }

  private onReset(frame: Link2Frame): void {
    const { code } = parseReset(frame);
    const error = new LinkError("transfer", `reset by the peer: ${code ?? "unknown"}`, { reset: code });
    this.streamFeature.delete(frame.id);
    const reader = this.readers.get(frame.id);
    // As for an early END: kept for the stream's hand-over.
    if (reader === undefined && (this.inCalls.has(frame.id) || this.outCalls.has(frame.id))) this.earlyReset.set(frame.id, error);
    reader?.dead(error);
    this.writers.get(frame.id)?.dead(error);
  }
}
