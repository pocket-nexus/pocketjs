/** Relay P3 — bounded queues, cumulative credit, priority selection, reset
 * and CANCEL (R5 draft §3.3 seq rule, §3.6, §3.9).
 *
 * The layer is transport-agnostic TS state machines. It never touches a
 * socket: the transport drains encoded frames from the ordered send stream
 * and feeds decoded frames plus their record length to the receiver.
 *
 * Two independent capacities are kept separate, as §3.9 requires:
 *   - the wire window: frames and bytes sent but not yet released by the
 *     receiver (RelayCreditLedger);
 *   - admitted work: maxPending originated requests (RelayRequestTable).
 * A CANCEL or local timeout never returns either capacity early: wire credit
 * returns from relay.credit only; a request slot returns when the one terminal
 * response is delivered or the stream/session ends.
 *
 * Sideband (two 256-byte slots per direction) is a separate bounded lane for
 * relay.credit, relay.ping, relay.reset and CANCEL. Sideband frames take
 * stream-0 seq but consume no normal window and earn no credit. The sender
 * admits/drains them through RelaySideband; the receiver classifies decoded
 * records with isSidebandFrame(), stages them in its own two-slot lane
 * (ingestSideband/pumpSideband), and never charges them to the control
 * slice. */

import {
  RELAY_EFFECT,
  RELAY_ERROR,
  RELAY_LIMITS,
  RELAY_OP,
  RELAY_TYPE,
} from "../../../contracts/spec/relay.ts";
import {
  encodePreparedFrame,
  prepareFrameBody,
  type RelayDecodedFrame,
  type RelayFrameBodyInput,
  type RelayPreparedBody,
} from "./frame.ts";

/** Local P3 violations. These are neither application error.code strings
 * (RELAY_ERROR) nor frame parse codes (RELAY_FRAME_ERROR): the frame was
 * well-formed, but a queue/credit/seq rule was broken. The session layer
 * maps WINDOW_OVERFLOW/SESSION_FATAL to resync or teardown. */
export const RELAY_P3_ERROR = Object.freeze({
  /** No capacity right now; caller keeps the demand and retries. */
  BUSY: "BUSY",
  /** Live-stream limit, invalid/reused id, or a stream never opened. */
  STREAM_LIMIT: "STREAM_LIMIT",
  STREAM_DEAD: "STREAM_DEAD",
  /** A frame arrived past the granted window; reliable channels do not drop. */
  WINDOW_OVERFLOW: "WINDOW_OVERFLOW",
  /** Peer credit counter went backwards or past what this side sent. */
  CREDIT_RANGE: "CREDIT_RANGE",
  /** Receive side saw a seq hole or repeat; stream stops pending resync. */
  SEQ_GAP: "SEQ_GAP",
  SEQ_EXHAUSTED: "SEQ_EXHAUSTED",
  /** Frame belongs on the sideband lane / the lane rejected it. */
  SIDEBAND_FORBIDDEN: "SIDEBAND_FORBIDDEN",
  SIDEBAND_FULL: "SIDEBAND_FULL",
  SIDEBAND_LARGE: "SIDEBAND_LARGE",
  CREDIT_TABLE_FULL: "CREDIT_TABLE_FULL",
  PENDING_FULL: "PENDING_FULL",
  UNKNOWN_REQUEST: "UNKNOWN_REQUEST",
  ALREADY_TERMINAL: "ALREADY_TERMINAL",
  /** Admitted frame carried the wrong correlation for its header type. */
  BAD_CORRELATION: "BAD_CORRELATION",
  /** Terminal CANCELLED carried an effect outside none/committed/unknown. */
  BAD_TERMINAL: "BAD_TERMINAL",
  /** Violation on stream 0; the attachment cannot continue. */
  SESSION_FATAL: "SESSION_FATAL",
} as const);

export type RelayP3ErrorCode = (typeof RELAY_P3_ERROR)[keyof typeof RELAY_P3_ERROR];

export type P3Result<T = unknown> =
  | ({ ok: true; code?: undefined } & T)
  | { ok: false; code: RelayP3ErrorCode };

/** Selection bands from §3.9: management/input progress first, then
 * currently visible resources, then prefetch. Lower runs first. */
export const RELAY_PRIORITY = Object.freeze({
  CONTROL: 0,
  VISIBLE: 1,
  PREFETCH: 2,
} as const);
export type RelayPriority = (typeof RELAY_PRIORITY)[keyof typeof RELAY_PRIORITY];

export interface RelayStreamAlloc {
  frames: number;
  bytes: number;
}

// --- small helpers -----------------------------------------------------------

const hex16 = (n: bigint) => n.toString(16).padStart(16, "0");

/** Clips a string to at most maxBytes UTF-8 bytes, never splitting a
 * multi-byte character. §3.9 truncates CANCEL/reset reasons at 64 bytes. */
export function clipUtf8Bytes(s: string, maxBytes: number): string {
  let bytes = 0;
  let out = "";
  for (const ch of s) {
    const n = new TextEncoder().encode(ch).length;
    if (bytes + n > maxBytes) break;
    bytes += n;
    out += ch;
  }
  return out;
}

// --- seq allocator ------------------------------------------------------------

/** Per-(session, stream, direction) u32 seq starting at 1. Never wraps: near
 * exhaustion the caller reopens the stream or session (§3.3). */
export class RelaySeqSpace {
  private next = new Map<number, number>();

  allocate(stream: number): P3Result<{ seq: number }> {
    const seq = this.next.get(stream) ?? 1;
    if (seq > 0xffffffff) return { ok: false, code: RELAY_P3_ERROR.SEQ_EXHAUSTED };
    this.next.set(stream, seq + 1);
    return { ok: true, seq };
  }

  last(stream: number): number {
    return (this.next.get(stream) ?? 1) - 1;
  }

  drop(stream: number) {
    this.next.delete(stream);
  }

  reset() {
    this.next.clear();
  }
}

// --- wire credit ledger -------------------------------------------------------

interface RelayCounters {
  /** Cumulative normal frames/bytes charged at selection. */
  sentF: bigint;
  sentB: bigint;
  /** Cumulative frames/bytes released by the peer (relay.credit). */
  relF: bigint;
  relB: bigint;
}

/** One direction's per-stream window accounting. Allocations for streams
 * 1..N sum, with stream 0's control slice, to at most the attachment window
 * advertised at OPEN. Sideband frames are never entered here. */
export class RelayCreditLedger {
  private alloc = new Map<number, RelayStreamAlloc>();
  private count = new Map<number, RelayCounters>();
  private dead = new Set<number>();
  private highestStream = 0;
  private sumFrames = 0;
  private sumBytes = 0;

  constructor(
    private readonly windowFrames: number,
    private readonly windowBytes: number,
    control: RelayStreamAlloc,
  ) {
    this.alloc.set(0, { ...control });
    this.count.set(0, { sentF: 0n, sentB: 0n, relF: 0n, relB: 0n });
    this.sumFrames = control.frames;
    this.sumBytes = control.bytes;
  }

  /** Registers a stream's slice of the attachment window. The sum of
   * stream 0 plus every open stream must not exceed the negotiated window. */
  allocate(stream: number, slice: RelayStreamAlloc): P3Result {
    if (!Number.isInteger(stream) || stream <= this.highestStream || stream > 0xffffffff) return { ok: false, code: RELAY_P3_ERROR.STREAM_LIMIT };
    if (slice.frames < 1 || slice.bytes < 1
      || this.sumFrames + slice.frames > this.windowFrames
      || this.sumBytes + slice.bytes > this.windowBytes) {
      return { ok: false, code: RELAY_P3_ERROR.STREAM_LIMIT };
    }
    this.alloc.set(stream, { ...slice });
    this.highestStream = stream;
    this.count.set(stream, { sentF: 0n, sentB: 0n, relF: 0n, relB: 0n });
    this.sumFrames += slice.frames;
    this.sumBytes += slice.bytes;
    return { ok: true };
  }

  sliceOf(stream: number): RelayStreamAlloc | undefined {
    return this.alloc.get(stream);
  }

  streamIds(): number[] {
    return [...this.alloc.keys()];
  }

  isDead(stream: number): boolean {
    return this.dead.has(stream) || (stream > 0 && stream <= this.highestStream && !this.alloc.has(stream));
  }

  /** Charge one selected normal frame against its stream window. Called at
   * seq allocation, never earlier (§3.3). */
  charge(stream: number, wireBytes: number): P3Result {
    const a = this.alloc.get(stream);
    const c = this.count.get(stream);
    if (!a || !c || this.dead.has(stream)) return { ok: false, code: RELAY_P3_ERROR.STREAM_DEAD };
    const usedF = c.sentF - c.relF;
    const usedB = c.sentB - c.relB;
    if (usedF + 1n > BigInt(a.frames) || usedB + BigInt(wireBytes) > BigInt(a.bytes)) {
      return { ok: false, code: RELAY_P3_ERROR.BUSY };
    }
    c.sentF += 1n;
    c.sentB += BigInt(wireBytes);
    return { ok: true };
  }

  /** Applies one inbound relay.credit: cumulative counters must be
   * monotonic and no larger than what this endpoint sent. Repeating the
   * same values has no effect (§3.9). */
  release(stream: number, framesReleased: bigint, bytesReleased: bigint): P3Result {
    const c = this.count.get(stream);
    // A composed endpoint forgets a reset stream's counters. Its old
    // credit may still be in the ordered transport; it grants no capacity.
    if (!c && this.isDead(stream)) return { ok: true };
    if (!c) return { ok: false, code: RELAY_P3_ERROR.CREDIT_RANGE };
    if (framesReleased < c.relF || bytesReleased < c.relB
      || framesReleased > c.sentF || bytesReleased > c.sentB) {
      return { ok: false, code: RELAY_P3_ERROR.CREDIT_RANGE };
    }
    c.relF = framesReleased;
    c.relB = bytesReleased;
    return { ok: true };
  }

  /** Window currently spendable on this stream: allocation minus in-flight. */
  available(stream: number): RelayStreamAlloc {
    const a = this.alloc.get(stream);
    const c = this.count.get(stream);
    if (!a || !c) return { frames: 0, bytes: 0 };
    return {
      frames: Math.max(0, a.frames - Number(c.sentF - c.relF)),
      bytes: Math.max(0, a.bytes - Number(c.sentB - c.relB)),
    };
  }

  inFlight(stream: number): RelayStreamAlloc {
    const c = this.count.get(stream);
    if (!c) return { frames: 0, bytes: 0 };
    return { frames: Number(c.sentF - c.relF), bytes: Number(c.sentB - c.relB) };
  }

  sentTotals(stream: number): RelayStreamAlloc {
    const c = this.count.get(stream);
    if (!c) return { frames: 0, bytes: 0 };
    return { frames: Number(c.sentF), bytes: Number(c.sentB) };
  }

  releasedTotals(stream: number): RelayStreamAlloc {
    const c = this.count.get(stream);
    if (!c) return { frames: 0, bytes: 0 };
    return { frames: Number(c.relF), bytes: Number(c.relB) };
  }

  /** relay.reset keeps the counter row (late frames still settle through
   * it) but forbids new admission; the stream id is never reused. The
   * stream's slice returns to the attachment window for a later OPEN: the
   * peer's receiver discards the dead stream's staging and drops its late
   * frames without holding them, so the capacity is free on both ends. */
  markDead(stream: number) {
    if (stream === 0) {
      for (const s of this.alloc.keys()) this.dead.add(s);
      return;
    }
    if (this.dead.has(stream)) return;
    this.dead.add(stream);
    const slice = this.alloc.get(stream);
    if (slice) {
      this.sumFrames -= slice.frames;
      this.sumBytes -= slice.bytes;
    }
  }

  /** Once RESET owns both directions, no work can use this row. A single
   * high-water mark fences every retired id without retaining tombstones. */
  forgetStream(stream: number): void {
    if (stream === 0 || !this.dead.has(stream)) return;
    this.alloc.delete(stream);
    this.count.delete(stream);
    this.dead.delete(stream);
  }
}

// --- sideband whitelist (both directions) --------------------------------------

/** §3.9 sideband whitelist, identical in both directions: a record rides the
 * reserved lane only on stream 0 and only as credit, ping/pong, reset or
 * CANCEL. Every other stream-0 record is an ordinary management frame that
 * consumes the normal control slice. The send lane checks prepared bodies
 * (metadata already serialized); the receiver checks decoded frames. */
export function isSidebandFrame(f: { type: number; stream: number; metadata: { op?: unknown } }): boolean {
  if (f.stream !== 0) return false;
  const op = f.metadata?.op;
  if (f.type === RELAY_TYPE.CANCEL) return op === RELAY_OP.REQUEST_CANCEL;
  if (f.type === RELAY_TYPE.PUSH) return op === RELAY_OP.CREDIT || op === RELAY_OP.RESET;
  if (f.type === RELAY_TYPE.REQUEST || f.type === RELAY_TYPE.RESPONSE) {
    return op === RELAY_OP.PING;
  }
  return false;
}

// --- outbound sideband lane ----------------------------------------------------

interface SidebandItem {
  body: RelayPreparedBody;
  correlation: number;
}

/** The reserved lane: two 256-byte slots per direction. Only credit,
 * ping/pong, reset and CANCEL are admitted; business data is rejected. The
 * lane never borrows from the normal window. */
export class RelaySideband {
  private items: SidebandItem[] = [];
  private bytes = 0;

  constructor(
    private readonly slots = RELAY_LIMITS.sidebandSlots,
    private readonly slotBytes = RELAY_LIMITS.sidebandSlotBytes,
  ) {}

  get pendingFrames(): number {
    return this.items.length;
  }

  get pendingBytes(): number {
    return this.bytes;
  }

  get frameCap(): number {
    return this.slots;
  }

  get byteCap(): number {
    return this.slots * this.slotBytes;
  }

  /** Admits a prepared frame after checking the §3.9 whitelist and the
   * per-frame 256-byte cap. Pending work is bounded by slots*slotBytes; a
   * full lane returns SIDEBAND_FULL and the caller retries next pump. */
  admit(body: RelayPreparedBody, correlation: number): P3Result {
    if (!this.whitelisted(body)) return { ok: false, code: RELAY_P3_ERROR.SIDEBAND_FORBIDDEN };
    if (body.wireBytes > this.slotBytes) return { ok: false, code: RELAY_P3_ERROR.SIDEBAND_LARGE };
    if (this.items.length >= this.slots || this.bytes + body.wireBytes > this.byteCap) {
      return { ok: false, code: RELAY_P3_ERROR.SIDEBAND_FULL };
    }
    this.items.push({ body, correlation });
    this.bytes += body.wireBytes;
    return { ok: true };
  }

  private whitelisted(body: RelayPreparedBody): boolean {
    return isSidebandFrame({
      type: body.type,
      stream: body.stream,
      metadata: { op: this.opOf(body) },
    });
  }

  private opOf(body: RelayPreparedBody): string {
    return (JSON.parse(new TextDecoder().decode(body.meta)) as { op?: unknown }).op as string ?? "";
  }

  /** Drains pending items in FIFO order. The caller supplies stream-0 seq
   * (shared with normal stream-0 frames) and stamps the full header. The
   * adapter sends at most slots frames / slots*slotBytes per worker turn. */
  drain(
    session: bigint,
    allocSeq: (stream: number) => P3Result<{ seq: number }>,
    maxFrames = this.slots,
    maxBytes = this.byteCap,
  ): { frames: Uint8Array[]; code?: RelayP3ErrorCode } {
    const frames: Uint8Array[] = [];
    let usedBytes = 0;
    while (this.items.length > 0 && frames.length < maxFrames) {
      const item = this.items[0];
      if (usedBytes + item.body.wireBytes > maxBytes) break;
      const seq = allocSeq(0);
      if (!seq.ok) return { frames, code: seq.code };
      const enc = encodePreparedFrame(item.body, { session, seq: seq.seq, correlation: item.correlation });
      if (!enc.ok) return { frames, code: RELAY_P3_ERROR.SIDEBAND_FORBIDDEN };
      frames.push(enc.bytes);
      usedBytes += item.body.wireBytes;
      this.bytes -= item.body.wireBytes;
      this.items.shift();
    }
    return { frames };
  }
}

// --- credit merge table (receiver side) ----------------------------------------

interface CreditRow {
  frames: bigint;
  bytes: bigint;
  dirty: boolean;
}

/** Bounded table of outbound cumulative credit per target stream. Repeated
 * releases for one stream merge into one row; the table holds at most
 * sidebandCreditTable rows (stream 0 + the eight nonzero streams). */
export class RelayCreditTable {
  private rows = new Map<number, CreditRow>();

  constructor(private readonly maxRows = RELAY_LIMITS.sidebandCreditTable) {}

  /** Accumulates one release (immediate late-drop or consumed staging). */
  note(stream: number, frames: number, bytes: number): P3Result {
    let row = this.rows.get(stream);
    if (!row) {
      if (this.rows.size >= this.maxRows) return { ok: false, code: RELAY_P3_ERROR.CREDIT_TABLE_FULL };
      row = { frames: 0n, bytes: 0n, dirty: false };
      this.rows.set(stream, row);
    }
    row.frames += BigInt(frames);
    row.bytes += BigInt(bytes);
    row.dirty = true;
    return { ok: true };
  }

  get size(): number {
    return this.rows.size;
  }

  counters(stream: number): { frames: bigint; bytes: bigint } | undefined {
    const r = this.rows.get(stream);
    return r ? { frames: r.frames, bytes: r.bytes } : undefined;
  }

  /** Builds one relay.credit PUSH body per dirty stream. Bodies are admitted
   * into the sideband by the sender during its pump; a still-full lane
   * leaves the row dirty for the next pump. */
  takeDirty(): Array<{ stream: number; body: RelayPreparedBody }> {
    const out: Array<{ stream: number; body: RelayPreparedBody }> = [];
    for (const [stream, row] of this.rows) {
      if (!row.dirty) continue;
      const prepared = prepareFrameBody({
        type: RELAY_TYPE.PUSH,
        stream: 0,
        metadata: {
          op: RELAY_OP.CREDIT,
          targetStream: stream,
          framesReleased: hex16(row.frames),
          bytesReleased: hex16(row.bytes),
        },
      }, { maxWireBytes: RELAY_LIMITS.sidebandSlotBytes });
      // All inputs are integers/strings this module itself produced; a
      // prepare failure here is a programming error, not a peer frame.
      if (!prepared.ok) throw new Error(`relay.credit body build failed: ${prepared.code}`);
      out.push({ stream, body: prepared.body });
    }
    return out;
  }

  /** Marks rows the sideband accepted. */
  clearDirty(streams: number[]) {
    for (const s of streams) {
      const row = this.rows.get(s);
      if (row) row.dirty = false;
    }
  }

  /** The peer resets the same stream, so any queued credit for it is void. */
  forgetStream(stream: number): void { if (stream !== 0) this.rows.delete(stream); }
}

// --- send planner ---------------------------------------------------------------

interface QueuedFrame {
  body: RelayPreparedBody;
  correlation: number;
  priority: RelayPriority;
  /** Originated request/subscription this frame belongs to; reset fails it. */
  association?: { kind: "correlation" | "subscription"; id: number };
  enqueued: number;
}

export interface RelaySendConfig {
  windowFrames: number;
  windowBytes: number;
  /** Stream-0 slice of the window; defaults to a quarter, bounded by the
   * §3.9 8-frame / 32768-byte control proposal. */
  controlSlice?: RelayStreamAlloc;
  maxStreams?: number;
  maxWireBytes?: number;
  maxMetaBytes?: number;
  codecs?: number[];
  /** Per-pump normal work budget (§3.9: a guest submits at most 2). */
  framesPerPump?: number;
  bytesPerPump?: number;
}

export interface RelayPumpResult {
  ok: boolean;
  frames: Uint8Array[];
  code?: RelayP3ErrorCode;
}

/** The ordered send side: bounded per-stream FIFO demand queues, priority
 * band + cross-stream round-robin selection, seq stamped only when a frame
 * is selected after credit is charged. Selected frames leave in selection
 * order and the transport must preserve that order. */
export class RelaySender {
  private ledger: RelayCreditLedger;
  private seq = new RelaySeqSpace();
  private queues = new Map<number, QueuedFrame[]>();
  private rrCursor = new Map<RelayPriority, number>();
  private enqueuedTotal = 0;
  private readonly maxStreams: number;
  private readonly framesPerPump: number;
  private readonly bytesPerPump: number;

  constructor(
    private session: bigint,
    private readonly sideband: RelaySideband,
    private readonly config: RelaySendConfig,
    /** Outbound relay.credit rows fed by the co-located receiver. */
    private readonly creditTable?: RelayCreditTable,
  ) {
    this.maxStreams = config.maxStreams ?? RELAY_LIMITS.maxStreams;
    this.framesPerPump = config.framesPerPump ?? 2;
    this.bytesPerPump = config.bytesPerPump ?? 2 * RELAY_LIMITS.controlMaxWireBytes;
    this.ledger = new RelayCreditLedger(
      config.windowFrames,
      config.windowBytes,
      config.controlSlice ?? {
        frames: Math.max(1, Math.min(RELAY_LIMITS.controlWindowFrames, Math.floor(config.windowFrames / 4))),
        bytes: Math.max(1, Math.min(RELAY_LIMITS.controlWindowBytes, Math.floor(config.windowBytes / 4))),
      },
    );
  }

  /** Wires a fresh session: replacement ledger keeps the configured slices;
   * callers reopen streams afterwards. P3 tests normally construct anew. */
  beginSession(session: bigint, reopen: Array<{ stream: number; slice: RelayStreamAlloc }> = []) {
    this.session = session;
    this.ledger = new RelayCreditLedger(
      this.config.windowFrames,
      this.config.windowBytes,
      this.config.controlSlice ?? {
        frames: Math.max(1, Math.min(RELAY_LIMITS.controlWindowFrames, Math.floor(this.config.windowFrames / 4))),
        bytes: Math.max(1, Math.min(RELAY_LIMITS.controlWindowBytes, Math.floor(this.config.windowBytes / 4))),
      },
    );
    this.seq.reset();
    this.queues.clear();
    this.rrCursor.clear();
    this.enqueuedTotal = 0;
    for (const r of reopen) this.openStream(r.stream, r.slice);
  }

  get sessionId(): bigint {
    return this.session;
  }

  ledgerView(): RelayCreditLedger {
    return this.ledger;
  }

  openStream(stream: number, slice: RelayStreamAlloc): P3Result {
    const active = this.ledger.streamIds().filter(id => id !== 0 && !this.ledger.isDead(id)).length;
    if (active >= this.maxStreams) return { ok: false, code: RELAY_P3_ERROR.STREAM_LIMIT };
    return this.ledger.allocate(stream, slice);
  }

  queuedFrames(stream: number): number {
    return this.queues.get(stream)?.length ?? 0;
  }

  /** Admits one normal business/management frame. Admission requires room
   * for queued + in-flight work inside the stream window (§3.9: the check is
   * queued+new ≤ cap, not just the current backlog), so admitted demand is
   * bounded; BUSY is returned instead of growing an unbounded retry list. */
  admit(
    input: RelayFrameBodyInput & {
      priority?: RelayPriority;
      correlation?: number;
      association?: QueuedFrame["association"];
    },
  ): P3Result {
    if (input.type === RELAY_TYPE.CANCEL) return { ok: false, code: RELAY_P3_ERROR.SIDEBAND_FORBIDDEN };
    if (input.stream === 0 && this.sidebandOnly(input.metadata?.op)) {
      return { ok: false, code: RELAY_P3_ERROR.SIDEBAND_FORBIDDEN };
    }
    if (this.ledger.isDead(input.stream)) return { ok: false, code: RELAY_P3_ERROR.STREAM_DEAD };
    const slice = this.ledger.sliceOf(input.stream);
    if (!slice) return { ok: false, code: RELAY_P3_ERROR.STREAM_LIMIT };

    // Encode-time header rule checked at admission: REQUEST/RESPONSE need a
    // nonzero correlation, PUSH/INVALIDATE carry none. A failure here must
    // never reach pump(), where credit and seq are already committed.
    const correlation = input.correlation ?? 0;
    const correlationRequired = input.type === RELAY_TYPE.REQUEST || input.type === RELAY_TYPE.RESPONSE;
    if (correlationRequired ? correlation === 0 : correlation !== 0) {
      return { ok: false, code: RELAY_P3_ERROR.BAD_CORRELATION };
    }

    const prepared = prepareFrameBody(input, {
      maxWireBytes: this.config.maxWireBytes,
      maxMetaBytes: this.config.maxMetaBytes,
      codecs: this.config.codecs,
    });
    if (!prepared.ok) return { ok: false, code: prepared.code as RelayP3ErrorCode };
    const body = prepared.body;

    const q = this.queues.get(input.stream);
    const queued: RelayStreamAlloc = q
      ? { frames: q.length, bytes: q.reduce((n, f) => n + f.body.wireBytes, 0) }
      : { frames: 0, bytes: 0 };
    const flight = this.ledger.inFlight(input.stream);
    if (flight.frames + queued.frames + 1 > slice.frames
      || flight.bytes + queued.bytes + body.wireBytes > slice.bytes) {
      return { ok: false, code: RELAY_P3_ERROR.BUSY };
    }

    const item: QueuedFrame = {
      body,
      correlation,
      priority: input.priority ?? RELAY_PRIORITY.VISIBLE,
      association: input.association,
      enqueued: this.enqueuedTotal++,
    };
    if (!q) this.queues.set(input.stream, [item]);
    else q.push(item);
    return { ok: true };
  }

  private sidebandOnly(op: unknown): boolean {
    return op === RELAY_OP.CREDIT || op === RELAY_OP.RESET || op === RELAY_OP.PING;
  }

  /** Applies an inbound relay.credit PUSH to the send ledger. */
  applyCredit(meta: { targetStream: number; framesReleased: string; bytesReleased: string }): P3Result {
    return this.ledger.release(
      meta.targetStream,
      BigInt("0x" + meta.framesReleased),
      BigInt("0x" + meta.bytesReleased),
    );
  }

  /** Encodes a CANCEL onto the sideband lane (frame stream 0, correlation =
   * the original request id, metadata.targetStream locates it). The reason
   * clips at 64 UTF-8 bytes. No request slot or wire credit is released. */
  cancel(targetStream: number, correlation: number, reason: string): P3Result {
    const prepared = prepareFrameBody({
      type: RELAY_TYPE.CANCEL,
      stream: 0,
      metadata: {
        op: RELAY_OP.REQUEST_CANCEL,
        targetStream,
        reason: clipUtf8Bytes(reason, RELAY_LIMITS.cancelReasonMaxBytes),
      },
    }, { maxWireBytes: RELAY_LIMITS.sidebandSlotBytes });
    if (!prepared.ok) return { ok: false, code: prepared.code as RelayP3ErrorCode };
    return this.sideband.admit(prepared.body, correlation);
  }

  /** Queues a relay.ping response (pong) on the sideband; the token is
   * echoed and the response correlation points at the ping request. */
  sendPong(correlation: number, token: number): P3Result {
    const prepared = prepareFrameBody({
      type: RELAY_TYPE.RESPONSE,
      stream: 0,
      metadata: { op: RELAY_OP.PING, status: "ok", final: true, token },
    }, { maxWireBytes: RELAY_LIMITS.sidebandSlotBytes });
    if (!prepared.ok) return { ok: false, code: prepared.code as RelayP3ErrorCode };
    return this.sideband.admit(prepared.body, correlation);
  }
  /** Queues a relay.reset PUSH on the sideband: every old request and
   * subscription on targetStream fails; its id is never reused. */
  sendReset(targetStream: number, reason: string): P3Result {
    const prepared = prepareFrameBody({
      type: RELAY_TYPE.PUSH,
      stream: 0,
      metadata: {
        op: RELAY_OP.RESET,
        targetStream,
        reason: clipUtf8Bytes(reason, RELAY_LIMITS.cancelReasonMaxBytes),
      },
    }, { maxWireBytes: RELAY_LIMITS.sidebandSlotBytes });
    if (!prepared.ok) return { ok: false, code: prepared.code as RelayP3ErrorCode };
    return this.sideband.admit(prepared.body, 0);
  }

  /** Queues a relay.ping request on the sideband; correlation is a u32 >0
   * allocated by the caller (control correlation space), token echoed. */
  sendPing(correlation: number, token: number): P3Result {
    const prepared = prepareFrameBody({
      type: RELAY_TYPE.REQUEST,
      stream: 0,
      metadata: { op: RELAY_OP.PING, token },
    }, { maxWireBytes: RELAY_LIMITS.sidebandSlotBytes });
    if (!prepared.ok) return { ok: false, code: prepared.code as RelayP3ErrorCode };
    return this.sideband.admit(prepared.body, correlation);
  }

  /** One pump: outbound credit merges into the sideband first, the sideband
   * drains (it relieves queue-capacity deadlock and is selected before
   * normal work), then normal frames leave by priority band and round-robin
   * across streams, at most framesPerPump/bytesPerPump. Frames within one
   * stream leave FIFO, so that stream's seq order is never reordered. */
  pump(): RelayPumpResult {
    const frames: Uint8Array[] = [];

    if (this.creditTable) {
      for (const row of this.creditTable.takeDirty()) {
        const admitted = this.sideband.admit(row.body, 0);
        if (admitted.ok) this.creditTable.clearDirty([row.stream]);
        // A full lane leaves the row dirty; retry on a later pump.
      }
    }

    const control = this.sideband.drain(this.session, (s) => this.seq.allocate(s));
    if (control.code) return { ok: false, frames: [...frames, ...control.frames], code: control.code };
    frames.push(...control.frames);

    let usedFrames = 0;
    let usedBytes = 0;
    while (usedFrames < this.framesPerPump && usedBytes < this.bytesPerPump) {
      const pick = this.peekHead();
      if (!pick) break;
      const { stream, item } = pick;
      // §3.3: seq never wraps; a stream near u32 exhaustion must be reopened
      // before selection, so this check precedes the credit charge.
      if (this.seq.last(stream) >= 0xffffffff) {
        return { ok: false, frames, code: RELAY_P3_ERROR.SEQ_EXHAUSTED };
      }
      // §3.3/§3.9: credit is granted first; seq exists only once the frame
      // passed the window check. The dequeue commits both atomically.
      const charged = this.ledger.charge(stream, item.body.wireBytes);
      if (!charged.ok) return { ok: false, frames, code: charged.code };
      const seq = this.seq.allocate(stream);
      if (!seq.ok) return { ok: false, frames, code: seq.code };
      this.dequeue(stream);
      const enc = encodePreparedFrame(item.body, {
        session: this.session,
        seq: seq.seq,
        correlation: item.correlation,
      });
      if (!enc.ok) return { ok: false, frames, code: enc.code as RelayP3ErrorCode };
      frames.push(enc.bytes);
      usedFrames++;
      usedBytes += item.body.wireBytes;
      this.rrCursor.set(item.priority, stream);
    }
    return { ok: true, frames };
  }

  /** Priority band, then round-robin by stream inside the band, then FIFO
   * within a stream. Heads whose byte credit cannot cover their frame are
   * skipped, so a large blocked frame does not stall smaller frames on
   * other streams; the blocked head keeps its stream's FIFO position. The
   * chosen item stays queued until the caller commits (seq + charge). */
  private peekHead(): { stream: number; item: QueuedFrame } | undefined {
    for (let band = RELAY_PRIORITY.CONTROL; band <= RELAY_PRIORITY.PREFETCH; band++) {
      const candidates: Array<{ stream: number; item: QueuedFrame }> = [];
      for (const [stream, q] of this.queues) {
        const head = q[0];
        if (head && head.priority === band) candidates.push({ stream, item: head });
      }
      if (candidates.length === 0) continue;
      candidates.sort((a, b) => this.rrDistance(a.stream, band) - this.rrDistance(b.stream, band)
        || a.stream - b.stream);
      for (const c of candidates) {
        const room = this.ledger.available(c.stream);
        if (room.frames >= 1 && room.bytes >= c.item.body.wireBytes) return c;
      }
    }
    return undefined;
  }

  private dequeue(stream: number) {
    const q = this.queues.get(stream);
    if (!q) return;
    q.shift();
    if (q.length === 0) this.queues.delete(stream);
  }

  /** Distance on the u32 id ring: the number of live streams does not
   * constrain their ids. A stream just served is visited last. */
  private rrDistance(stream: number, band: RelayPriority): number {
    const cursor = this.rrCursor.get(band);
    if (cursor === undefined) return stream;
    const mod = 0x1_0000_0000;
    return (stream - cursor - 1 + mod) % mod;
  }

  /** relay.reset (locally originated or applied from inbound): every queued
   * association on the stream fails, the queue and seq state clear, and the
   * stream id can never be reopened. Wire slots in flight still settle via
   * credit. Returns failed associations so the caller resolves callers. */
  applyReset(stream: number): Array<{ kind: "correlation" | "subscription"; id: number }> {
    const failed: Array<{ kind: "correlation" | "subscription"; id: number }> = [];
    const q = this.queues.get(stream);
    if (q) {
      for (const f of q) if (f.association) failed.push(f.association);
      this.queues.delete(stream);
    }
    this.ledger.markDead(stream);
    this.seq.drop(stream);
    return failed;
  }

  /** Composition calls this after resetting both send and receive state. */
  forgetStream(stream: number): void { this.ledger.forgetStream(stream); }
}

// --- bounded receive queue ------------------------------------------------------

export interface RelayReceived {
  frame: RelayDecodedFrame;
  handle: string;
  wireBytes: number;
  stream: number;
  seq: number;
}

interface HeldFrame {
  frame: RelayDecodedFrame;
  wireBytes: number;
  association?: { kind: "correlation" | "subscription"; id: number };
}

/** Receive side for one direction: contiguous-seq staging bounded by the
 * granted per-stream window, plus a §3.9 reserved inbound sideband lane.
 *
 * A frame past the normal window is a peer protocol error (the adapter is
 * required to hold every granted frame), never a silent drop; the transport
 * applies backpressure by stopping reads while staging is full (compare
 * hosts/3ds/src/offload.c, which leaves a full incoming queue in the ready
 * state and reads nothing). Seq holes/repeats stop the stream (stream 0
 * kills the session). Normal frames leave staging through pump() and keep
 * occupying window until release(), the only point at which wire credit
 * returns.
 *
 * Whitelisted stream-0 records (relay.credit, ping/pong, relay.reset,
 * CANCEL) use the separate two-slot / 256-byte inbound lane: they advance
 * the same stream-0 seq as ordinary stream-0 management frames, but occupy
 * no normal window and earn no credit. The transport classifies a decoded
 * record with isSidebandFrame(), gates reads on canIngestSideband(), and
 * takes delivered controls from pumpSideband(). A record past the reserved
 * capacity is a stream-0 protocol error (§3.9: the adapter must hold every
 * granted sideband record). */
export class RelayReceiver {
  private held = new Map<number, HeldFrame[]>();
  private outstanding = new Map<string, HeldFrame & { stream: number; seq: number }>();
  private expected = new Map<number, number>();
  /** Window occupancy per stream: staged frames plus delivered frames not
   * yet released. A frame occupies its granted slot from ingest until
   * release/reset; late drops never enter this count. Sideband frames are
   * never counted here. */
  private occ = new Map<number, RelayStreamAlloc>();
  /** Inbound reserved lane (§3.9: two 256-byte slots per direction). */
  private sideHeld: HeldFrame[] = [];
  private sideBytes = 0;
  private dead = new Set<number>();
  private stopped = new Set<number>();
  private finishedAssoc = new Set<string>();
  private rr = 0;
  sessionFatal = false;

  constructor(
    private session: bigint,
    private allocations: ReadonlyMap<number, RelayStreamAlloc>,
    private readonly creditTable: RelayCreditTable,
    private readonly maxStreams: number = RELAY_LIMITS.maxStreams,
    private readonly deliveryPerPump: number = 1,
    private readonly sideSlots: number = RELAY_LIMITS.sidebandSlots,
    private readonly sideSlotBytes: number = RELAY_LIMITS.sidebandSlotBytes,
  ) {}

  beginSession(session: bigint, allocations: ReadonlyMap<number, RelayStreamAlloc>) {
    this.session = session;
    this.allocations = allocations;
    this.held.clear();
    this.outstanding.clear();
    this.expected.clear();
    this.occ.clear();
    this.sideHeld = [];
    this.sideBytes = 0;
    this.dead.clear();
    this.stopped.clear();
    this.finishedAssoc.clear();
    this.sessionFatal = false;
    this.rr = 0;
  }

  /** Marks an association finished (one terminal response consumed, or
   * resource.unsubscribe). Later frames keyed to it still pass seq and
   * window accounting, then drop with credit returned (§3.6 late chunks). */
  markFinished(kind: "correlation" | "subscription", id: number) {
    this.finishedAssoc.add(`${kind}:${id}`);
  }

  isFinished(kind: "correlation" | "subscription", id: number): boolean {
    return this.finishedAssoc.has(`${kind}:${id}`);
  }

  /** Total window occupancy (staged plus delivered-unreleased) across all
   * streams. The transport gates recv on the per-stream value via
   * canIngest and stops reading at the cap. */
  occupancy(): RelayStreamAlloc {
    let frames = 0;
    let bytes = 0;
    for (const v of this.occ.values()) {
      frames += v.frames;
      bytes += v.bytes;
    }
    return { frames, bytes };
  }

  occupancyStream(stream: number): RelayStreamAlloc {
    return this.occ.get(stream) ?? { frames: 0, bytes: 0 };
  }

  /** True while one more record of wireBytes stays inside the stream's
   * granted window. The transport calls this before recv; false means stop
   * reading (backpressure), never discard the next frame. Records
   * isSidebandFrame() classifies as sideband are gated on
   * canIngestSideband instead, so a full normal control slice does not
   * block the reserved lane. */
  canIngest(stream: number, wireBytes: number): boolean {
    const cap = this.allocations.get(stream);
    if (!cap || this.dead.has(stream) || this.stopped.has(stream)) return false;
    const use = this.occ.get(stream) ?? { frames: 0, bytes: 0 };
    return use.frames + 1 <= cap.frames && use.bytes + wireBytes <= cap.bytes;
  }

  /** Staged occupancy of the inbound reserved lane. */
  sidebandOccupancy(): RelayStreamAlloc {
    return { frames: this.sideHeld.length, bytes: this.sideBytes };
  }

  /** Classifies the next whitelisted record of wireBytes for the transport
   * (review 1070 M4). "stage": it fits the lane now. "wait": both reserved
   * slots are held; stop reading until pumpSideband() frees one. "fatal":
   * no wait can help, because the record is over the 256-byte slot or
   * stream 0 is dead; ingestSideband() answers SESSION_FATAL for it, which
   * is how the transport reaches the teardown decision. */
  sidebandAdmission(wireBytes: number): "stage" | "wait" | "fatal" {
    if (this.sessionFatal || wireBytes > this.sideSlotBytes) return "fatal";
    if (this.sideHeld.length >= this.sideSlots
      || this.sideBytes + wireBytes > this.sideSlots * this.sideSlotBytes) {
      return "wait";
    }
    return "stage";
  }

  /** True when the transport reads the next whitelisted record now: it fits
   * the reserved lane (two 256-byte slots), or it can never fit and
   * ingestSideband() ends the session with it. False only while both slots
   * are held (backpressure) or after a stream-0 fatal closed the lane.
   * Independent of the normal stream-0 slice: the lane stays readable while
   * both normal control slots are held. */
  canIngestSideband(wireBytes: number): boolean {
    if (this.sessionFatal) return false;
    return this.sidebandAdmission(wireBytes) !== "wait";
  }

  /** Ingests one decoded record classified by isSidebandFrame(). The
   * record advances the same stream-0 seq expectation as ordinary
   * stream-0 management frames, occupies no normal window and earns no
   * credit. A non-whitelisted record is SIDEBAND_FORBIDDEN; a record past
   * the reserved capacity or over 256 bytes is a stream-0 protocol error
   * (§3.9: the adapter must hold every granted sideband record). */
  ingestSideband(frame: RelayDecodedFrame, recordLength: number): P3Result {
    if (frame.session !== this.session || this.sessionFatal) {
      return { ok: false, code: RELAY_P3_ERROR.SESSION_FATAL };
    }
    if (frame.stream !== 0 || !isSidebandFrame(frame)) {
      return { ok: false, code: RELAY_P3_ERROR.SIDEBAND_FORBIDDEN };
    }
    if (recordLength > this.sideSlotBytes
      || this.sideHeld.length >= this.sideSlots
      || this.sideBytes + recordLength > this.sideSlots * this.sideSlotBytes) {
      this.sessionFatal = true;
      return { ok: false, code: RELAY_P3_ERROR.SESSION_FATAL };
    }
    // Stream-0 seq is shared with the normal lane: a hole or repeat ends
    // the session, whether the record rode the lane or the slice.
    const want = this.expected.get(0) ?? 1;
    if (frame.seq !== want) {
      this.sessionFatal = true;
      return { ok: false, code: RELAY_P3_ERROR.SESSION_FATAL };
    }
    this.expected.set(0, frame.seq >= 0xffffffff ? 0xffffffff : frame.seq + 1);
    this.sideHeld.push({ frame, wireBytes: recordLength });
    this.sideBytes += recordLength;
    return { ok: true };
  }

  /** Ingests one decoded record. `recordLength` is the full wire length
   * (frameBytes+4); the caller already ran the frame codec. */
  ingest(
    frame: RelayDecodedFrame,
    recordLength: number,
    association?: { kind: "correlation" | "subscription"; id: number },
  ): P3Result<{ late: boolean }> {
    // A stream-0 violation ends the attachment: nothing ingests afterwards.
    if (frame.session !== this.session || this.sessionFatal) return { ok: false, code: RELAY_P3_ERROR.SESSION_FATAL };
    const { stream, seq } = frame;
    if (!this.allocations.has(stream) || this.allocations.size > this.maxStreams + 1) {
      return { ok: false, code: RELAY_P3_ERROR.STREAM_LIMIT };
    }
    // A whitelisted stream-0 record belongs on ingestSideband; routing it
    // through the normal path would charge the control slice it must not
    // use. This is a local dispatch error, not a peer fault.
    if (stream === 0 && isSidebandFrame(frame)) {
      return { ok: false, code: RELAY_P3_ERROR.SIDEBAND_FORBIDDEN };
    }
    if (this.stopped.has(stream)) {
      return { ok: false, code: stream === 0 ? RELAY_P3_ERROR.SESSION_FATAL : RELAY_P3_ERROR.SEQ_GAP };
    }

    // Abandoned stream after relay.reset: the id never reopens and no seq
    // expectation remains. Late frames still unwind the peer window: credit
    // returns immediately and the frame drops without staging.
    if (this.dead.has(stream)) {
      const noted = this.creditTable.note(stream, 1, recordLength);
      return noted.ok ? { ok: true as const, late: true } : noted;
    }

    const use = this.occ.get(stream) ?? { frames: 0, bytes: 0 };
    const cap = this.allocations.get(stream)!;
    if (use.frames + 1 > cap.frames || use.bytes + recordLength > cap.bytes) {
      // §3.9: the adapter must hold every frame covered by granted credit.
      if (stream === 0) this.sessionFatal = true;
      return { ok: false, code: stream === 0 ? RELAY_P3_ERROR.SESSION_FATAL : RELAY_P3_ERROR.WINDOW_OVERFLOW };
    }

    // Seq accounting runs before the late-association drop, so late chunks
    // are still gap-checked.
    const want = this.expected.get(stream) ?? 1;
    if (seq !== want) {
      if (stream === 0) {
        this.sessionFatal = true;
        return { ok: false, code: RELAY_P3_ERROR.SESSION_FATAL };
      }
      this.stopped.add(stream);
      return { ok: false, code: RELAY_P3_ERROR.SEQ_GAP };
    }
    this.expected.set(stream, seq >= 0xffffffff ? 0xffffffff : seq + 1);

    // CANCEL-finished association: late chunks pass seq/credit accounting
    // and never reach the UI (§3.6). Window credit returns immediately.
    if (association !== undefined && this.finishedAssoc.has(`${association.kind}:${association.id}`)) {
      const noted = this.creditTable.note(stream, 1, recordLength);
      return noted.ok ? { ok: true as const, late: true } : noted;
    }

    const q = this.held.get(stream) ?? [];
    q.push({ frame, wireBytes: recordLength, association });
    this.held.set(stream, q);
    this.occ.set(stream, { frames: use.frames + 1, bytes: use.bytes + recordLength });
    return { ok: true, late: false };
  }

  /** Delivers up to deliveryPerPump staged frames, round-robin across
   * streams (§3.9: guest delivery ≤ 1 per frame by default). Delivered
   * frames keep occupying window until release(); the pump never drains a
   * stream's whole backlog in one turn. */
  pump(): RelayReceived[] {
    const out: RelayReceived[] = [];
    // After a stream-0 fatal the attachment cannot continue: staged frames
    // are not delivered (review 1070 M5).
    if (this.sessionFatal) return out;
    const streams = [...this.held.entries()]
      .filter(([, q]) => q.length > 0)
      .map(([stream]) => stream)
      .sort((a, b) => this.distance(a) - this.distance(b) || a - b);
    for (const stream of streams) {
      if (out.length >= this.deliveryPerPump) break;
      const q = this.held.get(stream)!;
      const held = q.shift()!;
      if (q.length === 0) this.held.delete(stream);
      const handle = `${stream}:${held.frame.seq}`;
      this.outstanding.set(handle, { ...held, stream, seq: held.frame.seq });
      out.push({ frame: held.frame, handle, wireBytes: held.wireBytes, stream, seq: held.frame.seq });
      this.rr = stream;
    }
    return out;
  }

  private distance(stream: number): number {
    return stream > this.rr ? stream - this.rr : stream + 0x1_0000_0000 - this.rr;
  }

  /** Delivers staged sideband controls in FIFO order. These frames occupy
   * no normal window, so no handle/release cycle exists: taking one frees
   * its reserved slot at once and earns no credit. The session layer runs
   * the side effect (apply relay.credit, answer a ping, apply reset,
   * dispatch CANCEL). The caller processes every returned frame; the lane
   * budget is the worker-turn bound (§3.9: at most two per turn). */
  pumpSideband(maxFrames = this.sideSlots): RelayReceived[] {
    const out: RelayReceived[] = [];
    if (this.sessionFatal) return out;
    const n = Math.min(maxFrames, this.sideHeld.length);
    for (let i = 0; i < n; i++) {
      const held = this.sideHeld.shift()!;
      this.sideBytes -= held.wireBytes;
      out.push({
        frame: held.frame,
        handle: `side:0:${held.frame.seq}`,
        wireBytes: held.wireBytes,
        stream: 0,
        seq: held.frame.seq,
      });
    }
    return out;
  }

  /** Staging releases after the frame is consumed or moved into a reserved
   * bounded assembler/result mailbox; that is the only point wire credit
   * returns (§3.9). */
  release(handle: string): P3Result<{ stream: number; wireBytes: number }> {
    const held = this.outstanding.get(handle);
    if (!held) return { ok: false, code: RELAY_P3_ERROR.UNKNOWN_REQUEST };
    this.outstanding.delete(handle);
    const use = this.occ.get(held.stream) ?? { frames: 0, bytes: 0 };
    this.occ.set(held.stream, { frames: use.frames - 1, bytes: use.bytes - held.wireBytes });
    const noted = this.creditTable.note(held.stream, 1, held.wireBytes);
    if (!noted.ok) return noted;
    return { ok: true, stream: held.stream, wireBytes: held.wireBytes };
  }

  /** relay.reset on receive: staging and outstanding frames for the stream
   * discard and return credit so the peer's window unwinds; old requests
   * and subscriptions fail and their session state releases. Frames that
   * arrive afterwards drop as dead-stream late frames. New work needs a new
   * stream id. */
  applyReset(stream: number, reason: string): P3Result<{ failed: number; reason: string }> {
    if (!this.allocations.has(stream)) return { ok: false, code: RELAY_P3_ERROR.STREAM_LIMIT };
    let failed = 0;
    const credit = (wireBytes: number): P3Result => {
      const noted = this.creditTable.note(stream, 1, wireBytes);
      if (!noted.ok) return noted;
      failed++;
      return { ok: true };
    };
    const q = this.held.get(stream) ?? [];
    for (const h of q) {
      const r = credit(h.wireBytes);
      if (!r.ok) return r;
    }
    this.held.delete(stream);
    for (const [handle, h] of [...this.outstanding.entries()]) {
      if (h.stream !== stream) continue;
      const r = credit(h.wireBytes);
      if (!r.ok) return r;
      this.outstanding.delete(handle);
    }
    this.occ.set(stream, { frames: 0, bytes: 0 });
    this.expected.delete(stream);
    this.stopped.delete(stream);
    this.dead.add(stream);
    if (stream === 0) {
      // Stream 0 ends the attachment: the reserved lane staging is
      // discarded and undelivered controls earn no credit.
      this.sideHeld = [];
      this.sideBytes = 0;
      this.sessionFatal = true;
    }
    return { ok: true, failed, reason };
  }

  /** L1 has removed the binding and drops late records before seq checks.
   * Release the receiver's tombstone and empty occupancy row as well. */
  forgetStream(stream: number): void {
    if (stream === 0) return;
    this.dead.delete(stream);
    this.occ.delete(stream);
    this.expected.delete(stream);
    this.stopped.delete(stream);
  }
}

// --- request/admission table ----------------------------------------------------

export interface RelayRequestState {
  stream: number;
  correlation: number;
  subscription?: number;
  cancelRequested: boolean;
  terminal?: { status: string; final: boolean; errorCode?: string; effect?: string };
  terminalConsumed: boolean;
}

/** Session-scoped table of originated requests (reused provider-side for
 * accepted work). maxPending=8 is a capacity separate from the wire
 * window. A slot is held from admission until the one terminal response is
 * consumed, or reset/session end — CANCEL and local timeout do not release
 * it (§3.6/§3.9). */
export class RelayRequestTable {
  private byId = new Map<number, RelayRequestState>();
  /** Correlation allocates once per session across all streams (§3.6). */
  private nextCorrelation = 1;

  constructor(private readonly maxPending: number = RELAY_LIMITS.maxPending) {}

  /** Number of slots whose terminal has not been consumed. */
  get active(): number {
    let n = 0;
    for (const s of this.byId.values()) if (!s.terminalConsumed) n++;
    return n;
  }

  /** Reserves a new correlation and its pending slot. `reserve` keeps
   * capacity for input/control as §3.9 recommends. */
  admit(stream: number, reserve = 0): P3Result<{ correlation: number }> {
    if (this.active + 1 > this.maxPending - reserve) return { ok: false, code: RELAY_P3_ERROR.PENDING_FULL };
    if (this.nextCorrelation > 0xffffffff) return { ok: false, code: RELAY_P3_ERROR.SEQ_EXHAUSTED };
    const correlation = this.nextCorrelation++;
    this.byId.set(correlation, { stream, correlation, cancelRequested: false, terminalConsumed: false });
    return { ok: true, correlation };
  }

  /** Registers a correlation allocated elsewhere: the provider registers
   * the peer's request ids, and the composed guest draws its ids from the
   * session's one correlation space. `reserve` keeps slots for
   * input/control as in admit(). */
  admitKnown(stream: number, correlation: number, reserve = 0): P3Result {
    if (this.byId.has(correlation)) return { ok: false, code: RELAY_P3_ERROR.PENDING_FULL };
    if (this.active + 1 > this.maxPending - reserve) return { ok: false, code: RELAY_P3_ERROR.PENDING_FULL };
    this.byId.set(correlation, { stream, correlation, cancelRequested: false, terminalConsumed: false });
    return { ok: true };
  }

  /** Releases a slot whose REQUEST never entered the send queue: no frame
   * left, so no terminal will come. The correlation stays consumed (§3.6:
   * ids do not repeat within a session). A slot with a recorded terminal is
   * not abandonable. */
  abandon(correlation: number): boolean {
    const s = this.byId.get(correlation);
    if (!s || s.terminal) return false;
    this.byId.delete(correlation);
    return true;
  }

  get(correlation: number): RelayRequestState | undefined {
    return this.byId.get(correlation);
  }

  /** Originator-side: withdraw interest. Releases no slot and produces no
  terminal. A repeat after the terminal was consumed is a no-op. */
  cancel(correlation: number): P3Result {
    const s = this.byId.get(correlation);
    if (!s) return { ok: false, code: RELAY_P3_ERROR.UNKNOWN_REQUEST };
    if (s.terminalConsumed) return { ok: true };
    s.cancelRequested = true;
    return { ok: true };
  }

  /** Records a terminal RESPONSE. Exactly one is accepted per request: a
   * repeat returns ALREADY_TERMINAL so the peer neither delivers twice nor
   * frees a second slot. Non-final responses pass without recording. */
  terminal(
    correlation: number,
    t: { status: string; final: boolean; errorCode?: string; effect?: string },
  ): P3Result<{ first: boolean }> {
    const s = this.byId.get(correlation);
    if (!s) return { ok: false, code: RELAY_P3_ERROR.UNKNOWN_REQUEST };
    if (!t.final) return { ok: true, first: false };
    if (s.terminal) return { ok: false, code: RELAY_P3_ERROR.ALREADY_TERMINAL };
    s.terminal = { ...t };
    return { ok: true, first: true };
  }

  /** Consumes the terminal at delivery: the only moment the pending slot
   * returns. CANCELLED is guaranteed uncommitted only with effect=none. */
  consumeTerminal(correlation: number): P3Result<{ state: RelayRequestState }> {
    const s = this.byId.get(correlation);
    if (!s?.terminal) return { ok: false, code: RELAY_P3_ERROR.UNKNOWN_REQUEST };
    if (s.terminal.errorCode === RELAY_ERROR.CANCELLED
      && s.terminal.effect !== RELAY_EFFECT.NONE
      && s.terminal.effect !== RELAY_EFFECT.COMMITTED
      && s.terminal.effect !== RELAY_EFFECT.UNKNOWN) {
      return { ok: false, code: RELAY_P3_ERROR.BAD_TERMINAL };
    }
    s.terminalConsumed = true;
    this.byId.delete(correlation);
    return { ok: true, state: s };
  }

  /** reset: every open request/subscription on the stream fails and its
   * session state releases. Returns the failed states. */
  failStream(stream: number): RelayRequestState[] {
    const failed: RelayRequestState[] = [];
    for (const [id, s] of this.byId) {
      if (s.stream === stream && !s.terminalConsumed) {
        s.terminalConsumed = true;
        failed.push(s);
        this.byId.delete(id);
      }
    }
    return failed;
  }
}
