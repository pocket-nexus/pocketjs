// @pocketjs/framework/channel — the running applet's channel to its computer
// side over the Pocket Link (`globalThis.link.channel`, capability
// "link.channel", docs/POCKET-LINK.md §7.3).
//
// The host owns the wire: ids, credit, the per-frame budgets and every byte
// loop run in its C code. This module sees whole JSON objects and byte
// chunks. It polls the host once per tick while a request is open, a handler
// is registered or a stream is in use.

import { registerServicePump } from "./services.ts";

export type ChannelJson = null | boolean | number | string | ChannelJson[] | { [key: string]: ChannelJson };
export type ChannelArgs = { [key: string]: ChannelJson };

/** The host's calls. Numbers below zero are the codes of CHANNEL_CODE. */
export interface ChannelOps {
  /** `{"state":"open"|"opening"|"closed","reason":"…","generation":n}` */
  state(): string;
  /** The next message of this frame's budget: `{"k","id","s","e","m"}`. */
  poll(): string | undefined;
  request(json: string, body: boolean): number;
  cancel(id: number): number;
  /** 0, or the stream's id when `stream` is true. */
  emit(json: string, stream: boolean): number;
  progress(id: number, json: string): number;
  reply(id: number, json: string, error: boolean): number;
  /** Bytes read; 0 while the read is pending. */
  read(id: number, into: Uint8Array): number;
  /** Bytes taken; 0 when the stream's buffer is full. */
  write(id: number, bytes: Uint8Array): number;
  end(id: number): number;
  close(id: number): void;
}

export const CHANNEL_CODE = {
  ok: 0,
  /** No room, units or credit now: the call is made again in a later frame. */
  full: -1,
  noChannel: -2,
  tooLarge: -3,
  malformed: -4,
  noHead: -5,
  streamEnd: -6,
  streamFailed: -7,
} as const;

const KIND = { event: 1, progress: 2, reply: 3, request: 4, cancel: 5 } as const;

export const CHANNEL_STATE = { closed: "closed", opening: "opening", open: "open" } as const;
export type ChannelStateName = (typeof CHANNEL_STATE)[keyof typeof CHANNEL_STATE];
export interface ChannelStatus {
  state: ChannelStateName;
  /** The last close reason or refusal; "" for none. */
  reason: string;
  /** Hub's generation of this channel (§7.4); 0 while it is not open. */
  generation: number;
}

/** A failed request, or a failed call into the channel. */
export class ChannelError extends Error {
  constructor(
    readonly code: string,
    message = code,
  ) {
    super(message);
    this.name = "ChannelError";
  }
}

export function channelHost(): ChannelOps | null {
  const link = (globalThis as { link?: { channel?: unknown } }).link;
  const ns = link && typeof link === "object" ? link.channel : undefined;
  if (!ns || typeof ns !== "object") return null;
  const ops = ns as Partial<ChannelOps>;
  return typeof ops.state === "function" && typeof ops.poll === "function" && typeof ops.request === "function" ? (ops as ChannelOps) : null;
}

const UNAVAILABLE: ChannelStatus = { state: CHANNEL_STATE.closed, reason: "unavailable", generation: 0 };

/** The channel's state, read from the host on every call. */
export function channelState(): ChannelStatus {
  const ops = channelHost();
  if (!ops) return UNAVAILABLE;
  try {
    const parsed = JSON.parse(ops.state()) as Partial<ChannelStatus>;
    return {
      state: parsed.state ?? CHANNEL_STATE.closed,
      reason: parsed.reason ?? "",
      generation: parsed.generation ?? 0,
    };
  } catch {
    return { ...UNAVAILABLE, reason: "malformed" };
  }
}

// ---- streams ------------------------------------------------------------------

const READ_CHUNK = 16 * 1024;

/** Bytes toward the applet: a response, or the stream of an event or of a
 *  daemon request's body. The host grants credit only while a read is
 *  pending, so an unread stream holds no bytes. */
export class ChannelReader {
  private pending: { into: Uint8Array; resolve: (count: number | null) => void; reject: (error: ChannelError) => void } | null = null;
  private done = false;

  /** @internal */
  constructor(readonly id: number) {}

  /** Resolves with the bytes written into `into` (at least 1), or null at the
   *  stream's end. One read is pending at a time. */
  read(into: Uint8Array): Promise<number | null> {
    if (this.pending) return Promise.reject(new ChannelError("busy", "a read is already pending on this stream"));
    if (this.done) return Promise.resolve(null);
    return new Promise((resolve, reject) => {
      this.pending = { into, resolve, reject };
      readers.add(this);
      wake();
      this.service();
    });
  }

  /** Every byte of the stream, for a stream of known modest size. */
  async bytes(limit = 1024 * 1024): Promise<Uint8Array> {
    const chunk = new Uint8Array(READ_CHUNK);
    const parts: Uint8Array[] = [];
    let total = 0;
    for (;;) {
      const count = await this.read(chunk);
      if (count === null) break;
      total += count;
      if (total > limit) {
        this.close();
        throw new ChannelError("too_large", "the stream is longer than the limit");
      }
      parts.push(chunk.slice(0, count));
    }
    const out = new Uint8Array(total);
    let at = 0;
    for (const part of parts) {
      out.set(part, at);
      at += part.length;
    }
    return out;
  }

  /** Abandons the stream; the host resets it. */
  close(): void {
    if (this.done) return;
    this.done = true;
    readers.delete(this);
    channelHost()?.close(this.id);
    const pending = this.pending;
    this.pending = null;
    pending?.resolve(null);
  }

  /** @internal Once per tick while a read is pending. */
  service(): void {
    const pending = this.pending;
    const ops = channelHost();
    if (!pending) return;
    const count = ops ? ops.read(this.id, pending.into) : CHANNEL_CODE.noChannel;
    if (count === 0) return;
    this.pending = null;
    readers.delete(this);
    if (count > 0) {
      pending.resolve(count);
    } else {
      this.done = true;
      if (count === CHANNEL_CODE.streamEnd) pending.resolve(null);
      else pending.reject(new ChannelError(count === CHANNEL_CODE.noChannel ? "no_channel" : "stream", "the stream was reset"));
    }
  }
}

/** Bytes toward the daemon: a request's body, an event's stream, or a
 *  response after its progress event. */
export class ChannelWriter {
  private queue: { bytes: Uint8Array; at: number; resolve: () => void; reject: (error: ChannelError) => void }[] = [];
  private ending: { resolve: () => void; reject: (error: ChannelError) => void } | null = null;
  private done = false;

  /** @internal */
  constructor(readonly id: number) {}

  /** Resolves when the host has taken every byte. */
  write(bytes: Uint8Array): Promise<void> {
    if (this.done || this.ending) return Promise.reject(new ChannelError("closed", "the stream has ended"));
    if (bytes.length === 0) return Promise.resolve();
    return new Promise((resolve, reject) => {
      this.queue.push({ bytes, at: 0, resolve, reject });
      writers.add(this);
      wake();
      this.service();
    });
  }

  /** No more bytes: resolves once the end is queued behind them. */
  end(): Promise<void> {
    if (this.done) return Promise.resolve();
    if (this.ending) return Promise.reject(new ChannelError("closed", "the stream is ending"));
    return new Promise((resolve, reject) => {
      this.ending = { resolve, reject };
      writers.add(this);
      wake();
      this.service();
    });
  }

  /** Abandons the stream; the host resets it. */
  close(): void {
    if (this.done) return;
    channelHost()?.close(this.id);
    this.fail(new ChannelError("closed", "the stream was closed"));
  }

  private fail(error: ChannelError): void {
    this.done = true;
    writers.delete(this);
    for (const item of this.queue) item.reject(error);
    this.queue = [];
    this.ending?.reject(error);
    this.ending = null;
  }

  /** @internal Once per tick while bytes or the end wait. */
  service(): void {
    const ops = channelHost();
    if (!ops) {
      this.fail(new ChannelError("no_channel"));
      return;
    }
    while (this.queue.length > 0) {
      const item = this.queue[0]!;
      const taken = ops.write(this.id, item.at === 0 ? item.bytes : item.bytes.subarray(item.at));
      if (taken === 0 || taken === CHANNEL_CODE.full) return;
      if (taken < 0) {
        this.fail(new ChannelError(taken === CHANNEL_CODE.noHead ? "no_head" : "stream", "the stream took no bytes"));
        return;
      }
      item.at += taken;
      if (item.at < item.bytes.length) return;
      this.queue.shift();
      item.resolve();
    }
    if (this.ending) {
      const status = ops.end(this.id);
      if (status === CHANNEL_CODE.full) return;
      const ending = this.ending;
      this.ending = null;
      this.done = true;
      writers.delete(this);
      if (status === CHANNEL_CODE.ok) ending.resolve();
      else ending.reject(new ChannelError("stream", "the stream did not end"));
      return;
    }
    writers.delete(this);
  }
}

// ---- the applet's requests ----------------------------------------------------

export interface ChannelCall {
  readonly id: number;
  /** The reply's value; rejects with a ChannelError carrying the reply's
   *  `code`. Settles at the REPLY, after the response stream's last byte. */
  readonly reply: Promise<ChannelJson>;
  cancel(): void;
}

export interface RequestOptions {
  /** The request's body: its bytes follow the request on a stream. */
  body?: Uint8Array;
  /** Each progress event of the call. `stream` is the response stream, given
   *  with the event that opens it. */
  onProgress?: (t: string, args: ChannelArgs, stream?: ChannelReader) => void;
}

interface OpenCall {
  resolve: (value: ChannelJson) => void;
  reject: (error: ChannelError) => void;
  onProgress?: RequestOptions["onProgress"];
  /** The channel's generation when the request was made. */
  generation: number;
}
const calls = new Map<number, OpenCall>();

function failed(code: number): ChannelError {
  switch (code) {
    case CHANNEL_CODE.full: return new ChannelError("busy", "the channel has no room now");
    case CHANNEL_CODE.noChannel: return new ChannelError("no_channel", "the channel is not open");
    case CHANNEL_CODE.tooLarge: return new ChannelError("too_large", "the message is over the channel's limit");
    case CHANNEL_CODE.noHead: return new ChannelError("no_head", "a response needs a progress event first");
    default: return new ChannelError("malformed", "the host refused the message");
  }
}

function message(t: string, args: ChannelArgs | undefined): string {
  return JSON.stringify({ ...(args ?? {}), t });
}

/** A request to the applet's daemon. Fails at once with `no_channel` while
 *  the channel is not open, and with `busy` when 8 requests are open or the
 *  send buffer has no room: the applet tries again in a later frame. */
export function request(t: string, args?: ChannelArgs, options: RequestOptions = {}): ChannelCall {
  const ops = channelHost();
  const id = ops ? ops.request(message(t, args), options.body !== undefined) : CHANNEL_CODE.noChannel;
  if (!ops || id <= 0) {
    const error = failed(id);
    const reply = Promise.reject(error);
    reply.catch(() => {});
    return { id: 0, reply, cancel() {} };
  }
  const generation = channelState().generation;
  const reply = new Promise<ChannelJson>((resolve, reject) => {
    calls.set(id, { resolve, reject, onProgress: options.onProgress, generation });
  });
  if (options.body !== undefined) {
    const body = new ChannelWriter(id);
    body.write(options.body).then(() => body.end()).catch(() => {});
  }
  wake();
  return {
    id,
    reply,
    cancel() {
      if (calls.has(id)) ops.cancel(id);
    },
  };
}

// ---- the daemon's requests and events -----------------------------------------

/** A request of the daemon, as its handler sees it. */
export interface IncomingCall {
  readonly t: string;
  readonly args: ChannelArgs;
  /** The daemon cancelled the request. */
  readonly cancelled: boolean;
  /** The request's body, when it carried one. */
  readonly body: ChannelReader | null;
  /** A progress event; false when the event window is full now. */
  progress(t: string, args?: ChannelArgs): boolean;
  /** The stream for response bytes, after a progress event (§7.2). */
  respond(): ChannelWriter;
}
export type RequestHandler = (args: ChannelArgs, call: IncomingCall) => ChannelJson | void | Promise<ChannelJson | void>;
export type EventHandler = (args: ChannelArgs, stream?: ChannelReader) => void;

const requestHandlers = new Map<string, RequestHandler>();
const eventHandlers = new Map<string, EventHandler>();
const incoming = new Map<number, { cancelled: boolean }>();
/** Replies the host had no room for: sent again each tick. */
const replies: { id: number; json: string; error: boolean }[] = [];

/** Answers the daemon's requests named `t`; the handler's result is the reply. */
export function onRequest(t: string, handler: RequestHandler): () => void {
  requestHandlers.set(t, handler);
  wake();
  return () => {
    if (requestHandlers.get(t) === handler) requestHandlers.delete(t);
  };
}

/** Receives the daemon's events named `t`. A handler that takes a second
 *  argument gets the stream of an event that opens one. */
export function onEvent(t: string, handler: EventHandler): () => void {
  eventHandlers.set(t, handler);
  wake();
  return () => {
    if (eventHandlers.get(t) === handler) eventHandlers.delete(t);
  };
}

/** An event to the daemon. False when the channel is not open or the event
 *  window is full: the applet tries again in a later frame. */
export function emit(t: string, args?: ChannelArgs): boolean {
  const ops = channelHost();
  return ops !== null && ops.emit(message(t, args), false) === CHANNEL_CODE.ok;
}

/** An event that opens a stream toward the daemon; null where `emit` gives false. */
export function emitStream(t: string, args?: ChannelArgs): ChannelWriter | null {
  const ops = channelHost();
  const id = ops ? ops.emit(message(t, args), true) : CHANNEL_CODE.noChannel;
  return id > 0 ? new ChannelWriter(id) : null;
}

function sendReply(id: number, json: string, error: boolean): void {
  const ops = channelHost();
  if (!ops) return;
  if (ops.reply(id, json, error) === CHANNEL_CODE.full) {
    replies.push({ id, json, error });
    wake();
  }
}

function serve(id: number, object: ChannelArgs, stream: number): void {
  const t = typeof object.t === "string" ? object.t : "";
  const handler = requestHandlers.get(t);
  const ops = channelHost();
  if (!ops) return;
  if (!handler) {
    if (stream) ops.close(stream);
    sendReply(id, JSON.stringify({ code: "unknown_message", message: `no handler for ${t}` }), true);
    return;
  }
  const state = { cancelled: false };
  incoming.set(id, state);
  const call: IncomingCall = {
    t,
    args: object,
    get cancelled() {
      return state.cancelled;
    },
    body: stream ? new ChannelReader(stream) : null,
    progress(name, args) {
      return ops.progress(id, message(name, args)) === CHANNEL_CODE.ok;
    },
    respond() {
      return new ChannelWriter(id);
    },
  };
  let result: ChannelJson | void | Promise<ChannelJson | void>;
  try {
    result = handler(object, call);
  } catch (error) {
    incoming.delete(id);
    sendReply(id, JSON.stringify({ code: "internal", message: String((error as Error)?.message ?? error).slice(0, 160) }), true);
    return;
  }
  Promise.resolve(result).then(
    (value) => {
      incoming.delete(id);
      sendReply(id, JSON.stringify(value === undefined || value === null || typeof value !== "object" || Array.isArray(value) ? {} : value), false);
    },
    (error) => {
      incoming.delete(id);
      const code = error instanceof ChannelError ? error.code : "internal";
      sendReply(id, JSON.stringify({ code, message: String((error as Error)?.message ?? error).slice(0, 160) }), true);
    },
  );
}

// ---- the pump -----------------------------------------------------------------

const readers = new Set<ChannelReader>();
const writers = new Set<ChannelWriter>();
let stopPump: (() => void) | null = null;

function idle(): boolean {
  return calls.size === 0 && incoming.size === 0 && replies.length === 0 && readers.size === 0 && writers.size === 0 &&
    requestHandlers.size === 0 && eventHandlers.size === 0;
}

function wake(): void {
  if (!stopPump) stopPump = registerServicePump(pump);
}

function pump(): void {
  const ops = channelHost();
  if (!ops) {
    for (const call of calls.values()) call.reject(new ChannelError("no_channel"));
    calls.clear();
  } else {
    if (calls.size > 0) {
      // The channel closed, or closed and opened again, under a request: the host dropped it
      // with the channel and sends nothing for it (§7.5), so the call fails here with `closed`.
      const now = channelState();
      for (const [id, call] of calls) {
        if (now.state === CHANNEL_STATE.open && now.generation === call.generation) continue;
        calls.delete(id);
        call.reject(new ChannelError("closed", `the channel closed${now.reason ? `: ${now.reason}` : ""}`));
      }
    }
    // The host hands over this frame's budget of messages and of JSON bytes.
    for (;;) {
      const raw = ops.poll();
      if (raw === undefined) break;
      let entry: { k: number; id: number; s: number; e: boolean; m: ChannelArgs | null };
      try {
        entry = JSON.parse(raw);
      } catch {
        continue;
      }
      const object = entry.m ?? {};
      const t = typeof object.t === "string" ? object.t : "";
      if (entry.k === KIND.reply) {
        const call = calls.get(entry.id);
        calls.delete(entry.id);
        if (!call) continue;
        if (entry.e) call.reject(new ChannelError(typeof object.code === "string" ? object.code : "internal", typeof object.message === "string" ? object.message : undefined));
        else call.resolve(object);
      } else if (entry.k === KIND.progress) {
        const call = calls.get(entry.id);
        const stream = entry.s ? new ChannelReader(entry.s) : undefined;
        if (call?.onProgress) call.onProgress(t, object, stream);
        // A response nobody reads is given back to the host at once.
        else stream?.close();
      } else if (entry.k === KIND.event) {
        const handler = eventHandlers.get(t);
        if (entry.s) {
          // An event that opens a stream needs a handler that takes it (§7.3).
          if (handler && handler.length >= 2) handler(object, new ChannelReader(entry.s));
          else {
            ops.close(entry.s);
            handler?.(object);
          }
        } else {
          handler?.(object);
        }
      } else if (entry.k === KIND.request) {
        serve(entry.id, object, entry.s);
      } else if (entry.k === KIND.cancel) {
        const state = incoming.get(entry.id);
        if (state) state.cancelled = true;
      }
    }
    for (let i = replies.length; i > 0; i -= 1) {
      const reply = replies.shift()!;
      if (ops.reply(reply.id, reply.json, reply.error) === CHANNEL_CODE.full) replies.push(reply);
    }
  }
  for (const reader of [...readers]) reader.service();
  for (const writer of [...writers]) writer.service();
  if (idle() && stopPump) {
    stopPump();
    stopPump = null;
  }
}
