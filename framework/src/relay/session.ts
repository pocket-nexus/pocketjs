/** Relay L1 session state machine — one implementation for both roles.
 *
 * The guest (device) and the provider (companion) run the same six-step
 * handshake from R5 draft §3.2:
 *
 *   guest HELLO (session 0, seq 1, correlation 1)
 *     -> provider HELLO response (random u64 session, exact selection)
 *   guest READY on the new session (seq/correlation restart at 1)
 *     -> provider READY ack; both sides READY
 *   OPEN allocates provider-owned, never-reused stream ids
 *   PING every 2 s; 15 s without an inbound frame ends the session
 *
 * Scope: session/stream/seq, version/profile/codec/limits negotiation,
 * liveness and stale-session fencing. Resource delivery (L2) and credit
 * accounting (§3.9) are not implemented here: business frames leave the
 * machine through `onBusinessFrame`, credit/reset/CANCEL through hooks, and
 * the composed endpoint (`endpoint.ts`) takes every post-bootstrap control
 * frame through `admitControl` so the P3 sender assigns seq at selection.
 * `sendBusiness` is the bare P2 path for a machine that runs without the
 * endpoint.
 *
 * The machine holds no socket: the injected transport adapter owns the
 * authenticated peer and bounded delivery (draft §3.1 L0). It never reads
 * identity claims out of HELLO metadata; the adapter supplies peer grants. */

import {
  RELAY_CODEC,
  RELAY_DEFINED_CODECS,
  RELAY_ERROR,
  RELAY_FRAME,
  RELAY_HANDSHAKE,
  RELAY_LIMITS,
  RELAY_METADATA_SCHEMAS,
  RELAY_OP,
  RELAY_STATUS,
  RELAY_TYPE,
  type RelayMaterializeLimits,
  type RelayProfileEntry,
  type RelayPrivateOpDescriptor,
  type RelayProtocolVersion,
  type RelayRxLimits,
  type RelayTransportDesc,
} from "../../../contracts/spec/relay.ts";
import {
  decodeFrame,
  encodeFrame,
  RELAY_FRAME_ERROR,
  type RelayDecodedFrame,
} from "./frame.ts";
import { validateRelaySchema } from "./metadata-schema.ts";
import {
  freezeRelayCopy, intersectPrivateOps, privateOpForStream, privateSelectionOffered,
  samePrivateProfile, validPrivateOps,
} from "./private-op.ts";

export { RELAY_FRAME_ERROR };

// --- L0 transport adapter ----------------------------------------------------

export type RelaySendStatus = "accepted" | "busy" | "offline";

/** Authenticated connection context. The adapter establishes this before
 * any HELLO; session code trusts this, never JSON self-description. */
export interface RelayPeerContext {
  /** Stable adapter-defined peer identifier (pairing name, cert id, …). */
  id: string;
  /** App namespaces this connection is authorized to open. */
  grants: string[];
}

/** The L0 boundary the session runs on. `trySend` is bounded: a full queue
 * returns "busy" and the caller retries later; a gone connection returns
 * "offline". Records arrive in order, one reassembled record per delivery.
 * Split/coalesced TCP is handled by RelayRecordDecoder in the adapter. */
export interface RelayTransportAdapter {
  trySend(bytes: Uint8Array): RelaySendStatus;
  readonly peer: RelayPeerContext;
}

// --- scheduler and randomness (injectable for deterministic tests) ----------

export interface RelayScheduler {
  now(): number;
  setTimeout(fn: () => void, ms: number): number;
  clearTimeout(id: number): void;
}

const defaultScheduler: RelayScheduler = {
  now: () => Date.now(),
  setTimeout: (fn, ms) => globalThis.setTimeout(fn, ms) as unknown as number,
  clearTimeout: (id) => globalThis.clearTimeout(id),
};

export type RelayRandomBytes = (n: number) => Uint8Array;

const defaultRandomBytes: RelayRandomBytes = (n) => {
  const out = new Uint8Array(n);
  globalThis.crypto.getRandomValues(out);
  return out;
};

// --- negotiated parameters ---------------------------------------------------

export interface RelayNegotiation {
  version: RelayProtocolVersion;
  profiles: RelayProfileEntry[];
  opExt?: RelayPrivateOpDescriptor[];
  codecs: number[];
  kinds: number[];
  grants: string[];
  /** min(local, peer) per field — both receivers honour the same values. */
  rxLimits: RelayRxLimits;
  peerNonce: string;
  transport?: RelayTransportDesc;
}

export type RelayPhase =
  | "idle" // transport attached, nothing sent
  | "hello-sent" // guest: HELLO on session 0, waiting for the response
  | "hello-received" // provider: selection sent, waiting for READY
  | "ready-sent" // guest: READY on the new session, waiting for the ack
  | "ready" // business frames admitted
  | "closed"; // protocol teardown; a new connection starts over

export interface RelaySessionStats {
  framesSent: number;
  framesReceived: number;
  pingsSent: number;
  pingsReceived: number;
  pingTimeouts: number;
  helloBusyRetries: number;
  /** Frames whose session did not match the pinned session. */
  droppedStaleSession: number;
  /** Frames refused because the session was not READY. */
  droppedNotReady: number;
  /** Duplicate/late seq values for a known (session, stream). */
  droppedStaleSeq: number;
  /** Frames the frame codec rejected. */
  droppedDecodeError: number;
  handshakeFailures: number;
}

export interface RelayOpenRequest {
  app: string;
  namespace: string;
  profile: RelayProfileEntry;
  codecs?: number[];
  rxLimits?: RelayRxLimits;
}

export interface RelayOpenResult {
  stream: number;
  namespace: string;
  profile: RelayProfileEntry;
  rxLimits: RelayRxLimits;
  opExt?: RelayPrivateOpDescriptor[];
}

/** A control frame the machine wants to send on the pinned session; the
 * composition layer prepares, queues and stamps it (P3 admission). */
export interface RelayControlAdmission {
  type: number;
  correlation: number;
  metadata: Record<string, unknown>;
}

export interface RelayLocalCapabilities {
  /** Guest only: the app name presented in HELLO/OPEN (<= 64 bytes). */
  app?: string;
  versions: RelayProtocolVersion[];
  profiles: RelayProfileEntry[];
  /** Descriptor-only seam for bare sessions. Endpoints derive this from privateOps. */
  opExt?: RelayPrivateOpDescriptor[];
  codecs: number[];
  kinds: number[];
  rxLimits: RelayRxLimits;
  materialize?: RelayMaterializeLimits;
  transport?: RelayTransportDesc;
}

export interface RelaySessionOptions {
  role: "guest" | "provider";
  transport: RelayTransportAdapter;
  local: RelayLocalCapabilities;
  scheduler?: RelayScheduler;
  randomBytes?: RelayRandomBytes;
  pingIntervalMs?: number;
  stallMs?: number;
  retryMs?: number;
  /** Provider hook: return a stable RELAY_ERROR code string to refuse OPEN. */
  authorizeOpen?: (req: RelayOpenRequest, peer: RelayPeerContext) => string | null;
  onPhase?: (phase: RelayPhase, detail?: { reason?: string }) => void;
  /** L2 (P3+) hook: every non-control frame on a known stream, with the
   * wire length of its record (the window slot it occupies). */
  onBusinessFrame?: (frame: RelayDecodedFrame, wireBytes: number) => void;
  /** §3.9 credit PUSH on stream 0 — recorded, never delivered as business. */
  onCredit?: (metadata: Record<string, unknown>) => void;
  /** relay.reset PUSH: the stream's old requests/subscriptions are dead. */
  onReset?: (metadata: Record<string, unknown>) => void;
  /** Reliable-stream gap/decode error that requires a resync (stream 0
   * errors end the session instead). */
  onStreamError?: (stream: number, code: string) => void;
  /** Composition (P3): once the session is pinned, every control frame the
   * machine emits on it (READY, OPEN, PING and pong) goes here for queue
   * and credit admission; the sender assigns seq at selection and the
   * frame leaves through the endpoint's ordered send path. The bootstrap
   * HELLO exchange on session 0 always goes straight to the transport.
   * Return {ok:false, code:"BUSY"} for a refused frame; the machine treats
   * it like a busy transport (OPEN rejects BUSY, a ping retries). */
  admitControl?: (input: RelayControlAdmission) => { ok: true } | { ok: false; code: string };
  /** Composition (P3): an inbound stream-0 record on the pinned session
   * was consumed by the machine, with its wire length. Runs after dispatch
   * whatever the outcome (a dropped frame held its window slot too), so the
   * endpoint can return the peer's control-slice credit. */
  onControlFrame?: (frame: RelayDecodedFrame, wireBytes: number) => void;
  /** Inbound CANCEL (stream 0, op request.cancel) in READY; the endpoint
   * withdraws the targeted request. Without the hook the frame is dropped. */
  onCancel?: (frame: RelayDecodedFrame) => void;
  /** A stream binding was installed: the guest received an OPEN success,
   * or the provider allocated and answered one. Runs before the guest's
   * open() promise resolves. */
  onStreamOpened?: (result: RelayOpenResult) => void;
}

// --- small helpers -----------------------------------------------------------

const toHex = (bytes: Uint8Array) => Buffer.from(bytes).toString("hex");

function randomHex(random: RelayRandomBytes, n: number): string {
  for (let i = 0; i < 8; i++) {
    const bytes = random(n);
    const hex = toHex(bytes);
    if (!/^0+$/.test(hex)) return hex;
  }
  throw new Error("random source produced all-zero bytes repeatedly");
}

const versionKey = (v: RelayProtocolVersion) => `${v[0]}.${v[1]}`;

const LIMIT_KEYS = [
  "maxWireBytes", "maxMetaBytes", "windowFrames", "windowBytes",
  "maxPending", "maxObjectBytes", "maxAssemblies", "maxScratchBytes",
] as const;

function limitsEqual(a: RelayRxLimits, b: RelayRxLimits): boolean {
  return LIMIT_KEYS.every((k) => a[k] === b[k]);
}

function minLimits(a: RelayRxLimits, b: RelayRxLimits): RelayRxLimits {
  return {
    maxWireBytes: Math.min(a.maxWireBytes, b.maxWireBytes),
    maxMetaBytes: Math.min(a.maxMetaBytes, b.maxMetaBytes),
    windowFrames: Math.min(a.windowFrames, b.windowFrames),
    windowBytes: Math.min(a.windowBytes, b.windowBytes),
    maxPending: Math.min(a.maxPending, b.maxPending),
    maxObjectBytes: Math.min(a.maxObjectBytes, b.maxObjectBytes),
    maxAssemblies: Math.min(a.maxAssemblies, b.maxAssemblies),
    maxScratchBytes: Math.min(a.maxScratchBytes, b.maxScratchBytes),
  };
}

/** Receiver guarantees a peer advertises must themselves be usable: every
 * field positive, and the window must hold at least one full frame. */
export function limitsAreUsable(l: RelayRxLimits): boolean {
  if (!LIMIT_KEYS.every((k) => Number.isSafeInteger(l[k]) && l[k] > 0)) return false;
  return l.maxWireBytes >= RELAY_FRAME.headerBytes && l.windowBytes >= l.maxWireBytes;
}

type PendingOpen = {
  app: string;
  namespace: string;
  profile: RelayProfileEntry;
  rxLimits: RelayRxLimits;
  resolve: (result: RelayOpenResult) => void;
  reject: (code: string) => void;
};

interface StreamBinding {
  app: string;
  namespace: string;
  profile: RelayProfileEntry;
  rxLimits: RelayRxLimits;
  opExt?: RelayPrivateOpDescriptor[];
}

// --- the machine -------------------------------------------------------------

export class RelaySession {
  private readonly scheduler: RelayScheduler;
  private readonly random: RelayRandomBytes;
  private readonly pingIntervalMs: number;
  private readonly stallMs: number;
  private readonly retryMs: number;

  phase: RelayPhase = "idle";
  private session = 0n;
  private bootNonce = "";
  private negotiationValue: RelayNegotiation | undefined;
  /** session-scoped request id; restarts at 1 on every new session. */
  private nextCorrelation = 1;
  private readonly txSeq = new Map<number, number>(); // stream -> last sent
  private readonly rxSeq = new Map<number, number>(); // stream -> last accepted
  private readonly streams = new Map<number, StreamBinding>();
  private nextProviderStream = 1;
  private lastGuestStream = 0;
  private readonly pendingOpen = new Map<number, PendingOpen>();
  private readyResolvers: Array<{
    resolve: (n: RelayNegotiation) => void;
    reject: (e: Error) => void;
  }> = [];
  private pingToken = 0;
  private outstandingPing: number | undefined;
  private pingTimer: number | undefined;
  private stallTimer: number | undefined;
  private retryTimer: number | undefined;
  private closed = false;

  private readonly statsValue: RelaySessionStats = {
    framesSent: 0, framesReceived: 0, pingsSent: 0, pingsReceived: 0,
    pingTimeouts: 0, helloBusyRetries: 0, droppedStaleSession: 0,
    droppedNotReady: 0, droppedStaleSeq: 0, droppedDecodeError: 0,
    handshakeFailures: 0,
  };

  constructor(private readonly options: RelaySessionOptions) {
    this.options = { ...options, local: freezeRelayCopy(options.local) };
    this.scheduler = options.scheduler ?? defaultScheduler;
    this.random = options.randomBytes ?? defaultRandomBytes;
    this.pingIntervalMs = options.pingIntervalMs ?? RELAY_LIMITS.pingIntervalMs;
    this.stallMs = options.stallMs ?? RELAY_LIMITS.stallMs;
    this.retryMs = options.retryMs ?? RELAY_LIMITS.retryMs;
    if (!limitsAreUsable(options.local.rxLimits)) {
      throw new Error("local rxLimits are not usable (positive fields, window >= one frame)");
    }
    if (!validPrivateOps(this.options.local.profiles, this.options.local.opExt, this.options.local.rxLimits)) {
      throw new Error("invalid private op capabilities");
    }
  }

  get negotiation(): RelayNegotiation | undefined { return this.negotiationValue; }
  get sessionId(): bigint { return this.session; }
  getStats(): RelaySessionStats { return { ...this.statsValue }; }

  // --- phase / timer plumbing ------------------------------------------------

  private setPhase(phase: RelayPhase, reason?: string) {
    this.phase = phase;
    this.options.onPhase?.(phase, reason === undefined ? undefined : { reason });
  }

  private clearTimers() {
    if (this.pingTimer !== undefined) this.scheduler.clearTimeout(this.pingTimer);
    if (this.stallTimer !== undefined) this.scheduler.clearTimeout(this.stallTimer);
    if (this.retryTimer !== undefined) this.scheduler.clearTimeout(this.retryTimer);
    this.pingTimer = this.stallTimer = this.retryTimer = undefined;
  }

  /** Protocol teardown: stop all state and ask the L0 side to close. The
   * physical connection belongs to the adapter; onDisconnect drives that. */
  private teardown(reason: string) {
    if (this.closed) return;
    this.closed = true;
    this.clearTimers();
    this.setPhase("closed", reason);
    // Clear session-scoped state before rejecting waiters, so a parked
    // whenReady()/open() cannot resolve against the dead negotiation.
    this.resetSessionState();
    this.failPending(reason);
  }

  private failPending(reason: string) {
    for (const pending of this.pendingOpen.values()) pending.reject(reason);
    this.pendingOpen.clear();
    const waiters = this.readyResolvers;
    this.readyResolvers = [];
    const error = new Error(reason);
    for (const waiter of waiters) waiter.reject(error);
  }

  /** Forget every session-scoped value. A reconnect or guest realm reset is
   * a new session: old seq numbers, credits, streams and correlations are
   * not carried over (draft §3.2 step 4). */
  private resetSessionState() {
    this.session = 0n;
    this.bootNonce = "";
    this.negotiationValue = undefined;
    this.nextCorrelation = 1;
    this.txSeq.clear();
    this.rxSeq.clear();
    this.streams.clear();
    this.nextProviderStream = 1;
    this.lastGuestStream = 0;
    this.outstandingPing = undefined;
    this.pingToken = 0;
  }

  /** L0 calls this when the physical connection drops, and the guest calls
   * it on a realm reset. State returns to idle; hello() starts fresh. */
  handleDisconnect(_reason: string) {
    this.clearTimers();
    this.closed = false;
    this.failPending("disconnected");
    this.resetSessionState();
    if (this.phase !== "idle") this.setPhase("idle", _reason);
  }

  // --- frame output ----------------------------------------------------------

  private decodeOptions(): Parameters<typeof decodeFrame>[1] {
    const n = this.negotiationValue;
    if (!n) {
      // No pinned session yet: accept the full defined codec set so a stale
      // frame from a prior (possibly codec-negotiated) session is rejected
      // on its session id first — stale drop, not a decode teardown — and
      // session-0 frames that carry data are refused by the bootstrap
      // handler, which requires codec 0.
      return { maxWireBytes: RELAY_LIMITS.bootstrapMaxWireBytes, codecs: RELAY_DEFINED_CODECS };
    }
    return {
      session: this.session,
      maxWireBytes: n.rxLimits.maxWireBytes,
      maxMetaBytes: n.rxLimits.maxMetaBytes,
      codecs: n.codecs,
    };
  }

  private nextSeq(stream: number): number {
    const seq = (this.txSeq.get(stream) ?? 0) + 1;
    if (seq > 0xffffffff) throw new Error("seq exhausted; reopen the stream/session");
    this.txSeq.set(stream, seq);
    return seq;
  }

  private emit(input: {
    type: number; stream: number; correlation: number;
    metadata: Record<string, unknown>; data?: Uint8Array;
    bootstrap?: boolean;
    /** Pin a different session/seq in the wire header without touching the
     * per-session seq space — used once, for the provider HELLO response
     * which rides session 0 after the new session is already pinned. */
    frameSession?: bigint;
    frameSeq?: number;
  }): { ok: true } | { ok: false; code: string } {
    const bootstrap = input.bootstrap ?? this.session === 0n;
    if (!bootstrap && input.frameSeq === undefined && this.options.admitControl) {
      // Composed path: no seq is assigned here. The P3 sender stamps it when
      // the frame is selected after its credit is charged (§3.3/§3.9); a
      // refused admission leaves no trace, like a busy transport.
      const admitted = this.options.admitControl({
        type: input.type, correlation: input.correlation, metadata: input.metadata,
      });
      if (!admitted.ok) return admitted;
      this.statsValue.framesSent++;
      return { ok: true };
    }
    const negotiated = this.negotiationValue;
    const codecs = bootstrap ? [RELAY_CODEC.NONE] : negotiated!.codecs;
    const maxWireBytes = bootstrap
      ? RELAY_LIMITS.bootstrapMaxWireBytes
      : negotiated!.rxLimits.maxWireBytes;
    const maxMetaBytes = bootstrap
      ? RELAY_LIMITS.bootstrapMaxWireBytes
      : negotiated!.rxLimits.maxMetaBytes;
    // seq is assigned to a frame only when it enters the ordered send
    // stream; a BUSY adapter never admitted this frame, so roll the seq
    // back (draft §3.3: work pending admission has no seq). An explicit
    // frameSeq is the bootstrap response: it rides session 0 with seq 1
    // after the new session has already been pinned, and it does not
    // consume a seq in the new space.
    const prevSeq = this.txSeq.get(input.stream) ?? 0;
    const seq = input.frameSeq ?? this.nextSeq(input.stream);
    const rollback = () => { if (input.frameSeq === undefined) this.txSeq.set(input.stream, prevSeq); };
    const encoded = encodeFrame({
      type: input.type,
      codec: RELAY_CODEC.NONE,
      session: input.frameSession ?? this.session,
      seq,
      stream: input.stream,
      correlation: input.correlation,
      metadata: input.metadata,
      data: input.data,
    }, { maxWireBytes, maxMetaBytes, codecs });
    if (!encoded.ok) {
      rollback();
      return { ok: false, code: encoded.code };
    }
    const status = this.options.transport.trySend(encoded.bytes);
    if (status === "busy") {
      rollback();
      return { ok: false, code: "BUSY" };
    }
    if (status === "offline") {
      this.teardown("transport offline");
      return { ok: false, code: "OFFLINE" };
    }
    this.statsValue.framesSent++;
    return { ok: true };
  }

  private controlResponse(
    correlation: number,
    metadata: Record<string, unknown>,
    schemaKey: string,
    frameSession?: bigint,
    frameSeq?: number,
  ): { ok: true } | { ok: false; code: string } {
    const schemaError = validateRelaySchema(
      RELAY_METADATA_SCHEMAS[schemaKey] as Record<string, unknown>, metadata,
    );
    if (schemaError) return { ok: false, code: RELAY_FRAME_ERROR.BAD_METADATA };
    return this.emit({
      type: RELAY_TYPE.RESPONSE, stream: 0, correlation, metadata,
      ...(frameSession !== undefined ? { bootstrap: true, frameSession, frameSeq } : {}),
    });
  }

  // --- guest handshake --------------------------------------------------------

  /** Step 2 (guest): send REQUEST relay.hello on session 0. */
  hello(): { ok: true } | { ok: false; code: string } {
    if (this.options.role !== "guest") throw new Error("hello() is guest-side");
    if (this.phase !== "idle" || this.closed) return { ok: false, code: "BAD_STATE" };
    const local = this.options.local;
    if (!local.app) throw new Error("guest capabilities require an app name");
    this.bootNonce = randomHex(this.random, RELAY_HANDSHAKE.nonceBytes);
    this.session = 0n;
    this.txSeq.clear();
    const metadata: Record<string, unknown> = {
      op: RELAY_OP.HELLO,
      versions: local.versions.map((v) => [...v]),
      bootNonce: this.bootNonce,
      app: local.app,
      profiles: local.profiles,
      codecs: [...local.codecs],
      kinds: [...local.kinds],
      rxLimits: local.rxLimits,
    };
    if (local.materialize) metadata.materialize = local.materialize;
    if (local.opExt?.length) metadata.opExt = local.opExt;
    if (local.transport) metadata.transport = local.transport;
    const schemaError = validateRelaySchema(
      RELAY_METADATA_SCHEMAS[`${RELAY_OP.HELLO}.request`] as Record<string, unknown>, metadata,
    );
    if (schemaError) return { ok: false, code: RELAY_FRAME_ERROR.BAD_METADATA };
    // Enter hello-sent BEFORE the frame leaves: with a synchronous
    // transport the HELLO response (and possibly the whole READY
    // exchange) is processed nested inside trySend below.
    this.setPhase("hello-sent");
    this.armStall();
    const sent = this.emit({
      type: RELAY_TYPE.REQUEST, stream: 0, correlation: 1, metadata, bootstrap: true,
    });
    if (!sent.ok) {
      if (sent.code === "BUSY") {
        // Nothing was admitted; roll to idle and retry after retryMs.
        this.setPhase("idle", "busy");
        if (this.stallTimer !== undefined) this.scheduler.clearTimeout(this.stallTimer);
        this.statsValue.helloBusyRetries++;
        this.retryTimer = this.scheduler.setTimeout(() => {
          this.retryTimer = undefined;
          if (this.phase === "idle" && !this.closed) this.hello();
        }, this.retryMs);
      }
      return sent;
    }
    // A synchronous transport can have completed the whole handshake
    // nested inside the send; leave any later phase in place.
    return { ok: true };
  }

  /** 15 s without handshake progress ends the attempt; after READY the
   * rolling stall timer in noteActivity() takes over. */
  private armStall() {
    if (this.stallTimer !== undefined) this.scheduler.clearTimeout(this.stallTimer);
    this.stallTimer = this.scheduler.setTimeout(() => {
      if (this.phase === "hello-sent" || this.phase === "hello-received"
          || this.phase === "ready-sent") {
        this.statsValue.pingTimeouts++;
        this.teardown("stall");
      }
    }, this.stallMs);
  }

  /** Resolves when the machine reaches READY (or rejects on teardown). */
  whenReady(): Promise<RelayNegotiation> {
    return new Promise((resolve, reject) => {
      if (this.phase === "ready" && this.negotiationValue) resolve(this.negotiationValue);
      else if (this.phase === "closed") reject(new Error("session closed"));
      else this.readyResolvers.push({ resolve, reject });
    });
  }

  // --- OPEN (guest side) ------------------------------------------------------

  open(request: RelayOpenRequest): Promise<RelayOpenResult> {
    if (this.options.role !== "guest") throw new Error("open() is guest-side");
    return new Promise((resolve, reject) => {
      if (this.phase !== "ready" || !this.negotiationValue) {
        reject("BAD_STATE");
        return;
      }
      const metadata: Record<string, unknown> = {
        op: RELAY_OP.OPEN,
        app: request.app,
        namespace: request.namespace,
        profile: request.profile,
      };
      if (request.codecs) metadata.codecs = [...request.codecs];
      metadata.rxLimits = request.rxLimits ?? this.options.local.rxLimits;
      const schemaError = validateRelaySchema(
        RELAY_METADATA_SCHEMAS[`${RELAY_OP.OPEN}.request`] as Record<string, unknown>, metadata,
      );
      if (schemaError) { reject(RELAY_FRAME_ERROR.BAD_METADATA); return; }
      if (!this.negotiationValue.profiles.some(profile => samePrivateProfile(profile, request.profile))) {
        reject(RELAY_ERROR.UNSUPPORTED); return;
      }
      const correlation = this.allocateCorrelation();
      // Register before the send: a synchronous transport nests the
      // provider's OPEN response inside trySend, and it must find the
      // pending request and (after the response) the stream.
      const pending: PendingOpen = { app: request.app, namespace: request.namespace,
        profile: freezeRelayCopy(request.profile), rxLimits: freezeRelayCopy(metadata.rxLimits as RelayRxLimits), resolve, reject };
      this.pendingOpen.set(correlation, pending);
      const sent = this.emit({ type: RELAY_TYPE.REQUEST, stream: 0, correlation, metadata });
      if (!sent.ok) { this.pendingOpen.delete(correlation); reject(sent.code); }
    });
  }

  // --- L2 admission point (P3/P4 fill this in) -------------------------------

  /** Encode one business frame with the pinned session and a fresh seq for
   * its (stream, direction): the bare P2 path, which enforces READY plus a
   * known/open stream and nothing else. A machine composed with the P3
   * sender (`admitControl` set) refuses it with COMPOSED: business frames
   * then enter through the endpoint, where credit admission and the
   * sender's seq space apply. */
  sendBusiness(input: {
    type: number; stream: number; correlation?: number;
    metadata: Record<string, unknown>; data?: Uint8Array; codec?: number;
  }): { ok: true } | { ok: false; code: string } {
    if (this.options.admitControl) return { ok: false, code: "COMPOSED" };
    if (this.phase !== "ready" || !this.negotiationValue) return { ok: false, code: "NOT_READY" };
    if (input.stream === 0 || !this.streams.has(input.stream)) return { ok: false, code: "BAD_STREAM" };
    const prevSeq = this.txSeq.get(input.stream) ?? 0;
    const encoded = encodeFrame({
      type: input.type,
      codec: input.codec ?? RELAY_CODEC.NONE,
      session: this.session,
      seq: this.nextSeq(input.stream),
      stream: input.stream,
      correlation: input.correlation ?? 0,
      metadata: input.metadata,
      data: input.data,
    }, {
      maxWireBytes: this.negotiationValue.rxLimits.maxWireBytes,
      maxMetaBytes: this.negotiationValue.rxLimits.maxMetaBytes,
      codecs: this.negotiationValue.codecs,
    });
    if (!encoded.ok) {
      this.txSeq.set(input.stream, prevSeq);
      return { ok: false, code: encoded.code };
    }
    const status = this.options.transport.trySend(encoded.bytes);
    if (status === "busy") {
      this.txSeq.set(input.stream, prevSeq);
      return { ok: false, code: "BUSY" };
    }
    if (status === "offline") { this.teardown("transport offline"); return { ok: false, code: "OFFLINE" }; }
    this.statsValue.framesSent++;
    return { ok: true };
  }

  // ===========================================================================
  // L0 record delivery
  // ===========================================================================

  handleRecord(bytes: Uint8Array) {
    if (this.closed || this.phase === "closed") return;
    // The codec pins the negotiated session once HELLO completes; during
    // the bootstrap exchange the pin is open and only session 0 is valid.
    const result = decodeFrame(bytes, this.decodeOptions());
    if (!result.ok) {
      if (result.code === RELAY_FRAME_ERROR.BAD_SESSION) {
        this.statsValue.droppedStaleSession++;
        return; // stale session frames are dropped silently, draft §3.3
      }
      this.statsValue.droppedDecodeError++;
      this.teardown(`frame decode: ${result.code}`);
      return;
    }
    const frame = result.frame;

    // With no pin yet the session must be the bootstrap session; the guest
    // additionally only accepts the HELLO response there.
    if (this.negotiationValue === undefined && frame.session !== 0n) {
      this.statsValue.droppedStaleSession++;
      return;
    }
    // Unknown/retired ids have no seq space. In particular, a late record
    // after RESET must not recreate per-stream state or reset a newer id.
    if (frame.stream !== 0 && !this.streams.has(frame.stream)) {
      this.statsValue.droppedNotReady++;
      return;
    }

    if (!this.checkInboundSeq(frame)) return;
    this.statsValue.framesReceived++;
    this.noteActivity();
    this.dispatch(frame, bytes.length);
    // A stream-0 record on the pinned session held a control-slice slot on
    // the peer (unless it rode the sideband); the endpoint returns it.
    if (frame.stream === 0 && frame.session !== 0n) this.options.onControlFrame?.(frame, bytes.length);
  }

  /** seq is per (session, stream, direction) and starts at 1. On a
   * reliable ordered transport a duplicate or backwards value cannot occur
   * legitimately: it ends stream 0 (the session), and on a business
   * stream it raises the resync hook (draft §3.3). */
  private checkInboundSeq(frame: RelayDecodedFrame): boolean {
    const last = this.rxSeq.get(frame.stream) ?? 0;
    if (frame.seq !== last + 1) {
      if (frame.stream === 0) {
        this.teardown(frame.seq <= last ? "duplicate seq on stream 0" : "seq gap on stream 0");
      } else {
        this.statsValue.droppedStaleSeq++;
        this.options.onStreamError?.(frame.stream, RELAY_ERROR.RESYNC_REQUIRED);
      }
      return false;
    }
    this.rxSeq.set(frame.stream, frame.seq);
    return true;
  }

  private noteActivity() {
    // Before READY every handshake frame restarts the stall deadline; after
    // READY any inbound frame does.
    if (this.phase === "idle" || this.phase === "closed") return;
    if (this.stallTimer !== undefined) this.scheduler.clearTimeout(this.stallTimer);
    this.stallTimer = this.scheduler.setTimeout(() => {
      this.statsValue.pingTimeouts++;
      this.teardown("stall");
    }, this.stallMs);
  }

  // --- control dispatch -------------------------------------------------------

  private dispatch(frame: RelayDecodedFrame, wireBytes: number) {
    const op = frame.metadata.op;
    if (typeof op !== "string") {
      this.teardown("frame without op");
      return;
    }
    switch (op) {
      case RELAY_OP.HELLO: this.handleHello(frame); return;
      case RELAY_OP.READY: this.handleReady(frame); return;
      case RELAY_OP.OPEN: this.handleOpen(frame); return;
      case RELAY_OP.PING: this.handlePing(frame); return;
      case RELAY_OP.CREDIT: this.handleCredit(frame); return;
      case RELAY_OP.RESET: this.handleReset(frame); return;
      case RELAY_OP.REQUEST_CANCEL: this.handleCancel(frame); return;
      default: this.handleBusiness(frame, wireBytes);
    }
  }

  private isErrorResponse(frame: RelayDecodedFrame): boolean {
    return frame.type === RELAY_TYPE.RESPONSE
      && frame.metadata.status === RELAY_STATUS.ERROR;
  }

  private validateAgainst(frame: RelayDecodedFrame, schemaKey: string): boolean {
    const err = validateRelaySchema(
      RELAY_METADATA_SCHEMAS[schemaKey] as Record<string, unknown>,
      frame.metadata,
    );
    if (err) {
      this.statsValue.handshakeFailures++;
      this.teardown(`${schemaKey}: ${err}`);
      return false;
    }
    return true;
  }

  /** A terminal error RESPONSE must itself satisfy the error schema; a
   * malformed error cannot be accepted as a valid refusal. */
  private validateError(frame: RelayDecodedFrame, schemaKey: string): boolean {
    const err = validateRelaySchema(
      RELAY_METADATA_SCHEMAS[`${schemaKey}.error`] as Record<string, unknown>,
      frame.metadata,
    );
    if (err) {
      this.statsValue.handshakeFailures++;
      this.teardown(`${schemaKey}.error: ${err}`);
      return false;
    }
    return true;
  }

  // --- HELLO ------------------------------------------------------------------

  private handleHello(frame: RelayDecodedFrame) {
    const meta = frame.metadata;
    if (this.options.role === "guest") {
      // Step 3: provider selection, still on session 0.
      if (this.phase !== "hello-sent" || frame.session !== 0n
          || frame.type !== RELAY_TYPE.RESPONSE || frame.stream !== 0
          || frame.correlation !== 1) {
        this.statsValue.droppedNotReady++;
        return;
      }
      // The bootstrap exchange carries metadata only: codec 0, no data.
      if (frame.codec !== RELAY_CODEC.NONE || frame.data.length !== 0) {
        this.teardown("bootstrap frame carries data"); return;
      }
      if (this.isErrorResponse(frame)) {
        if (!this.validateError(frame, RELAY_OP.HELLO)) return;
        const code = (meta.error as { code?: string } | undefined)?.code ?? RELAY_ERROR.UNSUPPORTED;
        this.statsValue.handshakeFailures++;
        this.teardown(`hello rejected: ${code}`);
        return;
      }
      // A success response without `kinds` cannot confirm the §3.2
      // intersection (the schema requires the field); the peer is
      // unsupported. Decide here so the close reason carries the code.
      if (!Object.prototype.hasOwnProperty.call(meta, "kinds")) {
        this.statsValue.handshakeFailures++;
        this.teardown(`hello rejected: ${RELAY_ERROR.UNSUPPORTED} (response without kinds)`);
        return;
      }
      if (!validPrivateOps(meta.profiles as RelayProfileEntry[], meta.opExt, meta.rxLimits as RelayRxLimits)) {
        this.teardown(`hello rejected: ${RELAY_ERROR.UNSUPPORTED} (private ops)`); return;
      }
      if (!this.validateAgainst(frame, `${RELAY_OP.HELLO}.response`)) return;
      if (meta.bootNonce !== this.bootNonce) { this.teardown("bootNonce mismatch"); return; }
      const local = this.options.local;
      const selected = meta.selected as RelayProtocolVersion;
      if (!local.versions.some((v) => versionKey(v) === versionKey(selected))) {
        this.teardown("selected version not offered"); return;
      }
      const profiles = meta.profiles as RelayProfileEntry[];
      if (profiles.length === 0 || !profiles.every((p) => local.profiles.some(
        (q) => q.name === p.name && q.version === p.version))) {
        this.teardown("selected profile not offered"); return;
      }
      const codecs = meta.codecs as number[] | undefined;
      if (codecs && (!codecs.includes(RELAY_CODEC.NONE)
          || !codecs.every((c) => local.codecs.includes(c)))) {
        this.teardown("selected codec set invalid"); return;
      }
      // §3.2 field table: kinds are chosen by mutual intersection. The
      // response must carry the picked set (the schema requires it, and a
      // response without it closed the session above): every value must be
      // one the guest offered and at least one kind must survive.
      const kinds = meta.kinds as number[];
      if (kinds.length === 0 || !kinds.every((k) => local.kinds.includes(k))) {
        this.teardown("selected kind set invalid"); return;
      }
      const grants = meta.grants as string[];
      if (!grants.includes(local.app!)) { this.teardown("app outside grants"); return; }
      const limits = minLimits(local.rxLimits, meta.rxLimits as RelayRxLimits);
      if (!limitsEqual(limits, meta.rxLimits as RelayRxLimits)) {
        this.teardown("rxLimits are not min(local, peer)"); return;
      }
      const opExt = (meta.opExt ?? []) as RelayPrivateOpDescriptor[];
      if (!privateSelectionOffered(opExt, local.opExt ?? [])) {
        this.teardown(`hello rejected: ${RELAY_ERROR.UNSUPPORTED} (private op selection)`); return;
      }
      const session = BigInt("0x" + meta.session as string);
      if (session === 0n) { this.teardown("zero session"); return; }

      // Step 4: REQUEST relay.ready on the new session; seq restarts at 1.
      // Pin and move phases BEFORE the send so a synchronous transport's
      // nested READY ack arrives in the ready-sent state.
      const negotiation: RelayNegotiation = {
        version: selected,
        profiles,
        codecs: codecs ?? [RELAY_CODEC.NONE],
        kinds,
        grants,
        rxLimits: limits,
        ...(opExt.length ? { opExt } : {}),
        peerNonce: meta.peerNonce as string,
        ...(meta.transport ? { transport: meta.transport as RelayTransportDesc } : {}),
      };
      this.pinSession(session, negotiation);
      this.setPhase("ready-sent");
      const readyMetadata = { op: RELAY_OP.READY, selected: [...selected] };
      const sent = this.emit({
        type: RELAY_TYPE.REQUEST, stream: 0, correlation: this.allocateCorrelation(),
        metadata: readyMetadata,
      });
      if (!sent.ok) { this.teardown(`ready send: ${sent.code}`); }
      return;
    }

    // Provider side: answer the bootstrap REQUEST.
    if (this.phase !== "idle" || frame.session !== 0n
        || frame.type !== RELAY_TYPE.REQUEST || frame.stream !== 0
        || frame.correlation !== 1 || frame.seq !== 1) {
      this.statsValue.droppedNotReady++;
      return;
    }
    // The bootstrap exchange carries metadata only: codec 0, no data.
    if (frame.codec !== RELAY_CODEC.NONE || frame.data.length !== 0) {
      this.teardown("bootstrap frame carries data"); return;
    }
    const refuse = (code: string) => {
      this.statsValue.handshakeFailures++;
      const metadata: Record<string, unknown> = {
        op: RELAY_OP.HELLO, status: RELAY_STATUS.ERROR, final: true,
        error: { code, message: `handshake refused: ${code}` },
      };
      if (typeof meta.bootNonce === "string") metadata.bootNonce = meta.bootNonce;
      this.controlResponse(1, metadata, `${RELAY_OP.HELLO}.error`);
      this.teardown(`hello refused: ${code}`);
    };
    if (!validPrivateOps(meta.profiles as RelayProfileEntry[], meta.opExt, meta.rxLimits as RelayRxLimits)) {
      refuse(RELAY_ERROR.UNSUPPORTED); return;
    }
    if (!this.validateAgainst(frame, `${RELAY_OP.HELLO}.request`)) return;
    const peer = this.options.transport.peer;
    const app = meta.app as string;
    if (!peer.grants.includes(app)) { refuse(RELAY_ERROR.UNAUTHORIZED); return; }
    const local = this.options.local;
    const selectedVersion = (meta.versions as RelayProtocolVersion[])
      .find((v) => local.versions.some((q) => versionKey(q) === versionKey(v)));
    if (!selectedVersion) { refuse(RELAY_ERROR.UNSUPPORTED); return; }
    const profiles = (meta.profiles as RelayProfileEntry[])
      .filter((p) => local.profiles.some((q) => q.name === p.name && q.version === p.version));
    if (profiles.length === 0) { refuse(RELAY_ERROR.UNSUPPORTED); return; }
    const codecs = [...new Set((meta.codecs as number[]).filter((c) => local.codecs.includes(c)))];
    if (!codecs.includes(RELAY_CODEC.NONE)) { refuse(RELAY_ERROR.UNSUPPORTED); return; }
    if (!(meta.kinds as number[]).some((k) => local.kinds.includes(k))) {
      refuse(RELAY_ERROR.UNSUPPORTED); return;
    }
    const peerLimits = meta.rxLimits as RelayRxLimits;
    if (!limitsAreUsable(peerLimits)) { refuse(RELAY_ERROR.UNSUPPORTED); return; }
    const rxLimits = minLimits(local.rxLimits, peerLimits);
    const opExt = intersectPrivateOps((meta.opExt ?? []) as RelayPrivateOpDescriptor[], local.opExt ?? [], profiles);

    let session = 0n;
    do { session = BigInt("0x" + randomHex(this.random, 8)); } while (session === 0n);
    const peerNonce = randomHex(this.random, RELAY_HANDSHAKE.nonceBytes);
    const metadata: Record<string, unknown> = {
      op: RELAY_OP.HELLO, status: RELAY_STATUS.OK, final: true,
      bootNonce: meta.bootNonce,
      peerNonce,
      session: session.toString(16).padStart(16, "0"),
      selected: [...selectedVersion],
      profiles,
      codecs,
      kinds: (meta.kinds as number[]).filter((k) => local.kinds.includes(k)),
      grants: peer.grants,
      rxLimits,
    };
    if (meta.transport) metadata.transport = meta.transport;
    if (opExt.length) metadata.opExt = opExt;
    // Pin the new session BEFORE the response leaves: a synchronous
    // transport delivers the guest's nested READY inside trySend below,
    // and it must find the session and phase already established.
    const negotiation: RelayNegotiation = {
      version: selectedVersion, profiles, codecs,
      kinds: (meta.kinds as number[]).filter((k) => local.kinds.includes(k)),
      grants: peer.grants, rxLimits, peerNonce,
      ...(opExt.length ? { opExt } : {}),
      ...(meta.transport ? { transport: meta.transport as RelayTransportDesc } : {}),
    };
    this.session = session;
    this.txSeq.clear();
    this.rxSeq.clear();
    this.negotiationValue = freezeRelayCopy(negotiation);
    this.nextCorrelation = 1;
    this.setPhase("hello-received");
    this.armStall();
    // The response still rides session 0 with seq 1 (bootstrap exchange);
    // it deliberately does not consume a seq in the pinned new session.
    const sent = this.controlResponse(1, metadata, `${RELAY_OP.HELLO}.response`, 0n, 1);
    if (!sent.ok) { this.teardown(`hello response: ${sent.code}`); return; }
  }

  // --- READY ------------------------------------------------------------------

  private handleReady(frame: RelayDecodedFrame) {
    if (this.options.role === "guest") {
      if (this.phase !== "ready-sent" || frame.type !== RELAY_TYPE.RESPONSE
          || frame.session !== this.session || frame.stream !== 0) {
        this.statsValue.droppedNotReady++; return;
      }
      if (this.isErrorResponse(frame)) {
        if (!this.validateError(frame, RELAY_OP.READY)) return;
        this.statsValue.handshakeFailures++;
        this.teardown("ready rejected"); return;
      }
      if (!this.validateAgainst(frame, `${RELAY_OP.READY}.response`)) return;
      this.enterReady();
      return;
    }
    if (this.phase !== "hello-received" || frame.type !== RELAY_TYPE.REQUEST
        || frame.session !== this.session || frame.stream !== 0) {
      this.statsValue.droppedNotReady++; return;
    }
    if (!this.validateAgainst(frame, `${RELAY_OP.READY}.request`)) return;
    const selected = frame.metadata.selected as RelayProtocolVersion;
    if (versionKey(selected) !== versionKey(this.negotiationValue!.version)) {
      this.teardown("ready selected mismatch"); return;
    }
    const sent = this.controlResponse(frame.correlation, {
      op: RELAY_OP.READY, status: RELAY_STATUS.OK, final: true,
    }, `${RELAY_OP.READY}.response`);
    if (!sent.ok) { this.teardown(`ready response: ${sent.code}`); return; }
    this.enterReady();
  }

  private pinSession(session: bigint, negotiation: RelayNegotiation) {
    this.session = session;
    this.txSeq.clear();
    this.rxSeq.clear();
    this.negotiationValue = freezeRelayCopy(negotiation);
    this.nextCorrelation = 1;
  }

  /** Reset one stream's two seq counters when its binding is installed,
   *  so a frame that arrived before the stream existed cannot leave a
   *  stale value behind (a newly bound stream starts at seq 1). */
  private clearStreamSeq(stream: number) {
    this.txSeq.delete(stream);
    this.rxSeq.delete(stream);
  }

  private enterReady() {
    this.setPhase("ready");
    const waiters = this.readyResolvers;
    this.readyResolvers = [];
    for (const waiter of waiters) waiter.resolve(this.negotiationValue!);
    this.noteActivity();
    this.schedulePing();
  }

  // --- OPEN -------------------------------------------------------------------

  private handleOpen(frame: RelayDecodedFrame) {
    if (this.options.role === "guest") {
      if (this.phase !== "ready" || frame.type !== RELAY_TYPE.RESPONSE
          || frame.session !== this.session || frame.stream !== 0) {
        this.statsValue.droppedNotReady++; return;
      }
      const pending = this.pendingOpen.get(frame.correlation);
      if (!pending) { this.statsValue.droppedNotReady++; return; }
      this.pendingOpen.delete(frame.correlation);
      if (this.isErrorResponse(frame)) {
        if (!this.validateError(frame, RELAY_OP.OPEN)) {
          pending.reject(RELAY_FRAME_ERROR.BAD_METADATA); return;
        }
        pending.reject((frame.metadata.error as { code?: string })?.code ?? "ERROR");
        return;
      }
      if (!this.validateAgainst(frame, `${RELAY_OP.OPEN}.response`)) {
        pending.reject(RELAY_FRAME_ERROR.BAD_METADATA); return;
      }
      const profile = frame.metadata.profile as RelayProfileEntry;
      const rxLimits = frame.metadata.rxLimits as RelayRxLimits;
      if (frame.metadata.namespace !== pending.namespace || !samePrivateProfile(profile, pending.profile)
          || !limitsAreUsable(rxLimits) || !limitsEqual(rxLimits, minLimits(pending.rxLimits, rxLimits))
          || !limitsEqual(rxLimits, minLimits(this.negotiationValue!.rxLimits, rxLimits))) {
        pending.reject(RELAY_ERROR.UNSUPPORTED);
        this.teardown(`open rejected: ${RELAY_ERROR.UNSUPPORTED} (binding mismatch)`); return;
      }
      const stream = frame.metadata.stream as number;
      if (stream <= this.lastGuestStream || this.streams.size >= RELAY_LIMITS.maxStreams) {
        pending.reject("BAD_STREAM"); return;
      }
      this.lastGuestStream = stream;
      const binding: StreamBinding = freezeRelayCopy({
        app: pending.app,
        namespace: pending.namespace, profile, rxLimits,
        opExt: privateOpForStream(this.negotiationValue!.opExt ?? [], profile, rxLimits),
      });
      // A frame that raced in before this stream existed may have touched
      // its seq space (handleRecord checks seq before the stream exists).
      // The binding starts a fresh per-stream seq at 1 in each direction.
      this.clearStreamSeq(stream);
      this.streams.set(stream, binding);
      const opened: RelayOpenResult = {
        stream, namespace: binding.namespace, profile: binding.profile, rxLimits: binding.rxLimits,
        ...(binding.opExt?.length ? { opExt: binding.opExt } : {}),
      };
      // The composition layer allocates the stream's window slice before
      // the caller can send on it.
      this.options.onStreamOpened?.(opened);
      pending.resolve(opened);
      return;
    }

    // Provider: authorize and allocate a stream id, never reused.
    if (this.phase !== "ready" || frame.type !== RELAY_TYPE.REQUEST
        || frame.session !== this.session || frame.stream !== 0) {
      this.statsValue.droppedNotReady++; return;
    }
    if (!this.validateAgainst(frame, `${RELAY_OP.OPEN}.request`)) return;
    const request: RelayOpenRequest = {
      app: frame.metadata.app as string,
      namespace: frame.metadata.namespace as string,
      profile: frame.metadata.profile as RelayProfileEntry,
      ...(frame.metadata.codecs ? { codecs: frame.metadata.codecs as number[] } : {}),
      ...(frame.metadata.rxLimits ? { rxLimits: frame.metadata.rxLimits as RelayRxLimits } : {}),
    };
    const refuse = (code: string) => {
      this.controlResponse(frame.correlation, {
        op: RELAY_OP.OPEN, status: RELAY_STATUS.ERROR, final: true,
        error: { code, message: `open refused: ${code}` },
      }, `${RELAY_OP.OPEN}.error`);
    };
    const n = this.negotiationValue!;
    if (!n.grants.includes(request.app)) { refuse(RELAY_ERROR.UNAUTHORIZED); return; }
    if (!n.profiles.some((p) => p.name === request.profile.name && p.version === request.profile.version)) {
      refuse(RELAY_ERROR.UNSUPPORTED); return;
    }
    if (request.codecs && !request.codecs.every((c) => n.codecs.includes(c))) {
      refuse(RELAY_ERROR.UNSUPPORTED); return;
    }
    if (this.options.authorizeOpen) {
      const code = this.options.authorizeOpen(request, this.options.transport.peer);
      if (code) { refuse(code); return; }
    }
    if (this.streams.size >= RELAY_LIMITS.maxStreams) {
      refuse(RELAY_ERROR.BUSY); return;
    }
    // maxStreams bounds live bindings, not the lifetime u32 id space.
    // RESET frees a binding but ids remain monotonic and never wrap.
    if (this.nextProviderStream > 0xffffffff) {
      refuse(RELAY_ERROR.RESYNC_REQUIRED); return;
    }
    const stream = this.nextProviderStream++;
    const rxLimits = request.rxLimits ? minLimits(n.rxLimits, request.rxLimits) : n.rxLimits;
    if (!limitsAreUsable(rxLimits)) { refuse(RELAY_ERROR.UNSUPPORTED); return; }
    const binding: StreamBinding = freezeRelayCopy({
      app: request.app, namespace: request.namespace, profile: request.profile, rxLimits,
      opExt: privateOpForStream(n.opExt ?? [], request.profile, rxLimits),
    });
    // Bind before the response leaves so a synchronous transport's nested
    // business frame on the new stream is admitted immediately. The id is
    // fresh (never reused), so drop any seq an early frame planted.
    this.clearStreamSeq(stream);
    this.streams.set(stream, binding);
    const sent = this.controlResponse(frame.correlation, {
      op: RELAY_OP.OPEN, status: RELAY_STATUS.OK, final: true,
      stream, namespace: request.namespace, profile: request.profile, rxLimits,
    }, `${RELAY_OP.OPEN}.response`);
    if (!sent.ok) { this.streams.delete(stream); this.teardown(`open response: ${sent.code}`); return; }
    this.options.onStreamOpened?.({ stream, namespace: binding.namespace, profile: binding.profile, rxLimits: binding.rxLimits,
      ...(binding.opExt?.length ? { opExt: binding.opExt } : {}) });
  }

  // --- PING -------------------------------------------------------------------

  private schedulePing() {
    if (this.pingTimer !== undefined) this.scheduler.clearTimeout(this.pingTimer);
    this.pingTimer = this.scheduler.setTimeout(() => {
      this.pingTimer = undefined;
      this.sendPing();
      if (this.phase === "ready") this.schedulePing();
    }, this.pingIntervalMs);
  }

  private sendPing() {
    if (this.phase !== "ready" || this.outstandingPing !== undefined) return;
    this.pingToken = (this.pingToken + 1) >>> 0;
    const token = this.pingToken === 0 ? 1 : this.pingToken;
    const metadata = { op: RELAY_OP.PING, token };
    const correlation = this.allocateCorrelation();
    // Publish the token BEFORE the send: a synchronous adapter delivers the
    // matching pong nested inside emit(), and handlePing must find the
    // token outstanding at that moment (Review 988 B-5). A send that was
    // never admitted (BUSY, encode failure) rolls the slot back, the same
    // way emit() rolls the seq back.
    this.outstandingPing = token;
    const sent = this.emit({ type: RELAY_TYPE.REQUEST, stream: 0, correlation, metadata });
    if (sent.ok) {
      // A nested pong may already have cleared the slot; leave it as is.
      this.statsValue.pingsSent++;
      return;
    }
    this.outstandingPing = undefined;
    if (sent.code === "BUSY") {
      // The L0 queue had no room; retry the ping after retryMs instead of
      // burning the 2 s interval.
      this.retryTimer = this.scheduler.setTimeout(() => {
        this.retryTimer = undefined;
        this.sendPing();
      }, this.retryMs);
    }
  }

  private handlePing(frame: RelayDecodedFrame) {
    if (this.phase !== "ready" || frame.session !== this.session || frame.stream !== 0) {
      this.statsValue.droppedNotReady++; return;
    }
    if (frame.type === RELAY_TYPE.REQUEST) {
      if (!this.validateAgainst(frame, `${RELAY_OP.PING}.request`)) return;
      this.statsValue.pingsReceived++;
      const sent = this.controlResponse(frame.correlation, {
        op: RELAY_OP.PING, status: RELAY_STATUS.OK, final: true,
        token: frame.metadata.token,
      }, `${RELAY_OP.PING}.response`);
      if (!sent.ok) this.teardown(`ping response: ${sent.code}`);
      return;
    }
    // Response to our own ping: token must match the outstanding request.
    if (frame.type === RELAY_TYPE.RESPONSE) {
      if (this.isErrorResponse(frame)) {
        if (!this.validateError(frame, RELAY_OP.PING)) return;
        this.teardown("ping error"); return;
      }
      if (!this.validateAgainst(frame, `${RELAY_OP.PING}.response`)) return;
      if (this.outstandingPing === undefined || frame.metadata.token !== this.outstandingPing) {
        this.statsValue.droppedStaleSeq++;
        return;
      }
      this.outstandingPing = undefined;
    }
  }

  // --- CREDIT / RESET are P3/P4 hooks; business frames go to L2 ---------------

  private handleCredit(frame: RelayDecodedFrame) {
    if (this.phase !== "ready" || frame.type !== RELAY_TYPE.PUSH || frame.stream !== 0) {
      this.statsValue.droppedNotReady++; return;
    }
    if (!this.validateAgainst(frame, RELAY_OP.CREDIT)) return;
    this.options.onCredit?.(frame.metadata);
  }

  private handleReset(frame: RelayDecodedFrame) {
    if (this.phase !== "ready" || frame.type !== RELAY_TYPE.PUSH || frame.stream !== 0) {
      this.statsValue.droppedNotReady++; return;
    }
    // §3.6 resets a business stream. stream 0 is the reserved control
    // stream; refuse the action before the schema (whose minimum is 1) so
    // the control seq space survives instead of teardown.
    if (frame.metadata.targetStream === 0) {
      this.statsValue.droppedNotReady++;
      return;
    }
    if (!this.validateAgainst(frame, RELAY_OP.RESET)) return;
    const target = frame.metadata.targetStream as number;
    if (!this.streams.has(target)) { this.statsValue.droppedNotReady++; return; }
    this.streams.delete(target);
    this.txSeq.delete(target);
    this.rxSeq.delete(target);
    this.options.onReset?.(frame.metadata);
  }

  /** Inbound CANCEL: §3.6 rides stream 0 with op request.cancel and the
   * original request's correlation; the frame codec checked the envelope
   * (type CANCEL, stream 0, u32 targetStream). The composition layer
   * withdraws the request and answers with its one terminal. */
  private handleCancel(frame: RelayDecodedFrame) {
    if (this.phase !== "ready" || frame.session !== this.session
        || frame.type !== RELAY_TYPE.CANCEL || frame.stream !== 0) {
      this.statsValue.droppedNotReady++; return;
    }
    this.options.onCancel?.(frame);
  }

  private handleBusiness(frame: RelayDecodedFrame, wireBytes: number) {
    if (this.phase !== "ready" || frame.session !== this.session) {
      this.statsValue.droppedNotReady++; return;
    }
    if (frame.stream === 0) {
      // Unknown control-stream traffic after READY ends the session
      // (draft §3.6: unknown required messages cannot be skipped).
      this.teardown(`unknown stream 0 op ${frame.metadata.op}`);
      return;
    }
    if (!this.streams.has(frame.stream)) {
      this.statsValue.droppedNotReady++;
      this.options.onStreamError?.(frame.stream, "BAD_STREAM");
      return;
    }
    this.options.onBusinessFrame?.(frame, wireBytes);
  }

  // --- misc -------------------------------------------------------------------

  /** The session-scoped request id space (§3.6: one space per direction,
   * never reused within a session; restarts at 1 on a new session). The
   * machine draws OPEN and PING ids here, and the composition layer draws
   * business request ids from the same space. Returns 0 when the space is
   * exhausted, which ends the session. */
  allocateCorrelation(): number {
    const id = this.nextCorrelation;
    if (id === 0xffffffff) {
      this.teardown("correlation exhausted");
      return 0;
    }
    this.nextCorrelation++;
    return id;
  }

  /** Provider-visible bindings (tests and tools/relay-wire.ts). */
  streamInfo(stream: number): StreamBinding | undefined {
    return this.streams.get(stream);
  }

  /** Open stream ids of the pinned session, ascending. */
  streamIds(): number[] {
    return [...this.streams.keys()].sort((a, b) => a - b);
  }

  /** Drop a stream binding and its seq counters after a locally originated
   * relay.reset; the id is never reused (§3.6). An inbound reset does this
   * in handleReset. */
  forgetStream(stream: number): boolean {
    this.txSeq.delete(stream);
    this.rxSeq.delete(stream);
    return this.streams.delete(stream);
  }

  /** Drop all session state without a physical disconnect (guest realm
   * reset). The next hello() is a brand-new session. */
  realmReset() {
    this.handleDisconnect("guest realm reset");
  }

  close() {
    this.clearTimers();
    this.closed = true;
    this.failPending("closed");
    this.resetSessionState();
    if (this.phase !== "closed") this.setPhase("closed", "local close");
  }
}

/** Construct a session machine. Both guest and provider use this class;
 * `role` decides which handshake messages may be sent and received. */
export function createRelaySession(options: RelaySessionOptions): RelaySession {
  return new RelaySession(options);
}

export { RELAY_DEFINED_CODECS, RELAY_LIMITS };
