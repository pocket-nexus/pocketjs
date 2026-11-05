import { expect, test } from "bun:test";
import { RELAY_CHANNEL, attachRelaySession, createRelayChannel, relayChannelRxLimits, relayChannel, resetRelayChannel, type RelayChannelOps, type RelayChannelSession } from "../framework/src/relay/channel.ts";
import { runServicePumps } from "../framework/src/services.ts";

/** A host lane with the contract's bounds: `slots` records and
 * `windowBytes` per direction, released when the consumer takes them. */
function fakeLane() {
  const queue: Uint8Array[] = [];
  let queued = 0, session = 1, dropped = 0;
  return {
    ops: {
      session: () => session,
      send(record: Uint8Array) {
        if (session <= 0) return false;
        if (queue.length >= RELAY_CHANNEL.slots) return false;
        if (queued + record.length > RELAY_CHANNEL.windowBytes) return false;
        queue.push(record.slice()); queued += record.length;
        return true;
      },
      take(into: Uint8Array) {
        const next = queue[0];
        if (!next) return 0;
        if (next.length > into.length) { queue.shift(); queued -= next.length; dropped++; return into.length + 1; }
        queue.shift(); queued -= next.length;
        into.set(next);
        return next.length;
      },
      stats: () => `queued=${queue.length} dropped=${dropped}`,
    } satisfies RelayChannelOps,
    push(bytes: Uint8Array) { queue.push(bytes); queued += bytes.length; },
    detach() { session = 0; },
    attach(n: number) { session = n; },
    get depth() { return queue.length; },
  };
}

const peer = { id: "companion", grants: ["pocket-map"] };

test("the relay channel advertises the lane's receiver guarantees", () => {
  expect(relayChannelRxLimits()).toEqual({
    maxWireBytes: RELAY_CHANNEL.recordBytes,
    windowFrames: RELAY_CHANNEL.slots,
    windowBytes: RELAY_CHANNEL.windowBytes,
  });
  // One slot holds one complete record: a negotiated maxWireBytes can never
  // exceed what the host can carry.
  expect(RELAY_CHANNEL.recordBytes).toBeLessThanOrEqual(RELAY_CHANNEL.windowBytes);
  expect(RELAY_CHANNEL.slots * RELAY_CHANNEL.recordBytes).toBeGreaterThanOrEqual(RELAY_CHANNEL.windowBytes);
});

test("sends are bounded per frame and by the host's credit; a detached lane is offline", () => {
  const lane = fakeLane();
  const channel = createRelayChannel(lane.ops, peer);
  const record = new Uint8Array(64);
  // submissionsPerFrame per step, then busy until the next step.
  for (let i = 0; i < RELAY_CHANNEL.submissionsPerFrame; i++) expect(channel.transport.trySend(record)).toBe("accepted");
  expect(channel.transport.trySend(record)).toBe("busy");
  channel.step();
  expect(channel.transport.trySend(record)).toBe("accepted");
  // The host's own credit refuses the rest; nothing is queued in the guest.
  channel.step();
  while (lane.depth < RELAY_CHANNEL.slots) lane.push(record.slice());
  expect(channel.transport.trySend(record)).toBe("busy");
  expect(lane.depth).toBe(RELAY_CHANNEL.slots);
  // A record above one slot is refused, never split.
  expect(channel.transport.trySend(new Uint8Array(RELAY_CHANNEL.recordBytes + 1))).toBe("offline");
  lane.detach();
  expect(channel.transport.trySend(record)).toBe("offline");
  expect(channel.stats().refused).toBeGreaterThan(0);
  channel.close();
});

test("takes are bounded per frame and reuse one scratch buffer; an oversized record is dropped", () => {
  const lane = fakeLane();
  const channel = createRelayChannel(lane.ops, peer);
  const seen: { buffer: ArrayBufferLike; length: number }[] = [];
  channel.onRecord(record => seen.push({ buffer: record.buffer, length: record.length }));
  for (let i = 0; i < 5; i++) lane.push(new Uint8Array(48 + i).fill(i + 1));
  expect(channel.step()).toBe(RELAY_CHANNEL.deliveriesPerFrame);
  expect(channel.step()).toBe(RELAY_CHANNEL.deliveriesPerFrame);
  expect(channel.step()).toBe(1);
  expect(channel.step()).toBe(0);
  expect(seen.map(s => s.length)).toEqual([48, 49, 50, 51, 52]);
  // Every delivery views the one buffer the channel allocated at construction.
  expect(new Set(seen.map(s => s.buffer)).size).toBe(1);
  lane.push(new Uint8Array(RELAY_CHANNEL.recordBytes + 1));
  channel.step();
  expect(channel.stats().oversized).toBe(1);
  expect(channel.stats().received).toBe(5);
  expect(channel.stats().native).toContain("dropped=1");
  channel.close();
});

test("an attachment generation change is reported before the records of the new generation", () => {
  const lane = fakeLane();
  const channel = createRelayChannel(lane.ops, peer);
  const seen: (number | string)[] = [];
  channel.onSession(session => seen.push(session));
  channel.onRecord(() => seen.push("record"));
  lane.push(new Uint8Array(48));
  channel.step();
  expect(seen).toEqual([1, "record"]);
  channel.step();
  lane.detach();
  channel.step();
  lane.attach(2);
  lane.push(new Uint8Array(48));
  channel.step();
  expect(seen).toEqual([1, "record", 0, 2, "record"]);
  channel.close();
});

test("the channel registers one service pump and releases it on close", () => {
  const lane = fakeLane();
  const channel = createRelayChannel(lane.ops, peer);
  let delivered = 0;
  channel.onRecord(() => { delivered++; });
  lane.push(new Uint8Array(48));
  runServicePumps();
  expect(delivered).toBe(1);
  channel.close();
  lane.push(new Uint8Array(48));
  runServicePumps();
  expect(delivered).toBe(1);
});

test("relayChannel() is absent without the host global and memoized with it", () => {
  resetRelayChannel();
  expect(relayChannel()).toBeUndefined();
  const lane = fakeLane();
  (globalThis as unknown as { relayChannel?: RelayChannelOps }).relayChannel = lane.ops;
  try {
    const first = relayChannel(peer);
    expect(first).toBeDefined();
    expect(relayChannel(peer)).toBe(first);
    expect(first!.session()).toBe(1);
    lane.detach();
    expect(first!.session()).toBe(0);
  } finally {
    resetRelayChannel();
    delete (globalThis as unknown as { relayChannel?: RelayChannelOps }).relayChannel;
  }
});

test("a relay session attached to the channel rehandshakes on every generation change, including positive to positive", () => {
  const lane = fakeLane();
  const channel = createRelayChannel(lane.ops, peer);
  const log: string[] = [];
  const session: RelayChannelSession = {
    connect: () => log.push("connect"),
    disconnect: reason => log.push(`disconnect:${reason}`),
    handleRecord: () => log.push("record"),
    step: () => log.push("step"),
  };
  attachRelaySession(channel, session);
  // The attachment was already up: one handshake, no discard before it.
  expect(log).toEqual(["connect", "step"]);
  // One positive generation replaces another with no detached frame between
  // them: the old session is discarded, one new handshake runs, and both
  // happen before the first record of generation 2.
  log.length = 0;
  lane.attach(2);
  lane.push(new Uint8Array(48));
  channel.step();
  expect(log).toEqual(["disconnect:relay attachment replaced", "connect", "record", "step"]);
  // No change: neither a discard nor a second handshake.
  log.length = 0;
  channel.step();
  expect(log).toEqual(["step"]);
  // Detached, then a third generation: the zero discards and the positive
  // handshakes; a detached lane starts no session.
  log.length = 0;
  lane.detach();
  channel.step();
  expect(log).toEqual(["disconnect:relay channel detached"]);
  log.length = 0;
  lane.attach(3);
  channel.step();
  expect(log).toEqual(["connect", "step"]);
  channel.close();
});
