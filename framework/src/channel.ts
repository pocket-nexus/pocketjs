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

/** The host's calls. Numbers below zero are the codes of CHANNEL_CODE.
 *
 *  An id is a handle the host gives out for one request or stream of one
 *  generation of the channel (§7.4). The host refuses a handle of an earlier
 *  generation with `stale`, so a handle kept across a reconnect reaches
 *  nothing of the channel that is open now. */
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
  /** Abandons one side of `id`: the stream toward the applet, or with
   *  `outbound` the stream toward the daemon. A request's id names both its
   *  body and its response. */
  close(id: number, outbound?: boolean): void;
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
  /** The handle is of an earlier generation of the channel. */
  stale: -8,
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

/** The open channel's generation as this module last read it; 0 while the
 *  channel is not open. Every reader, writer and call remembers the
 *  generation it was made in and fails with `closed` once it differs: the
 *  host's own check (CHANNEL_CODE.stale) covers what happens between two reads. */
let liveGeneration = 0;

function readGeneration(): ChannelStatus {
  const now = channelState();
  liveGeneration = now.state === CHANNEL_STATE.open ? now.generation : 0;
  return now;
}

function closedError(): ChannelError {
  return new ChannelError("closed", "the channel closed");
}

/** A handler's own exception: reported, never thrown into the pump. */
function reportHandlerError(error: unknown): void {
  try {
    (globalThis as { console?: { error?: (...args: unknown[]) => void } }).console?.error?.(`channel handler: ${String((error as Error)?.message ?? error)}`);
  } catch {
    // A console that throws has nothing more to say.
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
  /** Why the stream failed; every later read rejects with it. */
  private failure: ChannelError | null = null;

  /** @internal */
  constructor(
    readonly id: number,
    private readonly generation: number = liveGeneration,
  ) {}

  /** Resolves with the bytes written into `into` (at least 1), or null at the
   *  stream's end. One read is pending at a time. `into` holds at least one byte. */
  read(into: Uint8Array): Promise<number | null> {
    if (this.pending) return Promise.reject(new ChannelError("busy", "a read is already pending on this stream"));
    if (this.failure) return Promise.reject(this.failure);
    if (this.done) return Promise.resolve(null);
    if (into.length === 0) return Promise.reject(new ChannelError("malformed", "a read needs room for at least one byte"));
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
    if (this.generation === liveGeneration) channelHost()?.close(this.id, false);
    const pending = this.pending;
    this.pending = null;
    pending?.resolve(null);
  }

  /** @internal Once per tick while a read is pending. */
  service(): void {
    const pending = this.pending;
    const ops = channelHost();
    if (!pending) return;
    // A stream of an earlier generation went with its channel: no call reaches the host for it.
    const count = !ops ? CHANNEL_CODE.noChannel : this.generation !== liveGeneration ? CHANNEL_CODE.stale : ops.read(this.id, pending.into);
    if (count === 0) return;
    this.pending = null;
    readers.delete(this);
    if (count > 0) {
      pending.resolve(count);
    } else {
      this.done = true;
      if (count === CHANNEL_CODE.streamEnd) {
        pending.resolve(null);
        return;
      }
      this.failure = count === CHANNEL_CODE.stale ? closedError()
        : new ChannelError(count === CHANNEL_CODE.noChannel ? "no_channel" : "stream", "the stream was reset");
      pending.reject(this.failure);
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
  constructor(
    readonly id: number,
    private readonly generation: number = liveGeneration,
  ) {}

  /** True once the stream has ended, failed or been closed. */
  get finished(): boolean {
    return this.done;
  }

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
    if (this.generation === liveGeneration) channelHost()?.close(this.id, true);
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
    if (this.generation !== liveGeneration) {
      this.fail(closedError());
      return;
    }
    while (this.queue.length > 0) {
      const item = this.queue[0]!;
      const taken = ops.write(this.id, item.at === 0 ? item.bytes : item.bytes.subarray(item.at));
      if (taken === 0 || taken === CHANNEL_CODE.full) return;
      if (taken < 0) {
        this.fail(taken === CHANNEL_CODE.stale ? closedError()
          : new ChannelError(taken === CHANNEL_CODE.noHead ? "no_head" : taken === CHANNEL_CODE.noChannel ? "no_channel" : "stream", "the stream took no bytes"));
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
      else ending.reject(status === CHANNEL_CODE.stale ? closedError() : new ChannelError("stream", "the stream did not end"));
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
    case CHANNEL_CODE.stale: return closedError();
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
  const generation = readGeneration().generation;
  let open: OpenCall | undefined;
  const reply = new Promise<ChannelJson>((resolve, reject) => {
    open = { resolve, reject, onProgress: options.onProgress, generation };
    calls.set(id, open);
  });
  if (options.body !== undefined) {
    const body = new ChannelWriter(id, generation);
    body.write(options.body).then(() => body.end()).catch(() => {});
  }
  wake();
  return {
    id,
    reply,
    cancel() {
      // A call that ended, or went with an earlier generation of the channel, cancels nothing:
      // its id may name another call now.
      if (calls.get(id) === open && generation === liveGeneration) ops.cancel(id);
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
const incoming = new Map<number, { cancelled: boolean; generation: number }>();
/** Replies the host had no room for: sent again each tick. */
const replies: { id: number; json: string; error: boolean; generation: number }[] = [];

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
  return id > 0 ? new ChannelWriter(id, readGeneration().generation) : null;
}

function errorJson(code: string, error: unknown): string {
  return JSON.stringify({ code, message: String((error as Error)?.message ?? error).slice(0, 160) });
}

/** One REPLY of a daemon's request. True when it needs no further try: sent,
 *  or the channel it belonged to is gone. A reply the host refuses for what it
 *  holds (too large, not an object) is answered with an error in its place, so
 *  the daemon's request always ends. */
function deliverReply(reply: { id: number; json: string; error: boolean; generation: number }, substitute = true): boolean {
  const ops = channelHost();
  if (!ops || reply.generation !== liveGeneration) return true;
  const status = ops.reply(reply.id, reply.json, reply.error);
  if (status === CHANNEL_CODE.full) return false;
  if (status === CHANNEL_CODE.ok || status === CHANNEL_CODE.noChannel || status === CHANNEL_CODE.stale || !substitute) return true;
  const code = status === CHANNEL_CODE.tooLarge ? "too_large" : "internal";
  return deliverReply({ ...reply, json: JSON.stringify({ code, message: "the handler's reply could not be sent" }), error: true }, false);
}

function sendReply(id: number, json: string, error: boolean, generation: number): void {
  const reply = { id, json, error, generation };
  if (!deliverReply(reply)) {
    replies.push(reply);
    wake();
  }
}

function serve(id: number, object: ChannelArgs, stream: number): void {
  const t = typeof object.t === "string" ? object.t : "";
  const handler = requestHandlers.get(t);
  const ops = channelHost();
  if (!ops) return;
  const generation = liveGeneration;
  if (!handler) {
    if (stream) ops.close(stream, false);
    sendReply(id, JSON.stringify({ code: "unknown_message", message: `no handler for ${t}` }), true, generation);
    return;
  }
  const state = { cancelled: false, generation };
  incoming.set(id, state);
  const call: IncomingCall = {
    t,
    args: object,
    get cancelled() {
      return state.cancelled;
    },
    body: stream ? new ChannelReader(stream, generation) : null,
    progress(name, args) {
      return generation === liveGeneration && ops.progress(id, message(name, args)) === CHANNEL_CODE.ok;
    },
    respond() {
      return new ChannelWriter(id, generation);
    },
  };
  let result: ChannelJson | void | Promise<ChannelJson | void>;
  try {
    result = handler(object, call);
  } catch (error) {
    if (incoming.get(id) === state) incoming.delete(id);
    sendReply(id, errorJson("internal", error), true, generation);
    return;
  }
  Promise.resolve(result).then(
    (value) => {
      if (incoming.get(id) === state) incoming.delete(id);
      let json: string;
      try {
        // A value JSON cannot carry (a BigInt, a cycle) ends the request as an error, not in silence.
        json = JSON.stringify(value === undefined || value === null || typeof value !== "object" || Array.isArray(value) ? {} : value);
      } catch (error) {
        sendReply(id, errorJson("internal", error), true, generation);
        return;
      }
      sendReply(id, json, false, generation);
    },
    (error) => {
      if (incoming.get(id) === state) incoming.delete(id);
      sendReply(id, errorJson(error instanceof ChannelError ? error.code : "internal", error), true, generation);
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

/** The head of a polled entry whose object did not parse: what it was for. */
const ENTRY_HEAD = /^\{"k":(\d+),"id":(\d+),"s":(\d+),"e":(true|false),"m":/;

interface Entry {
  k: number;
  id: number;
  s: number;
  e: boolean;
  m: ChannelArgs | null;
  /** The object is not JSON: the entry is answered or dropped, never handed on. */
  bad?: boolean;
}

function parseEntry(raw: string): Entry | null {
  try {
    return JSON.parse(raw) as Entry;
  } catch {
    const head = ENTRY_HEAD.exec(raw);
    return head ? { k: Number(head[1]), id: Number(head[2]), s: Number(head[3]), e: head[4] === "true", m: null, bad: true } : null;
  }
}

function pump(): void {
  const ops = channelHost();
  if (!ops) {
    liveGeneration = 0;
    for (const call of calls.values()) call.reject(new ChannelError("no_channel"));
    calls.clear();
    incoming.clear();
    replies.length = 0;
  } else {
    const now = readGeneration();
    // The channel closed, or closed and opened again: the host dropped what it held for the
    // earlier generation and sends nothing for it (§7.5). Calls fail with `closed`; requests
    // of the daemon and replies waiting for room belong to a channel that is gone.
    for (const [id, call] of calls) {
      if (call.generation === liveGeneration) continue;
      calls.delete(id);
      call.reject(new ChannelError("closed", `the channel closed${now.reason ? `: ${now.reason}` : ""}`));
    }
    for (const [id, state] of incoming) {
      if (state.generation === liveGeneration) continue;
      state.cancelled = true;
      incoming.delete(id);
    }
    // The host hands over this frame's budget of messages and of JSON bytes.
    for (;;) {
      const raw = ops.poll();
      if (raw === undefined) break;
      const entry = parseEntry(raw);
      if (!entry) continue;
      const object = entry.m ?? {};
      const t = typeof object.t === "string" ? object.t : "";
      if (entry.k === KIND.reply) {
        const call = calls.get(entry.id);
        calls.delete(entry.id);
        if (!call) continue;
        if (entry.bad) call.reject(new ChannelError("malformed", "the reply is not JSON"));
        else if (entry.e) call.reject(new ChannelError(typeof object.code === "string" ? object.code : "internal", typeof object.message === "string" ? object.message : undefined));
        else call.resolve(object);
      } else if (entry.k === KIND.progress) {
        const call = calls.get(entry.id);
        const stream = entry.s ? new ChannelReader(entry.s, liveGeneration) : undefined;
        if (call?.onProgress && !entry.bad) {
          try {
            call.onProgress(t, object, stream);
          } catch (error) {
            stream?.close();
            reportHandlerError(error);
          }
        } else {
          // A response nobody reads is given back to the host at once. Only the
          // response: the call's body, on the same id, keeps going out.
          stream?.close();
        }
      } else if (entry.k === KIND.event) {
        const handler = entry.bad ? undefined : eventHandlers.get(t);
        // An event that opens a stream needs a handler that takes it (§7.3).
        const stream = entry.s && handler && handler.length >= 2 ? new ChannelReader(entry.s, liveGeneration) : undefined;
        if (entry.s && !stream) ops.close(entry.s, false);
        try {
          if (stream) handler!(object, stream);
          else handler?.(object);
        } catch (error) {
          stream?.close();
          reportHandlerError(error);
        }
      } else if (entry.k === KIND.request) {
        if (entry.bad) {
          if (entry.s) ops.close(entry.s, false);
          sendReply(entry.id, JSON.stringify({ code: "malformed", message: "the request is not JSON" }), true, liveGeneration);
        } else {
          serve(entry.id, object, entry.s);
        }
      } else if (entry.k === KIND.cancel) {
        const state = incoming.get(entry.id);
        if (state) state.cancelled = true;
      }
    }
    for (let i = replies.length; i > 0; i -= 1) {
      const reply = replies.shift()!;
      if (!deliverReply(reply)) replies.push(reply);
    }
  }
  for (const reader of [...readers]) reader.service();
  for (const writer of [...writers]) writer.service();
  if (idle() && stopPump) {
    stopPump();
    stopPump = null;
  }
}
