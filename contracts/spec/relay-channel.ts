/** Host contract for the relay L0 byte channel (draft §3.1): the authenticated
 * record lane a device host opens to its paired companion, exposed to the guest
 * realm as `globalThis.relayChannel`.
 *
 * The lane carries complete relay records only. A record never spans two
 * take() calls and never merges with another, so the guest never reassembles
 * a stream: the host owns framing, the guest owns L1/L2.
 *
 * Every bound here is a fixed allocation. A host reserves
 * `slots * recordBytes` per direction at start and refuses work beyond
 * `windowBytes`; a guest holds exactly one `recordBytes` scratch buffer for
 * its lifetime. Neither side grows a queue under backpressure: send() answers
 * false and the caller keeps its own bounded work.
 */

export const RELAY_CHANNEL = Object.freeze({
  version: 1,
  /** Largest complete record, 48-byte header included. This is the
   * `maxWireBytes` a guest on this channel may advertise: the negotiated
   * value is min(local, peer), so a record can never exceed one slot. */
  recordBytes: 16384,
  /** Records one direction holds before send() refuses. */
  slots: 8,
  /** Bytes charged to one direction until its consumer drains them. */
  windowBytes: 65536,
  /** Records the guest takes per host frame. */
  deliveriesPerFrame: 2,
  /** Records the guest hands the host per frame. */
  submissionsPerFrame: 2,
  /** The companion listens here; the device dials it (offload uses 8741). */
  port: 8742,
});

/** Native ops. The shape mirrors OffloadOps: a generation counter, a
 * nonwaiting bounded submit and a take that performs no IO. */
export interface RelayChannelOps {
  /** Positive authenticated attachment generation; zero/negative = detached.
   * The value changes when the companion link is re-established, so the
   * guest discards its session state on a change. */
  session(): number;
  /** Nonwaiting bounded copy of one complete record. False means no credit
   * (slots or window full, or the lane is detached): the caller retains the
   * record and retries on a later frame. */
  send(record: Uint8Array): boolean;
  /** Copies the next complete record into `into` and returns its length; 0
   * means none is ready. A record longer than `into` is dropped by the host
   * and reported through stats, never truncated into the guest. */
  take(into: Uint8Array): number;
  /** Optional one-line diagnostics, as OffloadOps.uploadCoverage is optional. */
  stats?(): string;
}

/** Receiver guarantees a guest may advertise on this channel. windowFrames
 * and windowBytes are the host's inbound queue, so the peer cannot put more
 * in flight than the lane holds. */
export function relayChannelRxLimits(): {
  maxWireBytes: number;
  windowFrames: number;
  windowBytes: number;
} {
  return {
    maxWireBytes: RELAY_CHANNEL.recordBytes,
    windowFrames: RELAY_CHANNEL.slots,
    windowBytes: RELAY_CHANNEL.windowBytes,
  };
}
