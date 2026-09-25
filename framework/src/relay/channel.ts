/** Guest side of the relay L0 byte channel (contracts/spec/relay-channel.ts).
 *
 * It owns one scratch buffer for its lifetime and moves at most
 * RELAY_CHANNEL.deliveriesPerFrame records into the session per frame, so a
 * busy companion costs the guest heap nothing and the frame budget a fixed
 * amount. Everything above the record boundary — HELLO, credit, chunking,
 * assembly — belongs to RelayEndpoint; this module never inspects a frame.
 */

import { RELAY_CHANNEL, relayChannelRxLimits, type RelayChannelOps } from "../../../contracts/spec/relay-channel.ts";
import { registerServicePump } from "../services.ts";
import type { RelayPeerContext, RelaySendStatus, RelayTransportAdapter } from "./session.ts";

export { RELAY_CHANNEL, relayChannelRxLimits };
export type { RelayChannelOps };

export interface RelayChannelStats {
  session: number;
  /** Records handed to the host and accepted. */
  sent: number;
  /** Records the host refused for want of credit. */
  refused: number;
  /** Records delivered to the session. */
  received: number;
  /** Records the host reported as oversized for the scratch buffer. */
  oversized: number;
  bytesIn: number;
  bytesOut: number;
  /** Native counters when the host publishes them. */
  native?: string;
}

export interface RelayChannel {
  /** The L0 adapter a RelayEndpoint sends through. */
  readonly transport: RelayTransportAdapter;
  /** Positive authenticated attachment generation; zero while detached. */
  session(): number;
  /** Deliver inbound records to the handler; returns how many were moved.
   * Registered as a service pump, so a guest that never calls it still
   * drains one budget per frame. */
  step(): number;
  /** The single record sink. Replacing it replaces the session above. */
  onRecord(handler: (record: Uint8Array) => void): void;
  /** The attachment generation changed: the owner starts a new session or
   * discards the old one. Reported from step(), before any record of the
   * new generation is delivered. */
  onSession(handler: (session: number) => void): void;
  /** End of one lane frame, after the delivery budget was spent. A session
   * whose outbox the lane refused earlier retries here: without it, an
   * endpoint with nothing arriving has no event to send on. */
  onStep(handler: (delivered: number) => void): void;
  stats(): RelayChannelStats;
  /** Release the service pump; the ops stay owned by the host. */
  close(): void;
}

const nativeOps = () => (globalThis as unknown as { relayChannel?: RelayChannelOps }).relayChannel;

/** Build a channel over explicit ops. Tests and desktop hosts pass their own;
 * `relayChannel()` passes the native ones. */
export function createRelayChannel(ops: RelayChannelOps, peer: RelayPeerContext): RelayChannel {
  const scratch = new Uint8Array(RELAY_CHANNEL.recordBytes);
  let handler: ((record: Uint8Array) => void) | undefined;
  let sessionHandler: ((session: number) => void) | undefined;
  let stepHandler: ((delivered: number) => void) | undefined;
  let lastSession = 0;
  let sent = 0, refused = 0, received = 0, oversized = 0, bytesIn = 0, bytesOut = 0;
  let submissions = 0, pumped = false;
  const transport: RelayTransportAdapter = {
    peer,
    trySend(bytes: Uint8Array): RelaySendStatus {
      if (ops.session() <= 0) return "offline";
      // The record is one slot by contract; a longer one is a producer bug
      // above this layer, never a truncated write.
      if (bytes.length > RELAY_CHANNEL.recordBytes) return "offline";
      if (submissions >= RELAY_CHANNEL.submissionsPerFrame) { refused++; return "busy"; }
      if (!ops.send(bytes)) { refused++; return "busy"; }
      submissions++; sent++; bytesOut += bytes.length;
      return "accepted";
    },
  };
  const step = (): number => {
    submissions = 0;
    const session = ops.session();
    if (session !== lastSession) { lastSession = session; sessionHandler?.(session); }
    if (session <= 0) return 0;
    let moved = 0;
    if (handler) {
      for (let i = 0; i < RELAY_CHANNEL.deliveriesPerFrame; i++) {
        const length = ops.take(scratch);
        if (length <= 0) break;
        if (length > scratch.length) { oversized++; continue; }
        received++; bytesIn += length; moved++;
        handler(scratch.subarray(0, length));
      }
    }
    stepHandler?.(moved);
    return moved;
  };
  let unregister: (() => void) | undefined;
  const pump = () => { if (!pumped) { pumped = true; unregister = registerServicePump(() => { step(); }); } };
  return {
    transport,
    session: () => ops.session(),
    step() { pump(); return step(); },
    onRecord(next) { handler = next; pump(); },
    onSession(next) { sessionHandler = next; pump(); },
    onStep(next) { stepHandler = next; pump(); },
    stats: () => ({ session: ops.session(), sent, refused, received, oversized, bytesIn, bytesOut, native: ops.stats?.() }),
    close() { unregister?.(); unregister = undefined; pumped = false; handler = undefined; sessionHandler = undefined; stepHandler = undefined; lastSession = 0; },
  };
}

/** The relay session a channel owner binds to one attachment. RelayEndpoint
 * owners (the guest client that wraps it) implement these four. */
export interface RelayChannelSession {
  /** Start the §3.2 handshake; a no-op unless the endpoint is idle. */
  connect(): void;
  /** Discard the session: pending work fails and the endpoint returns to
   * idle, so the next connect() is a new handshake. */
  disconnect(reason: string): void;
  handleRecord(record: Uint8Array): void;
  /** End of one lane frame. */
  step(): void;
}

/** Bind one relay session to the channel's attachment generation.
 *
 * Every generation change is a different companion link
 * (contracts/spec/relay-channel.ts), so the old session is discarded and the
 * handshake runs once against the new peer. That holds when one positive
 * generation follows another: a host that re-attaches between two step()
 * calls never shows the guest a zero, and a session kept across that edge
 * would hold streams, subscriptions and correlations the new peer has no
 * record of. The discard runs inside the onSession report, which step()
 * makes before it delivers any record of the new generation.
 */
export function attachRelaySession(channel: RelayChannel, session: RelayChannelSession): void {
  let attached = 0;
  channel.onSession(generation => {
    if (attached > 0) session.disconnect(generation > 0 ? "relay attachment replaced" : "relay channel detached");
    attached = generation > 0 ? generation : 0;
    if (generation > 0) session.connect();
  });
  channel.onRecord(record => session.handleRecord(record));
  channel.onStep(() => session.step());
  // One step now, so an attachment that is already up starts its handshake
  // here rather than a frame later, and the channel holds the generation
  // every later step compares against.
  channel.step();
}

let channel: RelayChannel | undefined;

/** The realm's relay channel, or undefined on a host without the lane. One
 * channel per realm: the ops carry one authenticated attachment. */
export function relayChannel(peer?: RelayPeerContext): RelayChannel | undefined {
  if (channel) return channel;
  const ops = nativeOps();
  if (!ops) return undefined;
  channel = createRelayChannel(ops, peer ?? { id: "companion", grants: [] });
  return channel;
}

/** Tests and hosts that rebuild the realm. */
export function resetRelayChannel(): void {
  channel?.close();
  channel = undefined;
}
