import { expect, test } from "bun:test";
import { rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import {
  RELAY_EFFECT,
  RELAY_ERROR,
  RELAY_LIMITS,
  RELAY_OP,
  RELAY_TYPE,
} from "../contracts/spec/relay.ts";
import {
  RELAY_FRAME_ERROR,
  decodeFrame,
  encodePreparedFrame,
  prepareFrameBody,
  type RelayDecodedFrame,
} from "../framework/src/relay/frame.ts";
import {
  RELAY_P3_ERROR,
  RELAY_PRIORITY,
  RelayCreditLedger,
  RelayCreditTable,
  RelayReceiver,
  RelayRequestTable,
  RelaySender,
  RelaySideband,
  clipUtf8Bytes,
  isSidebandFrame,
  type RelayPriority,
  type RelayReceived,
  type RelayStreamAlloc,
} from "../framework/src/relay/credit.ts";

// R5 §3.9 proposal numbers (contracts/spec/relay.ts RELAY_LIMITS).
const ATTACH = { frames: RELAY_LIMITS.controlWindowFrames, bytes: RELAY_LIMITS.controlWindowBytes };
const SESSION = 0x0102030405060708n;

// Minimal legal REQUEST metadata; slice math uses its real encoded wire size.
const GET_META = {
  op: "resource.get",
  resource: { kind: 1, ns: "ns", key: "k", rendition: "r" },
};
const GET_WIRE = (() => {
  const p = prepareFrameBody({ type: RELAY_TYPE.REQUEST, stream: 1, metadata: GET_META });
  if (!p.ok) throw new Error(p.code);
  return p.body.wireBytes;
})();

const controlSlice = () => ({ frames: 2, bytes: 2 * RELAY_LIMITS.controlMaxWireBytes });

/** Builds a complete wire record for receive-side tests. */
function wireRecord(
  stream: number,
  seq: number,
  correlation: number,
  metadata: Record<string, unknown>,
  type: number = RELAY_TYPE.REQUEST,
): Uint8Array {
  const body = prepareFrameBody({ type, stream, metadata }, { maxWireBytes: 65536 });
  if (!body.ok) throw new Error(body.code);
  const enc = encodePreparedFrame(body.body, { session: SESSION, seq, correlation });
  if (!enc.ok) throw new Error(enc.code);
  return enc.bytes;
}

/** One endpoint: sender on its own send ledger/window, receiver on the
 * matching granted slices, and a credit table that turns releases into
 * outbound relay.credit sideband frames. */
class Endpoint {
  sideband = new RelaySideband();
  creditTable = new RelayCreditTable();
  sender: RelaySender;
  receiver: RelayReceiver;
  requests = new RelayRequestTable();
  slices = new Map<number, { frames: number; bytes: number }>();

  constructor(
    session: bigint,
    streamSlices: Array<{ stream: number; slice: { frames: number; bytes: number } }>,
    opts: { framesPerPump?: number; deliveryPerPump?: number } = {},
  ) {
    this.sender = new RelaySender(session, this.sideband, {
      windowFrames: ATTACH.frames,
      windowBytes: ATTACH.bytes,
      controlSlice: controlSlice(),
      maxWireBytes: RELAY_LIMITS.controlMaxWireBytes,
      framesPerPump: opts.framesPerPump ?? ATTACH.frames,
      bytesPerPump: ATTACH.bytes,
    }, this.creditTable);
    this.slices.set(0, controlSlice());
    for (const { stream, slice } of streamSlices) {
      const opened = this.sender.openStream(stream, slice);
      if (!opened.ok) throw new Error(opened.code);
      this.slices.set(stream, slice);
    }
    this.receiver = new RelayReceiver(
      session, this.slices, this.creditTable, RELAY_LIMITS.maxStreams, opts.deliveryPerPump ?? 1,
    );
  }
}

/** Moves A's pumped frames to B. Whitelisted stream-0 records (credit,
 * ping/pong, reset, CANCEL) cross B's inbound reserved sideband lane: they
 * pass canIngestSideband/ingestSideband, come out pumpSideband, occupy no
 * normal window and earn no credit. relay.credit is applied on arrival;
 * other controls are handed back for the caller to assert. Normal frames
 * ingest against the granted slices and one per pump round delivers. */
function transport(from: Endpoint, to: Endpoint): string[] {
  const pumped = from.sender.pump();
  if (!pumped.ok) throw new Error(pumped.code);
  for (const bytes of pumped.frames) {
    const dec = decodeFrame(bytes);
    if (!dec.ok) throw new Error(dec.code);
    const f = dec.frame;
    if (isSidebandFrame(f)) {
      if (!to.receiver.canIngestSideband(bytes.length)) throw new Error("sideband lane full");
      const sideIn = to.receiver.ingestSideband(f, bytes.length);
      if (!sideIn.ok) throw new Error(sideIn.code);
      // Reserved lane traffic never touches the normal control slice.
      expect(to.receiver.occupancyStream(0)).toEqual({ frames: 0, bytes: 0 });
      const [control] = to.receiver.pumpSideband();
      expect(control?.seq).toBe(f.seq);
      if (f.type === RELAY_TYPE.PUSH && f.metadata.op === RELAY_OP.CREDIT) {
        const applied = to.sender.applyCredit({
          targetStream: f.metadata.targetStream as number,
          framesReleased: f.metadata.framesReleased as string,
          bytesReleased: f.metadata.bytesReleased as string,
        });
        if (!applied.ok) throw new Error(applied.code);
      }
      continue;
    }
    const ingested = to.receiver.ingest(f, bytes.length);
    if (!ingested.ok) throw new Error(ingested.code);
  }
  return to.receiver.pump().map((r) => r.handle);
}

// ---------------------------------------------------------------------------
// Step 1 — ledger, cumulative credit, sideband whitelist
// ---------------------------------------------------------------------------

test("credit ledger: charge only inside the per-stream slice; relay.credit is cumulative and bounded by sent", () => {
  const ledger = new RelayCreditLedger(ATTACH.frames, ATTACH.bytes, controlSlice());
  expect(ledger.allocate(1, { frames: 2, bytes: 8192 }).ok).toBe(true);
  expect(ledger.allocate(2, { frames: 4, bytes: 8192 }).ok).toBe(true);
  // control 2 + stream1 2 + stream2 4 = 8 frames; one more slice rejects.
  expect(ledger.allocate(3, { frames: 1, bytes: 1 }).code).toBe(RELAY_P3_ERROR.STREAM_LIMIT);

  expect(ledger.charge(1, 4096).ok).toBe(true);
  expect(ledger.charge(1, 4096).ok).toBe(true);
  const third = ledger.charge(1, 4096);
  expect(third.ok).toBe(false);
  expect(third.code).toBe(RELAY_P3_ERROR.BUSY);
  expect(ledger.inFlight(1)).toEqual({ frames: 2, bytes: 8192 });

  // Byte bound trips before the frame bound on an oversized frame.
  expect(ledger.charge(2, 8193).code).toBe(RELAY_P3_ERROR.BUSY);

  // Cumulative release of one frame frees one slot.
  expect(ledger.release(1, 1n, 4096n).ok).toBe(true);
  expect(ledger.inFlight(1)).toEqual({ frames: 1, bytes: 4096 });
  // Repeating the same cumulative values is a no-op.
  expect(ledger.release(1, 1n, 4096n).ok).toBe(true);
  expect(ledger.inFlight(1)).toEqual({ frames: 1, bytes: 4096 });
  // Counvers must not move backwards.
  expect(ledger.release(1, 0n, 0n).code).toBe(RELAY_P3_ERROR.CREDIT_RANGE);
  // Counters must not exceed what this side sent.
  expect(ledger.release(1, 9n, 8192n).code).toBe(RELAY_P3_ERROR.CREDIT_RANGE);
  expect(ledger.release(1, 2n, 9999n).code).toBe(RELAY_P3_ERROR.CREDIT_RANGE);
});

test("credit ledger: per-stream slices never sum past the attachment window; reset ids never reopen", () => {
  const ledger = new RelayCreditLedger(ATTACH.frames, ATTACH.bytes, controlSlice());
  expect(ledger.allocate(1, { frames: 6, bytes: 24576 }).ok).toBe(true);
  // control 2 + 6 = 8 frames / 32768 bytes; nothing more fits.
  expect(ledger.allocate(2, { frames: 1, bytes: 1 }).code).toBe(RELAY_P3_ERROR.STREAM_LIMIT);
  ledger.markDead(1);
  expect(ledger.isDead(1)).toBe(true);
  expect(ledger.allocate(1, { frames: 1, bytes: 1 }).code).toBe(RELAY_P3_ERROR.STREAM_LIMIT);
});

test("sender and receiver rotate sparse stream ids above eight without growing the live window", () => {
  const ids = [1, 257, 65535];
  const ep = new Endpoint(SESSION, ids.map(stream => ({ stream, slice: { frames: 2, bytes: 8192 } })), { framesPerPump: 6 });
  for (const stream of ids) for (const correlation of [1, 2]) {
    expect(ep.sender.admit({ type: RELAY_TYPE.REQUEST, stream, correlation, metadata: GET_META }).ok).toBe(true);
  }
  const frames = ep.sender.pump().frames;
  expect(frames.map(bytes => {
    const decoded = decodeFrame(bytes);
    if (!decoded.ok) throw new Error(decoded.code);
    expect(ep.receiver.ingest(decoded.frame, bytes.length).ok).toBe(true);
    return decoded.frame.stream;
  })).toEqual([...ids, ...ids]);
  const received: number[] = [];
  for (let i = 0; i < 6; i++) {
    const [frame] = ep.receiver.pump();
    received.push(frame.stream);
    expect(ep.receiver.release(frame.handle).ok).toBe(true);
  }
  expect(received).toEqual([...ids, ...ids]);
  expect(ep.receiver.occupancy()).toEqual({ frames: 0, bytes: 0 });
  const sender = new RelaySender(SESSION, new RelaySideband(), {
    windowFrames: 20, windowBytes: 10000, controlSlice: { frames: 1, bytes: 1000 }, maxWireBytes: 1000, maxStreams: 2,
  });
  expect(sender.openStream(9, { frames: 1, bytes: 1000 }).ok).toBe(true);
  expect(sender.openStream(99, { frames: 1, bytes: 1000 }).ok).toBe(true);
  expect(sender.openStream(999, { frames: 1, bytes: 1000 }).code).toBe(RELAY_P3_ERROR.STREAM_LIMIT);
  sender.applyReset(9); sender.forgetStream(9);
  expect(sender.openStream(999, { frames: 1, bytes: 1000 }).ok).toBe(true);
  expect(sender.openStream(9, { frames: 1, bytes: 1000 }).code).toBe(RELAY_P3_ERROR.STREAM_LIMIT);
  expect(sender.ledgerView().streamIds()).toEqual([0, 99, 999]);
});

test("sideband: only credit/ping/reset/CANCEL, at most two 256B slots, no normal window borrowed", () => {
  const sideband = new RelaySideband();
  let seq = 0;
  const allocSeq = () => ({ ok: true as const, seq: ++seq });

  const cancel = prepareFrameBody({
    type: RELAY_TYPE.CANCEL, stream: 0,
    metadata: { op: RELAY_OP.REQUEST_CANCEL, targetStream: 1, reason: "user" },
  }, { maxWireBytes: 256 });
  if (!cancel.ok) throw new Error(cancel.code);
  expect(sideband.admit(cancel.body, 7).ok).toBe(true);

  const credit = prepareFrameBody({
    type: RELAY_TYPE.PUSH, stream: 0,
    metadata: {
      op: RELAY_OP.CREDIT, targetStream: 1,
      framesReleased: "0000000000000001", bytesReleased: "0000000000001000",
    },
  }, { maxWireBytes: 256 });
  if (!credit.ok) throw new Error(credit.code);
  expect(sideband.admit(credit.body, 0).ok).toBe(true);

  // Third slot: the lane is full (two slots).
  const ping = prepareFrameBody(
    { type: RELAY_TYPE.REQUEST, stream: 0, metadata: { op: RELAY_OP.PING, token: 1 } },
    { maxWireBytes: 256 },
  );
  if (!ping.ok) throw new Error(ping.code);
  expect(sideband.admit(ping.body, 1).code).toBe(RELAY_P3_ERROR.SIDEBAND_FULL);

  // Business data never rides the sideband.
  const business = prepareFrameBody({ type: RELAY_TYPE.REQUEST, stream: 1, metadata: GET_META });
  if (!business.ok) throw new Error(business.code);
  expect(sideband.admit(business.body, 5).code).toBe(RELAY_P3_ERROR.SIDEBAND_FORBIDDEN);

  const drained = sideband.drain(SESSION, allocSeq);
  expect(drained.frames.length).toBe(2);
  const first = decodeFrame(drained.frames[0]);
  if (!first.ok) throw new Error(first.code);
  expect(first.frame.stream).toBe(0);
  expect(first.frame.seq).toBe(1);
  expect(first.frame.correlation).toBe(7);
});

test("sideband: a frame over 256 bytes is SIDEBAND_LARGE; the reason clips at 64 UTF-8 bytes", () => {
  const sideband = new RelaySideband();
  const reason = clipUtf8Bytes("é".repeat(100), RELAY_LIMITS.cancelReasonMaxBytes);
  expect(new TextEncoder().encode(reason).length).toBeLessThanOrEqual(RELAY_LIMITS.cancelReasonMaxBytes);
  // 200 bytes of metadata plus the 48-byte header cannot fit a 256B slot.
  const big = prepareFrameBody({
    type: RELAY_TYPE.PUSH, stream: 0,
    metadata: { op: RELAY_OP.RESET, targetStream: 1, reason: "x".repeat(200) },
  }, { maxWireBytes: 4096 });
  if (!big.ok) throw new Error(big.code);
  expect(big.body.wireBytes).toBeGreaterThan(256);
  expect(sideband.admit(big.body, 0).code).toBe(RELAY_P3_ERROR.SIDEBAND_LARGE);
});

// ---------------------------------------------------------------------------
// Step 2 — send planner: bounded admission, BUSY, priority, FIFO, seq rule
// ---------------------------------------------------------------------------

test("sender: seq exists only once a frame is selected (one-per-pump proves allocation timing)", () => {
  const ep = new Endpoint(SESSION, [{ stream: 1, slice: { frames: 4, bytes: 16384 } }], { framesPerPump: 1 });
  expect(ep.sender.admit({ type: RELAY_TYPE.REQUEST, stream: 1, correlation: 1, metadata: GET_META }).ok).toBe(true);
  expect(ep.sender.admit({ type: RELAY_TYPE.REQUEST, stream: 1, correlation: 2, metadata: GET_META }).ok).toBe(true);
  const first = ep.sender.pump();
  expect(first.frames.length).toBe(1);
  let d = decodeFrame(first.frames[0]);
  if (!d.ok) throw new Error(d.code);
  expect(d.frame.seq).toBe(1);
  // The still-queued second frame has no seq until this pump selects it.
  const second = ep.sender.pump();
  expect(second.frames.length).toBe(1);
  d = decodeFrame(second.frames[0]);
  if (!d.ok) throw new Error(d.code);
  expect(d.frame.seq).toBe(2);
  expect(ep.sender.queuedFrames(1)).toBe(0);
});

test("sender: seq allocates at selection after charging; queued+new admission; BUSY does not enqueue", () => {
  const ep = new Endpoint(SESSION, [{ stream: 1, slice: { frames: 2, bytes: 2 * GET_WIRE } }]);
  const admit = (corr: number) => ep.sender.admit({
    type: RELAY_TYPE.REQUEST, stream: 1, correlation: corr, metadata: GET_META,
  });
  expect(admit(1).ok).toBe(true);
  expect(admit(2).ok).toBe(true);
  // No frame is in flight yet, but queued+new (2 queued + 1) exceeds the
  // 2-frame slice: BUSY, and nothing enters the queue.
  const third = admit(3);
  expect(third.code).toBe(RELAY_P3_ERROR.BUSY);
  expect(ep.sender.queuedFrames(1)).toBe(2);

  const pumped = ep.sender.pump();
  expect(pumped.frames.length).toBe(2);
  const seqs = pumped.frames.map((b) => {
    const d = decodeFrame(b);
    if (!d.ok) throw new Error(d.code);
    return { seq: d.frame.seq, corr: d.frame.correlation };
  });
  // FIFO inside the stream; seq starts at 1 per (session, stream).
  expect(seqs).toEqual([{ seq: 1, corr: 1 }, { seq: 2, corr: 2 }]);
  expect(ep.sender.ledgerView().inFlight(1)).toEqual({ frames: 2, bytes: 2 * GET_WIRE });
  // Window full: still BUSY.
  expect(admit(3).code).toBe(RELAY_P3_ERROR.BUSY);
});

test("sender: priority bands select first, streams round-robin inside a band, FIFO never breaks inside a stream", () => {
  // control 2 + stream1 3 + stream2 3 = 8 frames.
  const ep = new Endpoint(SESSION, [
    { stream: 1, slice: { frames: 3, bytes: 12288 } },
    { stream: 2, slice: { frames: 3, bytes: 12288 } },
  ]);
  const a = (stream: number, corr: number, priority: RelayPriority) =>
    ep.sender.admit({ type: RELAY_TYPE.REQUEST, stream, correlation: corr, priority, metadata: GET_META });
  // Stream queues end up s1=[10,11,13], s2=[12,14,15].
  expect(a(1, 10, RELAY_PRIORITY.CONTROL).ok).toBe(true);
  expect(a(2, 12, RELAY_PRIORITY.VISIBLE).ok).toBe(true);
  expect(a(1, 11, RELAY_PRIORITY.VISIBLE).ok).toBe(true);
  expect(a(2, 14, RELAY_PRIORITY.VISIBLE).ok).toBe(true);
  expect(a(1, 13, RELAY_PRIORITY.VISIBLE).ok).toBe(true);
  expect(a(2, 15, RELAY_PRIORITY.PREFETCH).ok).toBe(true);

  const order = ep.sender.pump().frames.map((b) => {
    const d = decodeFrame(b);
    if (!d.ok) throw new Error(d.code);
    return { stream: d.frame.stream, corr: d.frame.correlation };
  });
  // Control band first; VISIBLE alternates s1/s2 starting at the lowest
  // stream id; PREFETCH leaves last. Per-stream FIFO: s1 10,11,13 s2 12,14,15.
  expect(order.map((o) => o.corr)).toEqual([10, 11, 12, 13, 14, 15]);
});

test("sender: a big head blocked on byte credit does not stall a smaller frame on another stream", () => {
  const bigMeta = {
    op: "resource.get",
    resource: { kind: 2, ns: "n", key: "k".repeat(40), rendition: "r" },
  };
  const bigBody = prepareFrameBody({ type: RELAY_TYPE.REQUEST, stream: 1, metadata: bigMeta });
  if (!bigBody.ok) throw new Error(bigBody.code);
  const bigW = bigBody.body.wireBytes;
  const ep = new Endpoint(SESSION, [
    { stream: 1, slice: { frames: 2, bytes: bigW } },
    { stream: 2, slice: { frames: 2, bytes: 2 * GET_WIRE } },
  ]);
  expect(ep.sender.admit({ type: RELAY_TYPE.REQUEST, stream: 1, correlation: 1, metadata: bigMeta }).ok).toBe(true);
  const first = ep.sender.pump();
  expect(first.frames.length).toBe(1); // big frame in flight fills stream 1 bytes
  expect(ep.sender.admit({ type: RELAY_TYPE.REQUEST, stream: 1, correlation: 2, metadata: bigMeta }).code)
    .toBe(RELAY_P3_ERROR.BUSY);
  expect(ep.sender.admit({ type: RELAY_TYPE.REQUEST, stream: 2, correlation: 3, metadata: GET_META }).ok).toBe(true);
  const second = ep.sender.pump();
  expect(second.frames.length).toBe(1);
  const d = decodeFrame(second.frames[0]);
  if (!d.ok) throw new Error(d.code);
  expect(d.frame.stream).toBe(2);
});

test("sender: CANCEL and relay.reset ride the sideband past a full normal window and consume no normal credit", () => {
  const ep = new Endpoint(SESSION, [{ stream: 1, slice: { frames: 1, bytes: 8192 } }]);
  expect(ep.sender.admit({ type: RELAY_TYPE.REQUEST, stream: 1, correlation: 1, metadata: GET_META }).ok).toBe(true);
  expect(ep.sender.pump().frames.length).toBe(1);
  expect(ep.sender.cancel(1, 1, "user navigated away").ok).toBe(true);
  expect(ep.sender.sendReset(1, "resync").ok).toBe(true);
  const pumped = ep.sender.pump();
  expect(pumped.frames.length).toBe(2);
  for (const bytes of pumped.frames) {
    const d = decodeFrame(bytes);
    if (!d.ok) throw new Error(d.code);
    expect(d.frame.stream).toBe(0);
  }
  expect(ep.sender.ledgerView().inFlight(0)).toEqual({ frames: 0, bytes: 0 });
  expect(ep.sender.ledgerView().inFlight(1)).toEqual({ frames: 1, bytes: GET_WIRE });
});

// ---------------------------------------------------------------------------
// Step 3 — bounded receive: busy backpressure, seq gaps, release-only credit
// ---------------------------------------------------------------------------

test("receiver: a full window returns WINDOW_OVERFLOW (nothing dropped); canIngest gates the transport", () => {
  const creditTable = new RelayCreditTable();
  const slices = new Map([[0, controlSlice()], [1, { frames: 2, bytes: 2 * GET_WIRE }]]);
  const rx = new RelayReceiver(SESSION, slices, creditTable);
  const frame = (seq: number) => {
    const bytes = wireRecord(1, seq, seq, GET_META);
    const dec = decodeFrame(bytes);
    if (!dec.ok) throw new Error(dec.code);
    return { bytes, frame: dec.frame };
  };
  const f1 = frame(1), f2 = frame(2);
  expect(rx.canIngest(1, f1.bytes.length)).toBe(true);
  expect(rx.ingest(f1.frame, f1.bytes.length).ok).toBe(true);
  expect(rx.ingest(f2.frame, f2.bytes.length).ok).toBe(true);
  // The transport must stop reading here: the peer is out of granted window.
  const f3 = frame(3);
  expect(rx.canIngest(1, f3.bytes.length)).toBe(false);
  const overflow = rx.ingest(f3.frame, f3.bytes.length);
  expect(overflow.code).toBe(RELAY_P3_ERROR.WINDOW_OVERFLOW);
  // f3 was never consumed; staging holds exactly the two granted frames.
  expect(rx.occupancyStream(1)).toEqual({ frames: 2, bytes: 2 * GET_WIRE });

  // Delivery is at most one frame per pump call; release is the only credit
  // point. A second pump delivers the next staged frame.
  expect(rx.pump().map((r) => r.handle)).toEqual(["1:1"]);
  expect(rx.pump().map((r) => r.handle)).toEqual(["1:2"]);
  expect(rx.pump().length).toBe(0);
  expect(rx.release("1:1").ok).toBe(true);
  expect(creditTable.counters(1)).toEqual({ frames: 1n, bytes: BigInt(GET_WIRE) });
});

test("receiver: a seq gap stops the stream; a stream-0 seq error ends the session", () => {
  const creditTable = new RelayCreditTable();
  const slices = new Map([[0, controlSlice()], [1, { frames: 8, bytes: 32768 }]]);
  const rx = new RelayReceiver(SESSION, slices, creditTable);
  const business = (seq: number) => {
    const bytes = wireRecord(1, seq, seq, GET_META);
    const dec = decodeFrame(bytes);
    if (!dec.ok) throw new Error(dec.code);
    return dec.frame;
  };
  const control = (seq: number) => {
    // PUSH on stream 0 only needs a grammar-valid op at the frame layer.
    const bytes = wireRecord(0, seq, 0, { op: "x" }, RELAY_TYPE.PUSH);
    const dec = decodeFrame(bytes);
    if (!dec.ok) throw new Error(dec.code);
    return dec.frame;
  };
  expect(rx.ingest(business(1), 100).ok).toBe(true);
  expect(rx.ingest(business(3), 100).code).toBe(RELAY_P3_ERROR.SEQ_GAP);
  // The stream stays stopped: the missing frame arriving later is rejected.
  expect(rx.ingest(business(2), 100).code).toBe(RELAY_P3_ERROR.SEQ_GAP);
  // A seq error on stream 0 is session-fatal.
  expect(rx.ingest(control(2), 100).code).toBe(RELAY_P3_ERROR.SESSION_FATAL);
  expect(rx.sessionFatal).toBe(true);
});

test("loopback: a 600-frame burst admits only to the window cap, BUSY demand retries after credit, nothing lost", () => {
  const a = new Endpoint(SESSION, [{ stream: 1, slice: { frames: 2, bytes: 2 * GET_WIRE } }]);
  const b = new Endpoint(SESSION, [{ stream: 1, slice: { frames: 2, bytes: 2 * GET_WIRE } }]);

  const TOTAL = 600;
  let maxInFlightFrames = 0;
  let maxInFlightBytes = 0;
  let busy = 0;
  // Finite unsubmitted demand the upper layer retains (§3.9: the protocol
  // itself never grows an unbounded retry queue).
  const waiting: number[] = [];
  let next = 1;
  const fill = () => {
    while (next <= TOTAL || waiting.length > 0) {
      const corr = waiting.length > 0 ? waiting[0]! : next;
      const r = a.sender.admit({ type: RELAY_TYPE.REQUEST, stream: 1, correlation: corr, metadata: GET_META });
      if (!r.ok) {
        expect(r.code).toBe(RELAY_P3_ERROR.BUSY);
        if (waiting.length === 0) { waiting.push(next); next++; }
        busy++;
        break;
      }
      if (waiting.length > 0) waiting.shift();
      else next++;
    }
  };

  fill();
  const deliveredSeqs: number[] = [];
  let guard = 0;
  while (deliveredSeqs.length < TOTAL && guard++ < 10000) {
    // Peak is measured the instant A's frames are charged and on the wire,
    // before B consumes anything or returns credit.
    const handles = transport(a, b);
    const peak = a.sender.ledgerView().inFlight(1);
    maxInFlightFrames = Math.max(maxInFlightFrames, peak.frames);
    maxInFlightBytes = Math.max(maxInFlightBytes, peak.bytes);
    for (const h of handles) {
      const released = b.receiver.release(h);
      if (!released.ok) throw new Error(released.code);
      deliveredSeqs.push(Number(h.split(":")[1]));
    }
    // B returns cumulative credit; A's window unwinds and more demand admits.
    transport(b, a);
    fill();
  }
  expect(deliveredSeqs.length).toBe(TOTAL);
  expect(busy).toBeGreaterThan(0);
  expect(maxInFlightFrames).toBeLessThanOrEqual(2);
  expect(maxInFlightBytes).toBeLessThanOrEqual(2 * GET_WIRE);
  // Every request crossed exactly once, in stream-FIFO order.
  expect(deliveredSeqs.every((s, i) => s === i + 1)).toBe(true);
  console.log(`relay 600-frame burst: BUSY admissions=${busy}, max in-flight=${maxInFlightFrames} frames / ${maxInFlightBytes} bytes (frame wire ${GET_WIRE}B)`);
});

// ---------------------------------------------------------------------------
// Step 4 — reset and CANCEL terminal semantics
// ---------------------------------------------------------------------------

test("relay.reset: queued and in-flight requests fail, session state releases, the stream never reopens", () => {
  // Two frames per pump leaves corr 3/4 queued while 1/2 are on the wire.
  const a = new Endpoint(SESSION, [{ stream: 1, slice: { frames: 4, bytes: 16384 } }], { framesPerPump: 2 });
  const b = new Endpoint(SESSION, [{ stream: 1, slice: { frames: 4, bytes: 16384 } }]);
  for (const corr of [1, 2, 3, 4]) {
    expect(a.requests.admit(1).ok).toBe(true);
    expect(a.sender.admit({
      type: RELAY_TYPE.REQUEST, stream: 1, correlation: corr, metadata: GET_META,
      association: { kind: "correlation", id: corr },
    }).ok).toBe(true);
  }
  // Per-pump delivery is one frame; one is outstanding, one staged, two queued.
  const handles = transport(a, b);
  expect(handles).toEqual(["1:1"]);

  const failedQueued = a.sender.applyReset(1);
  expect(failedQueued.map((f) => f.id).sort()).toEqual([3, 4]);
  const failedRequests = a.requests.failStream(1);
  expect(failedRequests.length).toBe(4);
  expect(a.requests.active).toBe(0);
  expect(a.sender.openStream(1, { frames: 1, bytes: 1 }).code).toBe(RELAY_P3_ERROR.STREAM_LIMIT);

  // Receiver reset discards the outstanding plus staged frame with credit.
  const reset = b.receiver.applyReset(1, "resync");
  if (!reset.ok) throw new Error(reset.code);
  expect(reset.failed).toBe(2);
  expect(b.creditTable.counters(1)?.frames).toBe(2n);
  // A later frame on the abandoned id drops as late and still credits.
  const bytes = wireRecord(1, 3, 5, GET_META);
  const dec = decodeFrame(bytes);
  if (!dec.ok) throw new Error(dec.code);
  const ingested = b.receiver.ingest(dec.frame, bytes.length);
  expect(ingested.ok).toBe(true);
  if (ingested.ok) expect(ingested.late).toBe(true);
  expect(b.receiver.occupancyStream(1)).toEqual({ frames: 0, bytes: 0 });
});

test("CANCEL race A: the result is already in flight — success terminal stands, no second terminal", () => {
  const provider = new RelayRequestTable();
  expect(provider.admitKnown(1, 42).ok).toBe(true);
  const t1 = provider.terminal(42, { status: "ok", final: true, effect: RELAY_EFFECT.NONE });
  if (!t1.ok) throw new Error(t1.code);
  expect(t1.first).toBe(true);
  // CANCEL arrives after the terminal was sent: interest is withdrawn but
  // the provider neither replaces nor repeats the terminal.
  expect(provider.cancel(42).ok).toBe(true);
  const t2 = provider.terminal(42, {
    status: "error", final: true, errorCode: RELAY_ERROR.CANCELLED, effect: RELAY_EFFECT.NONE,
  });
  expect(t2.code).toBe(RELAY_P3_ERROR.ALREADY_TERMINAL);
  // A repeat CANCEL while the terminal is still pending neither errors nor
  // produces a second terminal; then consumption frees the single slot.
  expect(provider.cancel(42).ok).toBe(true);
  const consumed = provider.consumeTerminal(42);
  expect(consumed.ok).toBe(true);
  if (consumed.ok) expect(consumed.state.terminal?.status).toBe("ok");
  expect(provider.active).toBe(0);
});

test("CANCEL race B: cancel first — the one terminal is CANCELLED/none; the slot frees on consume only", () => {
  const client = new RelayRequestTable();
  expect(client.admit(1).ok).toBe(true); // correlation 1
  expect(client.cancel(1).ok).toBe(true);
  expect(client.get(1)?.cancelRequested).toBe(true);
  expect(client.active).toBe(1); // timeout/cancel does not return the slot
  const t = client.terminal(1, {
    status: "error", final: true, errorCode: RELAY_ERROR.CANCELLED, effect: RELAY_EFFECT.NONE,
  });
  expect(t.ok).toBe(true);
  expect(client.active).toBe(1);
  expect(client.consumeTerminal(1).ok).toBe(true);
  expect(client.active).toBe(0);
  // A duplicated terminal after the slot released cannot be recorded twice.
  const dup = client.terminal(1, {
    status: "error", final: true, errorCode: RELAY_ERROR.CANCELLED, effect: RELAY_EFFECT.NONE,
  });
  expect(dup.code).toBe(RELAY_P3_ERROR.UNKNOWN_REQUEST);
});

test("CANCEL: late chunks after the terminal pass seq/credit accounting and drop without delivery", () => {
  // control 2 + business 6 = the 8-frame attachment window.
  const b = new Endpoint(SESSION, [{ stream: 1, slice: { frames: 6, bytes: 24576 } }]);
  const ingest = (seq: number) => {
    const bytes = wireRecord(1, seq, 7, GET_META);
    const dec = decodeFrame(bytes);
    if (!dec.ok) throw new Error(dec.code);
    return b.receiver.ingest(dec.frame, bytes.length, { kind: "correlation", id: 7 });
  };
  expect(ingest(1).ok).toBe(true);
  expect(ingest(2).ok).toBe(true);
  // Both pre-terminal chunks deliver and release normally.
  for (const expected of ["1:1", "1:2"]) {
    const [handle] = b.receiver.pump().map((r) => r.handle);
    expect(handle).toBe(expected);
    expect(b.receiver.release(handle).ok).toBe(true);
  }
  // The one terminal is consumed: association 7 is finished.
  b.receiver.markFinished("correlation", 7);
  const late1 = ingest(3);
  expect(late1.ok).toBe(true);
  if (late1.ok) expect(late1.late).toBe(true);
  const late2 = ingest(4);
  expect(late2.ok).toBe(true);
  if (late2.ok) expect(late2.late).toBe(true);
  // All four frames returned credit; neither late chunk was delivered.
  expect(b.creditTable.counters(1)).toEqual({ frames: 4n, bytes: BigInt(4 * GET_WIRE) });
  expect(b.receiver.pump().length).toBe(0);
  // Seq still advances through late chunks: a hole is an error, not a drop.
  expect(ingest(6).code).toBe(RELAY_P3_ERROR.SEQ_GAP);
});

test("request table: maxPending=8; cancel does not release a slot; 2 slots reservable for input/control", () => {
  const table = new RelayRequestTable();
  for (let i = 0; i < RELAY_LIMITS.maxPending; i++) expect(table.admit(1).ok).toBe(true);
  expect(table.admit(1).code).toBe(RELAY_P3_ERROR.PENDING_FULL);
  const reserved = new RelayRequestTable();
  for (let i = 0; i < 6; i++) expect(reserved.admit(1, 2).ok).toBe(true);
  expect(reserved.admit(1, 2).code).toBe(RELAY_P3_ERROR.PENDING_FULL);
  expect(table.cancel(1).ok).toBe(true);
  expect(table.active).toBe(8);
  table.terminal(1, {
    status: "error", final: true, errorCode: RELAY_ERROR.CANCELLED, effect: RELAY_EFFECT.NONE,
  });
  expect(table.consumeTerminal(1).ok).toBe(true);
  expect(table.active).toBe(7);
});

// ---------------------------------------------------------------------------
// Step 6 — inbound reserved sideband lane (review 963 blocker B1)
// ---------------------------------------------------------------------------

const OPEN_META = {
  op: RELAY_OP.OPEN, app: "app", namespace: "ns",
  profile: { name: "pocket-map", version: 1 },
};

/** Pumps A once and returns each wire record with its decoded frame. */
function pumpDecoded(ep: Endpoint): Array<{ bytes: Uint8Array; frame: RelayDecodedFrame }> {
  const out = ep.sender.pump();
  if (!out.ok) throw new Error(out.code);
  return out.frames.map((bytes) => {
    const dec = decodeFrame(bytes);
    if (!dec.ok) throw new Error(dec.code);
    return { bytes, frame: dec.frame };
  });
}

test("receive sideband (CE-1): an inbound CANCEL rides the reserved lane, occupies no normal control window and earns no credit", () => {
  const a = new Endpoint(SESSION, [{ stream: 1, slice: { frames: 2, bytes: 8192 } }]);
  const b = new Endpoint(SESSION, [{ stream: 1, slice: { frames: 2, bytes: 8192 } }]);
  expect(a.sender.cancel(1, 7, "user left").ok).toBe(true);
  const [{ bytes, frame }] = pumpDecoded(a);
  expect(frame.type).toBe(RELAY_TYPE.CANCEL);

  // The reserved lane is readable even though no normal stream-0 frame was
  // ever granted, and admission does not touch the control slice.
  expect(b.receiver.canIngestSideband(bytes.length)).toBe(true);
  const ing = b.receiver.ingestSideband(frame, bytes.length);
  expect(ing.ok).toBe(true);
  expect(b.receiver.occupancyStream(0)).toEqual({ frames: 0, bytes: 0 });
  expect(b.receiver.sidebandOccupancy()).toEqual({ frames: 1, bytes: bytes.length });

  // The control comes out the sideband pump and frees its reserved slot
  // without a release() call or any relay.credit row.
  const [control] = b.receiver.pumpSideband();
  expect(control.handle).toBe(`side:0:${frame.seq}`);
  expect(b.receiver.sidebandOccupancy()).toEqual({ frames: 0, bytes: 0 });
  expect(b.creditTable.counters(0)).toBeUndefined();
});

test("receive sideband (CE-2): no stream-0 credit is produced for a CANCEL, so the peer ledger never sees CREDIT_RANGE", () => {
  const a = new Endpoint(SESSION, [{ stream: 1, slice: { frames: 2, bytes: 8192 } }]);
  const b = new Endpoint(SESSION, [{ stream: 1, slice: { frames: 2, bytes: 8192 } }]);
  expect(a.sender.cancel(1, 7, "user left").ok).toBe(true);
  const [{ bytes, frame }] = pumpDecoded(a);
  expect(b.receiver.ingestSideband(frame, bytes.length).ok).toBe(true);
  b.receiver.pumpSideband();
  // Before the fix this row existed (1 frame / wireBytes) and applying it
  // to A failed CREDIT_RANGE because A charged the CANCEL to no window.
  expect(b.creditTable.counters(0)).toBeUndefined();
  // The CANCEL consumed no normal window on A either; a stream-0 credit
  // claiming one frame is still out of range and must be rejected.
  expect(a.sender.ledgerView().sentTotals(0)).toEqual({ frames: 0, bytes: 0 });
  const bogus = a.sender.applyCredit({
    targetStream: 0,
    framesReleased: "0000000000000001",
    bytesReleased: bytes.length.toString(16).padStart(16, "0"),
  });
  expect(bogus.code).toBe(RELAY_P3_ERROR.CREDIT_RANGE);
});

test("receive sideband (CE-3): a full normal control slice does not block the reserved lane; seq stays shared", () => {
  const a = new Endpoint(SESSION, []);
  const b = new Endpoint(SESSION, []);
  // Fill B's normal stream-0 slice (2 frames) with ordinary OPEN frames.
  for (const corr of [1, 2]) {
    expect(a.sender.admit({
      type: RELAY_TYPE.REQUEST, stream: 0, correlation: corr,
      priority: RELAY_PRIORITY.CONTROL, metadata: OPEN_META,
    }).ok).toBe(true);
  }
  const normal = pumpDecoded(a);
  expect(normal.length).toBe(2);
  for (const { bytes, frame } of normal) {
    expect(b.receiver.canIngest(0, bytes.length)).toBe(true);
    expect(b.receiver.ingest(frame, bytes.length).ok).toBe(true);
  }
  // The transport must stop reading normal stream-0 records here.
  expect(b.receiver.occupancyStream(0).frames).toBe(2);
  expect(b.receiver.canIngest(0, 100)).toBe(false);
  // The reserved lane still carries a CANCEL past the full slice.
  expect(a.sender.cancel(1, 9, "user left").ok).toBe(true);
  const [side] = pumpDecoded(a);
  expect(isSidebandFrame(side.frame)).toBe(true);
  expect(b.receiver.canIngestSideband(side.bytes.length)).toBe(true);
  expect(b.receiver.ingestSideband(side.frame, side.bytes.length).ok).toBe(true);
  expect(b.receiver.occupancyStream(0).frames).toBe(2); // normal slice untouched
  expect(b.receiver.sidebandOccupancy().frames).toBe(1);

  // Stream-0 seq is one space: normal OPEN took 1,2 and CANCEL took 3.
  const seqs = [normal[0]!.frame.seq, normal[1]!.frame.seq, side.frame.seq];
  expect(seqs).toEqual([1, 2, 3]);
  // Consume one normal frame (its release notes ordinary stream-0 credit),
  // then the next ordinary stream-0 record seq 4 ingests with no gap.
  const [h1] = b.receiver.pump().map((r) => r.handle);
  expect(h1).toBe("0:1");
  expect(b.receiver.release(h1).ok).toBe(true);
  // Return the stream-0 credit so A's control slice has one slot again.
  transport(b, a);
  expect(a.sender.admit({
    type: RELAY_TYPE.REQUEST, stream: 0, correlation: 3,
    priority: RELAY_PRIORITY.CONTROL, metadata: OPEN_META,
  }).ok).toBe(true);
  const [next] = pumpDecoded(a);
  expect(next.frame.seq).toBe(4);
  expect(b.receiver.ingest(next.frame, next.bytes.length).ok).toBe(true);
  // The staged CANCEL still delivers once the session layer pumps the lane.
  const [cancel] = b.receiver.pumpSideband();
  expect(cancel.frame.type).toBe(RELAY_TYPE.CANCEL);
  expect(cancel.seq).toBe(3);
});

test("receive sideband (CE-4): a sideband record between two normal stream-0 records opens no seq gap", () => {
  const a = new Endpoint(SESSION, []);
  const b = new Endpoint(SESSION, []);
  const open = (corr: number) => a.sender.admit({
    type: RELAY_TYPE.REQUEST, stream: 0, correlation: corr,
    priority: RELAY_PRIORITY.CONTROL, metadata: OPEN_META,
  });

  // Pump 1: ordinary stream-0 management REQUEST -> seq 1.
  expect(open(1).ok).toBe(true);
  const [f1] = pumpDecoded(a);
  expect(f1.frame.seq).toBe(1);
  // Pump 2: CANCEL on the lane -> seq 2 (no normal window charged).
  expect(a.sender.cancel(1, 7, "user left").ok).toBe(true);
  const [fSide] = pumpDecoded(a);
  expect(fSide.frame.seq).toBe(2);
  expect(isSidebandFrame(fSide.frame)).toBe(true);
  // Pump 3: another ordinary stream-0 management REQUEST -> seq 3.
  expect(open(2).ok).toBe(true);
  const [f3] = pumpDecoded(a);
  expect(f3.frame.seq).toBe(3);

  // Both paths share one stream-0 expectation: normal, sideband, normal.
  expect(b.receiver.ingest(f1.frame, f1.bytes.length).ok).toBe(true);
  expect(b.receiver.ingestSideband(fSide.frame, fSide.bytes.length).ok).toBe(true);
  expect(b.receiver.ingest(f3.frame, f3.bytes.length).ok).toBe(true);
  expect(b.receiver.sessionFatal).toBe(false);
  // The sideband control occupies its own slot; the two OPEN frames occupy
  // the normal slice; the seq cursor is at 4.
  expect(b.receiver.occupancyStream(0)).toEqual({
    frames: 2,
    bytes: f1.bytes.length + f3.bytes.length,
  });
  expect(b.receiver.sidebandOccupancy().frames).toBe(1);
  // Delivery keeps the two record classes distinguishable.
  expect(b.receiver.pump().map((r) => r.handle)).toEqual(["0:1"]);
  expect(b.receiver.pumpSideband().map((r) => r.handle)).toEqual(["side:0:2"]);
  expect(b.receiver.pump().map((r) => r.handle)).toEqual(["0:3"]);
  // Routing a whitelisted record through the normal path is a local
  // dispatch error and leaves the seq cursor untouched.
  expect(a.sender.cancel(1, 8, "again").ok).toBe(true);
  const [fSide2] = pumpDecoded(a);
  expect(fSide2.frame.seq).toBe(4);
  expect(b.receiver.ingest(fSide2.frame, fSide2.bytes.length).code)
    .toBe(RELAY_P3_ERROR.SIDEBAND_FORBIDDEN);
  expect(b.receiver.ingestSideband(fSide2.frame, fSide2.bytes.length).ok).toBe(true);
});

test("receive sideband: a third staged control cannot be held and is a stream-0 protocol error", () => {
  const rx = new RelayReceiver(
    SESSION, new Map([[0, controlSlice()]]), new RelayCreditTable(), RELAY_LIMITS.maxStreams, 1,
  );
  const cancel = (seq: number) => {
    const bytes = wireRecord(0, seq, seq, {
      op: RELAY_OP.REQUEST_CANCEL, targetStream: 1, reason: "x",
    }, RELAY_TYPE.CANCEL);
    const dec = decodeFrame(bytes);
    if (!dec.ok) throw new Error(dec.code);
    return { bytes, frame: dec.frame };
  };
  const c1 = cancel(1), c2 = cancel(2), c3 = cancel(3);
  expect(c1.bytes.length).toBeLessThanOrEqual(256);
  expect(rx.ingestSideband(c1.frame, c1.bytes.length).ok).toBe(true);
  expect(rx.ingestSideband(c2.frame, c2.bytes.length).ok).toBe(true);
  // Two slots are the reservation: the transport stops reading the lane.
  expect(rx.canIngestSideband(c3.bytes.length)).toBe(false);
  const overflow = rx.ingestSideband(c3.frame, c3.bytes.length);
  expect(overflow.code).toBe(RELAY_P3_ERROR.SESSION_FATAL);
  expect(rx.sessionFatal).toBe(true);
});

test("receive sideband: business records and non-whitelisted stream-0 ops stay off the lane", () => {
  const rx = new RelayReceiver(
    SESSION, new Map([[0, controlSlice()], [1, { frames: 2, bytes: 2 * GET_WIRE }]]),
    new RelayCreditTable(), RELAY_LIMITS.maxStreams, 1,
  );
  // A business REQUEST on a nonzero stream is not lane traffic.
  const biz = wireRecord(1, 1, 1, GET_META);
  const bizDec = decodeFrame(biz);
  if (!bizDec.ok) throw new Error(bizDec.code);
  expect(rx.ingestSideband(bizDec.frame, biz.length).code).toBe(RELAY_P3_ERROR.SIDEBAND_FORBIDDEN);
  // An ordinary stream-0 PUSH with a non-whitelisted op stays normal and
  // still consumes the control slice.
  const mgmt = wireRecord(0, 1, 0, { op: "relay.close" }, RELAY_TYPE.PUSH);
  const mgmtDec = decodeFrame(mgmt);
  if (!mgmtDec.ok) throw new Error(mgmtDec.code);
  expect(isSidebandFrame(mgmtDec.frame)).toBe(false);
  expect(rx.ingestSideband(mgmtDec.frame, mgmt.length).code).toBe(RELAY_P3_ERROR.SIDEBAND_FORBIDDEN);
  expect(rx.ingest(mgmtDec.frame, mgmt.length).ok).toBe(true);
});

// ---------------------------------------------------------------------------
// Step 7 — guards for review 963 surviving mutants M2/M6/M8/M9 (blocker B2)
// ---------------------------------------------------------------------------

test("mutation guard M2: admission counts queued BYTES, not just frames (mixed-size queue)", () => {
  const bigMeta = {
    op: "resource.get",
    resource: { kind: 2, ns: "n", key: "k".repeat(40), rendition: "r" },
  };
  const bigBody = prepareFrameBody({ type: RELAY_TYPE.REQUEST, stream: 1, metadata: bigMeta });
  if (!bigBody.ok) throw new Error(bigBody.code);
  const bigW = bigBody.body.wireBytes;
  expect(bigW).toBeGreaterThan(GET_WIRE);
  // Three frame slots, byte space for exactly the one big queued frame.
  const ep = new Endpoint(SESSION, [{ stream: 1, slice: { frames: 3, bytes: bigW } }]);
  expect(ep.sender.admit({
    type: RELAY_TYPE.REQUEST, stream: 1, correlation: 1, metadata: bigMeta,
  }).ok).toBe(true);
  // A smaller second frame fits the frame count (2 <= 3) and fits the byte
  // cap on its own, but queued-big + new-small exceeds slice bytes.
  const second = ep.sender.admit({
    type: RELAY_TYPE.REQUEST, stream: 1, correlation: 2, metadata: GET_META,
  });
  expect(second.ok).toBe(false);
  expect(second.code).toBe(RELAY_P3_ERROR.BUSY);
  expect(ep.sender.queuedFrames(1)).toBe(1);
});

test("mutation guard M6: the released FRAMES counter cannot move backwards while bytes stay in range", () => {
  const ledger = new RelayCreditLedger(ATTACH.frames, ATTACH.bytes, controlSlice());
  expect(ledger.allocate(1, { frames: 2, bytes: 8192 }).ok).toBe(true);
  expect(ledger.charge(1, 4096).ok).toBe(true);
  expect(ledger.release(1, 1n, 4096n).ok).toBe(true);
  // Bytes hold the same cumulative value (monotonic and <= sent); only the
  // frames counter retreats. A frames-only check must reject this.
  const backwards = ledger.release(1, 0n, 4096n);
  expect(backwards.ok).toBe(false);
  expect(backwards.code).toBe(RELAY_P3_ERROR.CREDIT_RANGE);
  expect(ledger.releasedTotals(1)).toEqual({ frames: 1, bytes: 4096 });
});

test("mutation guard M8: a failed charge at selection consumes no seq (charge precedes seq allocation)", () => {
  const ep = new Endpoint(SESSION, [{ stream: 1, slice: { frames: 2, bytes: 2 * GET_WIRE } }]);
  expect(ep.sender.admit({
    type: RELAY_TYPE.REQUEST, stream: 1, correlation: 1, metadata: GET_META,
  }).ok).toBe(true);

  // Admission guarantees a queued head is chargeable, so the only way to
  // observe pump's internal order is to fault the charge while peekHead()
  // still sees room (it reads ledger.available, a different method). The
  // frame stays queued; correct code charges first, so no seq is spent.
  const ledger = ep.sender.ledgerView();
  const realCharge = ledger.charge.bind(ledger);
  let failNext = true;
  (ledger as { charge: typeof ledger.charge }).charge = (stream, wireBytes) =>
    failNext ? { ok: false, code: RELAY_P3_ERROR.BUSY } : realCharge(stream, wireBytes);

  const failed = ep.sender.pump();
  expect(failed.ok).toBe(false);
  expect(failed.code).toBe(RELAY_P3_ERROR.BUSY);
  expect(ep.sender.queuedFrames(1)).toBe(1); // not dequeued
  failNext = false;

  const pumped = ep.sender.pump();
  expect(pumped.ok).toBe(true);
  expect(pumped.frames.length).toBe(1);
  const dec = decodeFrame(pumped.frames[0]);
  if (!dec.ok) throw new Error(dec.code);
  expect(dec.frame.seq).toBe(1); // a seq spent before the failed charge would leave 2
});

test("mutation guard M9: one pump delivers at most one frame across streams and round-rotates", () => {
  const slices = new Map<number, RelayStreamAlloc>([
    [0, controlSlice()],
    [1, { frames: 2, bytes: 2 * GET_WIRE }],
    [2, { frames: 2, bytes: 2 * GET_WIRE }],
  ]);
  const rx = new RelayReceiver(SESSION, slices, new RelayCreditTable(), RELAY_LIMITS.maxStreams, 1);
  const ingest = (stream: number) => {
    const bytes = wireRecord(stream, 1, stream, GET_META);
    const dec = decodeFrame(bytes);
    if (!dec.ok) throw new Error(dec.code);
    expect(rx.ingest(dec.frame, bytes.length).ok).toBe(true);
  };
  ingest(1);
  ingest(2);
  expect(rx.pump().map((r) => r.handle)).toEqual(["1:1"]);
  expect(rx.pump().map((r) => r.handle)).toEqual(["2:1"]);
  expect(rx.pump()).toEqual([]);
});

// ---------------------------------------------------------------------------
// Step 5 — property invariant, benchmark, mutation probe
// ---------------------------------------------------------------------------

test("sideband: ping request and pong response are whitelisted; a worker turn drains at most 2 frames/512B", () => {
  const ep = new Endpoint(SESSION, [], { framesPerPump: 2 });
  expect(ep.sender.sendPing(1, 0xabcdef).ok).toBe(true);
  expect(ep.sender.sendPong(1, 0xabcdef).ok).toBe(true);
  const out = ep.sender.pump().frames;
  expect(out.length).toBe(2);
  const req = decodeFrame(out[0]);
  const res = decodeFrame(out[1]);
  if (!req.ok || !res.ok) throw new Error("decode");
  expect(req.frame.type).toBe(RELAY_TYPE.REQUEST);
  expect(req.frame.metadata.op).toBe(RELAY_OP.PING);
  expect(res.frame.type).toBe(RELAY_TYPE.RESPONSE);
  expect(res.frame.metadata.status).toBe("ok");
  expect(res.frame.metadata.final).toBe(true);
  // Sideband traffic leaves no normal-window debt on either ledger view.
  expect(ep.sender.ledgerView().inFlight(0)).toEqual({ frames: 0, bytes: 0 });
});

test("credit table: repeated releases merge into one cumulative row; dirty rows build relay.credit bodies", () => {
  const table = new RelayCreditTable();
  expect(table.note(1, 1, 100).ok).toBe(true);
  expect(table.note(1, 2, 200).ok).toBe(true); // merges, no new row
  expect(table.size).toBe(1);
  expect(table.counters(1)).toEqual({ frames: 3n, bytes: 300n });
  expect(table.note(2, 1, 64).ok).toBe(true);
  const rows = table.takeDirty();
  expect(rows.map((r) => r.stream).sort()).toEqual([1, 2]);
  // The built frame is a stream-0 PUSH carrying cumulative hex counters.
  const row1 = rows.find((x) => x.stream === 1)!;
  const built = encodePreparedFrame(row1.body, { session: SESSION, seq: 1, correlation: 0 });
  if (!built.ok) throw new Error(built.code);
  const dec = decodeFrame(built.bytes);
  if (!dec.ok) throw new Error(dec.code);
  expect(dec.frame.type).toBe(RELAY_TYPE.PUSH);
  expect(dec.frame.stream).toBe(0);
  expect(dec.frame.metadata).toEqual({
    op: RELAY_OP.CREDIT, targetStream: 1,
    framesReleased: "0000000000000003", bytesReleased: "000000000000012c",
  });
  table.clearDirty([1, 2]);
  expect(table.takeDirty().length).toBe(0);
});

test("credit table: bounded to nine rows (stream 0 plus eight nonzero streams)", () => {
  const table = new RelayCreditTable();
  for (let s = 0; s <= RELAY_LIMITS.maxStreams; s++) expect(table.note(s, 1, 1).ok).toBe(true);
  expect(table.size).toBe(9);
  const overflow = table.note(99, 1, 1);
  expect(overflow.ok).toBe(false);
  expect(overflow.code).toBe(RELAY_P3_ERROR.CREDIT_TABLE_FULL);
});

test("sender: admission rejects the wrong correlation for a type before any credit or seq is spent", () => {
  const ep = new Endpoint(SESSION, [{ stream: 1, slice: { frames: 4, bytes: 16384 } }]);
  // REQUEST without correlation.
  expect(ep.sender.admit({ type: RELAY_TYPE.REQUEST, stream: 1, metadata: GET_META }).code)
    .toBe(RELAY_P3_ERROR.BAD_CORRELATION);
  // PUSH with a correlation.
  expect(ep.sender.admit({ type: RELAY_TYPE.PUSH, stream: 1, correlation: 9, metadata: { op: "x" } }).code)
    .toBe(RELAY_P3_ERROR.BAD_CORRELATION);
  expect(ep.sender.queuedFrames(1)).toBe(0);
});

test("sender: ordinary stream-0 management frames consume the normal control slice; only the whitelist rides sideband", () => {  const ep = new Endpoint(SESSION, []); // control slice only: 2 frames
  const openMeta = {
    op: RELAY_OP.OPEN, app: "app", namespace: "ns",
    profile: { name: "pocket-map", version: 1 },
  };
  expect(ep.sender.admit({ type: RELAY_TYPE.REQUEST, stream: 0, correlation: 1, priority: RELAY_PRIORITY.CONTROL, metadata: openMeta }).ok).toBe(true);
  expect(ep.sender.admit({ type: RELAY_TYPE.REQUEST, stream: 0, correlation: 2, priority: RELAY_PRIORITY.CONTROL, metadata: openMeta }).ok).toBe(true);
  // The control slice is two normal frames; a third normal frame is BUSY.
  expect(ep.sender.admit({ type: RELAY_TYPE.REQUEST, stream: 0, correlation: 3, priority: RELAY_PRIORITY.CONTROL, metadata: openMeta }).code)
    .toBe(RELAY_P3_ERROR.BUSY);
  const out = ep.sender.pump();
  expect(out.frames.length).toBe(2);
  const controlBytes = out.frames.reduce((n, b) => n + b.length, 0);
  // Ordinary stream-0 management frames are counted on the normal ledger
  // (§3.9: "stream0 的普通管理 frame 也计数，sideband 白名单除外").
  expect(ep.sender.ledgerView().inFlight(0)).toEqual({ frames: 2, bytes: controlBytes });
});

test("property: window consumed never exceeds granted under randomized charge/release operations", () => {  for (let run = 0; run < 40; run++) {
    const ledger = new RelayCreditLedger(ATTACH.frames, ATTACH.bytes, controlSlice());
    const sliceFrames = 1 + ((Math.random() * 4) | 0);
    const sliceBytes = sliceFrames * 4096;
    expect(ledger.allocate(1, { frames: sliceFrames, bytes: sliceBytes }).ok).toBe(true);
    let sent = 0;
    let released = 0;
    for (let i = 0; i < 500; i++) {
      const inFlight = sent - released;
      if (inFlight < sliceFrames && Math.random() < 0.7) {
        expect(ledger.charge(1, 4096).ok).toBe(true);
        sent++;
      } else if (released < sent && Math.random() < 0.5) {
        const advance = 1 + ((Math.random() * (sent - released)) | 0);
        released += advance;
        expect(ledger.release(1, BigInt(released), BigInt(released * 4096)).ok).toBe(true);
      }
      const inf = ledger.inFlight(1);
      expect(inf.frames).toBe(sent - released);
      expect(inf.bytes).toBe(inf.frames * 4096);
      expect(inf.frames).toBeGreaterThanOrEqual(0);
      expect(inf.frames).toBeLessThanOrEqual(sliceFrames);
    }
  }
});

test("property: receiver occupancy never exceeds the granted window and every release is accounted exactly once", () => {
  for (let run = 0; run < 40; run++) {
    const capFrames = 2 + ((Math.random() * 3) | 0);
    const table = new RelayCreditTable();
    const slices = new Map([[0, controlSlice()], [1, { frames: capFrames, bytes: capFrames * GET_WIRE }]]);
    const rx = new RelayReceiver(SESSION, slices, table);
    let seq = 1;
    let credited = 0;
    const outstanding: string[] = [];
    for (let i = 0; i < 400; i++) {
      if (rx.canIngest(1, GET_WIRE) && Math.random() < 0.75) {
        const bytes = wireRecord(1, seq, seq, GET_META);
        const dec = decodeFrame(bytes);
        if (!dec.ok) throw new Error(dec.code);
        const ing = rx.ingest(dec.frame, bytes.length);
        expect(ing.ok).toBe(true);
        seq++;
      }
      for (const r of rx.pump()) outstanding.push(r.handle);
      if (outstanding.length > 0 && Math.random() < 0.6) {
        const handle = outstanding.shift()!;
        expect(rx.release(handle).ok).toBe(true);
        credited++;
      }
      const occ = rx.occupancyStream(1);
      expect(occ.frames).toBeGreaterThanOrEqual(0);
      expect(occ.frames).toBeLessThanOrEqual(capFrames);
      expect(occ.bytes).toBe(occ.frames * GET_WIRE);
      // Before the first release no row exists; afterwards counters match.
      expect(table.counters(1)?.frames ?? 0n).toBe(BigInt(credited));
      expect(table.counters(1)?.bytes ?? 0n).toBe(BigInt(credited * GET_WIRE));
    }
  }
});

test("benchmark: per-frame ledger bookkeeping over 100,000 charge/release operations", () => {
  const ledger = new RelayCreditLedger(1024, 1 << 24, { frames: 512, bytes: 1 << 23 });
  expect(ledger.allocate(1, { frames: 512, bytes: 1 << 23 }).ok).toBe(true);
  const n = 100_000;
  let window = 0;
  const start = performance.now();
  for (let i = 1; i <= n; i++) {
    const charged = ledger.charge(1, 4096);
    if (!charged.ok) throw new Error(charged.code);
    window++;
    if (window === 512) {
      const r = ledger.release(1, BigInt(i), BigInt(i * 4096));
      if (!r.ok) throw new Error(r.code);
      window = 0;
    }
  }
  const ms = performance.now() - start;
  const usPerOp = (ms / n) * 1000;
  console.log(`relay ledger charge/release n=${n}: ${ms.toFixed(1)} ms (${usPerOp.toFixed(3)} µs/frame)`);
  expect(usPerOp).toBeLessThan(50);
});

test("mutation probe: removing the +1 frame check in charge() lets a third frame past a 2-frame window", async () => {
  const sourceUrl = new URL("../framework/src/relay/credit.ts", import.meta.url);
  const original = await Bun.file(sourceUrl).text();
  const needle = "if (usedF + 1n > BigInt(a.frames) || usedB + BigInt(wireBytes) > BigInt(a.bytes))";
  const mutant = "if (usedF + 0n > BigInt(a.frames) || usedB + BigInt(wireBytes) > BigInt(a.bytes))";
  expect(original.includes(needle)).toBe(true);
  // The mutant keeps the same relative imports (./frame.ts, contracts), so it
  // lives beside the source for the duration of this test and is removed in
  // finally. The byte bound is given a large slice so only the frame-count
  // comparison is under test.
  const dir = new URL(".", sourceUrl).pathname;
  const mutatedPath = join(dir, `credit-mut-${process.pid}.ts`);
  try {
    writeFileSync(mutatedPath, original.replace(needle, mutant), "utf8");
    const mutated = await import(`${pathToFileURL(mutatedPath).href}?v=${Date.now()}`);
    const bad: RelayCreditLedger = new mutated.RelayCreditLedger(8, 1 << 24, { frames: 2, bytes: 1 << 23 });
    bad.allocate(1, { frames: 2, bytes: 1 << 23 });
    expect(bad.charge(1, 4096).ok).toBe(true);
    expect(bad.charge(1, 4096).ok).toBe(true);
    expect(bad.charge(1, 4096).ok).toBe(true); // mutant: over-admits

    const good = new RelayCreditLedger(8, 1 << 24, { frames: 2, bytes: 1 << 23 });
    good.allocate(1, { frames: 2, bytes: 1 << 23 });
    expect(good.charge(1, 4096).ok).toBe(true);
    expect(good.charge(1, 4096).ok).toBe(true);
    expect(good.charge(1, 4096).code).toBe(RELAY_P3_ERROR.BUSY);
  } finally {
    rmSync(mutatedPath, { force: true });
  }
});

// ---------------------------------------------------------------------------
// Step 8 — review 985 blockers: killing tests for lane mutants S9 and S7
// ---------------------------------------------------------------------------

/** A relay.reset record padded so the whole wire record (4-byte length
 * prefix + 44-byte header + metadata) is exactly `wireBytes` long. Every
 * reason character is one ASCII byte, so the pad is exact; the frame layer
 * does not enforce the 64-byte reason limit, so this models a peer that
 * skipped the clip. */
function resetRecordOf(seq: number, wireBytes: number): { bytes: Uint8Array; frame: RelayDecodedFrame } {
  const probe = wireRecord(0, seq, 0, { op: RELAY_OP.RESET, targetStream: 1, reason: "x" }, RELAY_TYPE.PUSH);
  const bytes = wireRecord(0, seq, 0, {
    op: RELAY_OP.RESET, targetStream: 1, reason: "x".repeat(1 + wireBytes - probe.length),
  }, RELAY_TYPE.PUSH);
  expect(bytes.length).toBe(wireBytes);
  const dec = decodeFrame(bytes, { maxWireBytes: RELAY_LIMITS.controlMaxWireBytes });
  if (!dec.ok) throw new Error(dec.code);
  expect(isSidebandFrame(dec.frame)).toBe(true);
  return { bytes, frame: dec.frame };
}

test("receive sideband (B-a): a slot is 256 bytes and the lane 512 — two 256-byte records fill it, one byte over a slot is a stream-0 protocol error", () => {
  const slotBytes = RELAY_LIMITS.sidebandSlotBytes;
  const laneBytes = RELAY_LIMITS.sidebandSlots * slotBytes;
  expect(slotBytes).toBe(256);
  expect(laneBytes).toBe(512);
  const creditTable = new RelayCreditTable();
  const rx = new RelayReceiver(
    SESSION, new Map([[0, controlSlice()], [1, { frames: 2, bytes: 2 * GET_WIRE }]]), creditTable,
  );

  // Two records of exactly one slot each fill the lane to the byte.
  const r1 = resetRecordOf(1, slotBytes);
  const r2 = resetRecordOf(2, slotBytes);
  expect(rx.canIngestSideband(r1.bytes.length)).toBe(true);
  expect(rx.ingestSideband(r1.frame, r1.bytes.length).ok).toBe(true);
  expect(rx.canIngestSideband(r2.bytes.length)).toBe(true);
  expect(rx.ingestSideband(r2.frame, r2.bytes.length).ok).toBe(true);
  expect(rx.sidebandOccupancy()).toEqual({ frames: 2, bytes: laneBytes });
  expect(rx.sessionFatal).toBe(false);
  // Taking both frees all 512 bytes with no credit row (§3.9: the lane
  // earns no credit).
  expect(rx.pumpSideband().map((r) => r.wireBytes)).toEqual([slotBytes, slotBytes]);
  expect(rx.sidebandOccupancy()).toEqual({ frames: 0, bytes: 0 });
  expect(creditTable.counters(0)).toBeUndefined();

  // One byte over a slot never fits, even with the lane empty: the peer
  // broke the reservation, so the receiver ends the session (§3.9: excess
  // is a protocol error). This is the receive-side twin of SIDEBAND_LARGE.
  const big = resetRecordOf(3, slotBytes + 1);
  const refused = rx.ingestSideband(big.frame, big.bytes.length);
  expect(refused.ok).toBe(false);
  expect(refused.code).toBe(RELAY_P3_ERROR.SESSION_FATAL);
  expect(rx.sessionFatal).toBe(true);
  expect(rx.sidebandOccupancy()).toEqual({ frames: 0, bytes: 0 });
});

test("receive sideband (B-b): applyReset(0) discards staged lane records — nothing delivers afterwards, no credit is produced, the lane is closed", () => {
  const creditTable = new RelayCreditTable();
  const rx = new RelayReceiver(
    SESSION, new Map([[0, controlSlice()], [1, { frames: 2, bytes: 2 * GET_WIRE }]]), creditTable,
  );
  const cancel = (seq: number) => {
    const bytes = wireRecord(0, seq, 7, {
      op: RELAY_OP.REQUEST_CANCEL, targetStream: 1, reason: "x",
    }, RELAY_TYPE.CANCEL);
    const dec = decodeFrame(bytes);
    if (!dec.ok) throw new Error(dec.code);
    return { bytes, frame: dec.frame };
  };
  const c1 = cancel(1);
  expect(rx.ingestSideband(c1.frame, c1.bytes.length).ok).toBe(true);
  expect(rx.sidebandOccupancy()).toEqual({ frames: 1, bytes: c1.bytes.length });

  const reset = rx.applyReset(0, "peer reset");
  expect(reset.ok).toBe(true);
  // Occupancy is read before the pump so the pump cannot be what empties
  // the lane; both must already show the discard.
  const after = rx.sidebandOccupancy();
  const delivered = rx.pumpSideband();
  expect(after).toEqual({ frames: 0, bytes: 0 });
  expect(delivered).toEqual([]);
  // The undelivered control earned no stream-0 credit row.
  expect(creditTable.counters(0)).toBeUndefined();
  // Stream 0 is dead: the lane is closed to the transport and to ingest.
  expect(rx.sessionFatal).toBe(true);
  const c2 = cancel(2);
  expect(rx.canIngestSideband(c2.bytes.length)).toBe(false);
  expect(rx.ingestSideband(c2.frame, c2.bytes.length).code).toBe(RELAY_P3_ERROR.SESSION_FATAL);
  expect(rx.sidebandOccupancy()).toEqual({ frames: 0, bytes: 0 });
});

// ---------------------------------------------------------------------------
// Step 9 — §3.9 row audit: rows whose rule had no assertion (probes P-a/P-b/
// P-e/P-n survived single-point mutation before these tests existed)
// ---------------------------------------------------------------------------

test("sender (§3.9 frame pump): with no configured budget one pump moves at most two normal frames", () => {
  const sender = new RelaySender(SESSION, new RelaySideband(), {
    windowFrames: ATTACH.frames, windowBytes: ATTACH.bytes, controlSlice: controlSlice(),
    maxWireBytes: RELAY_LIMITS.controlMaxWireBytes,
  });
  expect(sender.openStream(1, { frames: 4, bytes: 4 * GET_WIRE }).ok).toBe(true);
  for (const corr of [1, 2, 3]) {
    expect(sender.admit({ type: RELAY_TYPE.REQUEST, stream: 1, correlation: corr, metadata: GET_META }).ok).toBe(true);
  }
  // "每guest逻辑帧普通submit≤2": the default budget is two, not the window.
  const first = sender.pump();
  expect(first.ok).toBe(true);
  expect(first.frames.length).toBe(2);
  expect(sender.queuedFrames(1)).toBe(1);
  const second = sender.pump();
  expect(second.frames.length).toBe(1);
  expect(sender.queuedFrames(1)).toBe(0);
});

test("sender (§3.9 selection order): the sideband drains before normal work within one pump; stream-0 seq follows selection order", () => {
  const ep = new Endpoint(SESSION, [{ stream: 1, slice: { frames: 2, bytes: 2 * GET_WIRE } }]);
  // Normal work is admitted first: a management OPEN on stream 0 (control
  // band) and a business GET on stream 1 (visible band)...
  expect(ep.sender.admit({
    type: RELAY_TYPE.REQUEST, stream: 0, correlation: 1,
    priority: RELAY_PRIORITY.CONTROL, metadata: OPEN_META,
  }).ok).toBe(true);
  expect(ep.sender.admit({ type: RELAY_TYPE.REQUEST, stream: 1, correlation: 2, metadata: GET_META }).ok).toBe(true);
  // ...then a CANCEL is queued on the lane after both.
  expect(ep.sender.cancel(1, 2, "user left").ok).toBe(true);
  const out = pumpDecoded(ep).map((o) => ({ type: o.frame.type, stream: o.frame.stream, seq: o.frame.seq }));
  // "primary先选择sideband再选择普通待送work，并在选定后分配stream0的seq".
  expect(out).toEqual([
    { type: RELAY_TYPE.CANCEL, stream: 0, seq: 1 },
    { type: RELAY_TYPE.REQUEST, stream: 0, seq: 2 },
    { type: RELAY_TYPE.REQUEST, stream: 1, seq: 1 },
  ]);
});

test("sender (§3.9 reason clip): cancel() and sendReset() clip a long reason to 64 UTF-8 bytes without splitting a character", () => {
  const ep = new Endpoint(SESSION, [{ stream: 1, slice: { frames: 2, bytes: 2 * GET_WIRE } }]);
  const long = "é".repeat(100); // 200 UTF-8 bytes
  expect(ep.sender.cancel(1, 7, long).ok).toBe(true);
  expect(ep.sender.sendReset(1, long).ok).toBe(true);
  const [cancel, reset] = pumpDecoded(ep);
  expect(cancel.frame.type).toBe(RELAY_TYPE.CANCEL);
  expect(reset.frame.metadata.op).toBe(RELAY_OP.RESET);
  for (const { frame } of [cancel, reset]) {
    const reason = frame.metadata.reason as string;
    expect(new TextEncoder().encode(reason).length).toBe(RELAY_LIMITS.cancelReasonMaxBytes);
    expect(reason).toBe("é".repeat(32)); // 32 two-byte characters fill the 64-byte cap exactly
  }
});

test("beginSession (§3.9 credit row, a session change voids everything): lane staging, staged frames, seq state and window counters restart", () => {
  const slice = { frames: 2, bytes: 2 * GET_WIRE };
  const a = new Endpoint(SESSION, [{ stream: 1, slice }]);
  const b = new Endpoint(SESSION, [{ stream: 1, slice }]);
  // Session 1: a CANCEL sits in B's lane and a business frame in B's staging.
  expect(a.sender.admit({ type: RELAY_TYPE.REQUEST, stream: 1, correlation: 1, metadata: GET_META }).ok).toBe(true);
  expect(a.sender.cancel(1, 1, "x").ok).toBe(true);
  const [side, biz] = pumpDecoded(a);
  expect(side.frame.type).toBe(RELAY_TYPE.CANCEL);
  expect(b.receiver.ingestSideband(side.frame, side.bytes.length).ok).toBe(true);
  expect(b.receiver.ingest(biz.frame, biz.bytes.length).ok).toBe(true);
  expect(b.receiver.sidebandOccupancy().frames).toBe(1);
  expect(b.receiver.occupancyStream(1).frames).toBe(1);
  expect(a.sender.ledgerView().inFlight(1)).toEqual({ frames: 1, bytes: GET_WIRE });

  // Session 2 on both ends.
  const NEXT = SESSION + 1n;
  b.receiver.beginSession(NEXT, b.slices);
  a.sender.beginSession(NEXT, [{ stream: 1, slice }]);
  // Receive side: lane and staging are empty (occupancy read before the
  // pumps, so a pump cannot be what empties them), nothing delivers, and
  // the session is live again.
  const lane = b.receiver.sidebandOccupancy();
  const staged = b.receiver.occupancyStream(1);
  expect(b.receiver.pumpSideband()).toEqual([]);
  expect(b.receiver.pump()).toEqual([]);
  expect(lane).toEqual({ frames: 0, bytes: 0 });
  expect(staged).toEqual({ frames: 0, bytes: 0 });
  expect(b.receiver.sessionFatal).toBe(false);
  // Send side: the window is empty and session-1 credit is out of range.
  expect(a.sender.ledgerView().inFlight(1)).toEqual({ frames: 0, bytes: 0 });
  expect(a.sender.applyCredit({
    targetStream: 1, framesReleased: "0000000000000001",
    bytesReleased: GET_WIRE.toString(16).padStart(16, "0"),
  }).code).toBe(RELAY_P3_ERROR.CREDIT_RANGE);
  // A session-1 record is refused by the session-2 receiver; the first
  // session-2 frame restarts stream-1 seq at 1 and ingests.
  expect(b.receiver.ingest(biz.frame, biz.bytes.length).code).toBe(RELAY_P3_ERROR.SESSION_FATAL);
  expect(a.sender.admit({ type: RELAY_TYPE.REQUEST, stream: 1, correlation: 1, metadata: GET_META }).ok).toBe(true);
  const [fresh] = pumpDecoded(a);
  expect(fresh.frame.session).toBe(NEXT);
  expect(fresh.frame.seq).toBe(1);
  expect(b.receiver.ingest(fresh.frame, fresh.bytes.length).ok).toBe(true);
});

test("sender (§3.9 control wire): a normal frame of exactly 4096 wire bytes admits; one byte more is refused at admission and nothing is queued", () => {
  const cap = RELAY_LIMITS.controlMaxWireBytes;
  expect(cap).toBe(4096);
  const ep = new Endpoint(SESSION, [{ stream: 1, slice: { frames: 2, bytes: 2 * cap } }]);
  // A resource.get whose key is padded so the wire record (4-byte length
  // prefix + 44-byte header + metadata) is exactly `wireBytes` long.
  const getOf = (wireBytes: number) => {
    const meta = (key: string) => ({ op: "resource.get", resource: { kind: 1, ns: "ns", key, rendition: "r" } });
    const probe = prepareFrameBody({ type: RELAY_TYPE.REQUEST, stream: 1, metadata: meta("k") }, { maxWireBytes: 65536 });
    if (!probe.ok) throw new Error(probe.code);
    return meta("k".repeat(1 + wireBytes - probe.body.wireBytes));
  };
  expect(ep.sender.admit({ type: RELAY_TYPE.REQUEST, stream: 1, correlation: 1, metadata: getOf(cap) }).ok).toBe(true);
  const over = ep.sender.admit({ type: RELAY_TYPE.REQUEST, stream: 1, correlation: 2, metadata: getOf(cap + 1) });
  expect(over.ok).toBe(false);
  expect(over.code as string).toBe(RELAY_FRAME_ERROR.WIRE_TOO_LARGE); // admit() forwards the frame-layer code
  expect(ep.sender.queuedFrames(1)).toBe(1);
  const [only] = pumpDecoded(ep);
  expect(only.bytes.length).toBe(cap);
  expect(only.frame.seq).toBe(1);
});

// ---------------------------------------------------------------------------
// Review 1070 M4/M5: the read gate classifies an over-slot control, and a
// stream-0 fatal stops delivery on both lanes
// ---------------------------------------------------------------------------

test("M4: an over-slot whitelisted control passes the read gate as fatal, so the transport reaches SESSION_FATAL instead of waiting", () => {
  // Review 1070's OVERSIZED_SIDEBAND_GATE probe: a 466-byte credit was false
  // at canIngestSideband before and after pumping, and only a forced ingest
  // produced the fatal classification.
  const rx = new RelayReceiver(SESSION, new Map([[0, controlSlice()], [1, { frames: 4, bytes: 4096 }]]), new RelayCreditTable());
  const oversized = wireRecord(0, 1, 0, {
    op: RELAY_OP.CREDIT, targetStream: 1, framesReleased: "0000000000000000",
    bytesReleased: "0000000000000000", pad: "p".repeat(300),
  }, RELAY_TYPE.PUSH);
  const dec = decodeFrame(oversized);
  if (!dec.ok) throw new Error(dec.code);
  expect(isSidebandFrame(dec.frame)).toBe(true);
  expect(oversized.length).toBeGreaterThan(RELAY_LIMITS.sidebandSlotBytes);
  expect(rx.sidebandAdmission(oversized.length)).toBe("fatal");
  expect(rx.canIngestSideband(oversized.length)).toBe(true);
  rx.pumpSideband();
  expect(rx.canIngestSideband(oversized.length)).toBe(true);
  expect(rx.ingest(dec.frame, oversized.length)).toEqual({ ok: false, code: RELAY_P3_ERROR.SIDEBAND_FORBIDDEN });
  expect(rx.ingestSideband(dec.frame, oversized.length)).toEqual({ ok: false, code: RELAY_P3_ERROR.SESSION_FATAL });
  expect(rx.sessionFatal).toBe(true);
  // The lane is closed once the session is dead: false for every size.
  expect(rx.sidebandAdmission(64)).toBe("fatal");
  expect(rx.canIngestSideband(64)).toBe(false);

  // A live lane distinguishes "wait" (both slots held) from "stage".
  const live = new RelayReceiver(SESSION, new Map([[0, controlSlice()]]), new RelayCreditTable());
  const cancel = (seq: number) => {
    const bytes = wireRecord(0, seq, 7, { op: RELAY_OP.REQUEST_CANCEL, targetStream: 1, reason: "x" }, RELAY_TYPE.CANCEL);
    const d = decodeFrame(bytes);
    if (!d.ok) throw new Error(d.code);
    return { bytes, frame: d.frame };
  };
  const c1 = cancel(1), c2 = cancel(2), c3 = cancel(3);
  expect(live.sidebandAdmission(c1.bytes.length)).toBe("stage");
  expect(live.ingestSideband(c1.frame, c1.bytes.length).ok).toBe(true);
  expect(live.ingestSideband(c2.frame, c2.bytes.length).ok).toBe(true);
  expect(live.sidebandAdmission(c3.bytes.length)).toBe("wait");
  expect(live.canIngestSideband(c3.bytes.length)).toBe(false);
  expect(live.pumpSideband(1).length).toBe(1);
  expect(live.sidebandAdmission(c3.bytes.length)).toBe("stage");
  expect(live.canIngestSideband(c3.bytes.length)).toBe(true);
  expect(live.ingestSideband(c3.frame, c3.bytes.length).ok).toBe(true);
  expect(live.sessionFatal).toBe(false);
});

test("M5: after a stream-0 fatal nothing delivers from either lane and nothing ingests", () => {
  // Review 1070's SIDEBAND_DELIVERY_AFTER_FATAL probe: a staged CANCEL was
  // delivered after a stream-0 seq hole had ended the attachment.
  const rx = new RelayReceiver(SESSION, new Map([[0, controlSlice()], [1, { frames: 4, bytes: 4096 }]]), new RelayCreditTable());
  const cancel = wireRecord(0, 1, 7, { op: RELAY_OP.REQUEST_CANCEL, targetStream: 1, reason: "x" }, RELAY_TYPE.CANCEL);
  const cancelDec = decodeFrame(cancel);
  if (!cancelDec.ok) throw new Error(cancelDec.code);
  expect(rx.ingestSideband(cancelDec.frame, cancel.length).ok).toBe(true);
  const biz = wireRecord(1, 1, 1, GET_META);
  const bizDec = decodeFrame(biz);
  if (!bizDec.ok) throw new Error(bizDec.code);
  expect(rx.ingest(bizDec.frame, biz.length).ok).toBe(true);
  // A stream-0 seq hole ends the attachment.
  const gap = wireRecord(0, 99, 1, { op: RELAY_OP.OPEN, stream: 1 });
  const gapDec = decodeFrame(gap);
  if (!gapDec.ok) throw new Error(gapDec.code);
  expect(rx.ingest(gapDec.frame, gap.length)).toEqual({ ok: false, code: RELAY_P3_ERROR.SESSION_FATAL });
  expect(rx.sessionFatal).toBe(true);
  expect(rx.pumpSideband()).toEqual([]);
  expect(rx.pump()).toEqual([]);
  // Staged occupancy is unchanged (nothing was delivered or released) and a
  // later business record is refused with the session verdict.
  expect(rx.sidebandOccupancy().frames).toBe(1);
  expect(rx.occupancyStream(1).frames).toBe(1);
  const later = wireRecord(1, 2, 2, GET_META);
  const laterDec = decodeFrame(later);
  if (!laterDec.ok) throw new Error(laterDec.code);
  expect(rx.ingest(laterDec.frame, later.length)).toEqual({ ok: false, code: RELAY_P3_ERROR.SESSION_FATAL });
});
