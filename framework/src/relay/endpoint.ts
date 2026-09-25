/** Relay composed endpoint — the L1 session, the P3 queue/credit machines
 * and the L2 resource layer as one object over one transport.
 *
 * Each layer stays a library; this file is the wiring the wire adapter
 * (`tools/relay-wire.ts`) and a device host instantiate:
 *
 *   send:    L2 client/authority -> RelaySender.admit (credit admission,
 *            bounded queue) -> pump (seq at selection) -> ordered outbox
 *            -> transport.trySend
 *   receive: transport record -> RelaySession.handleRecord (decode, session
 *            pin, per-stream seq) -> RelayReceiver.ingest (window
 *            occupancy) -> pumpReceive -> L2 client/authority -> release
 *            (credit returns) -> relay.credit rides the sideband back
 *
 * The session's own control frames after the bootstrap (READY, OPEN,
 * PING/pong) enter the same sender through `admitControl`: OPEN and READY
 * consume the stream-0 control slice, ping and pong ride the sideband. The
 * HELLO exchange on session 0 goes straight to the outbox. Inbound stream-0
 * records the session consumes itself return their control-slice credit
 * through `onControlFrame`; sideband records (credit, ping, reset, CANCEL)
 * earn none. Inbound business frames on opened streams go through the
 * receiver's per-stream window and are delivered by pumpReceive().
 *
 * Per-session state (sender, receiver, request table, client or authority)
 * is built when the session is pinned and dropped when it ends; a
 * reconnect starts from a fresh set with seq, credit and correlation at
 * their initial values (draft §3.2 step 4).
 *
 * Bounded demand (§3.9): a request the window cannot admit is refused BUSY
 * to the caller, who keeps it. The provider's prepared envelopes (chunks of
 * one object, a push, an invalidate) wait in a per-stream FIFO until credit
 * admits them; every entry belongs to one accepted request or one active
 * subscription, so the FIFO is bounded by admitted work, not by peer
 * input. Frames stamped with a seq that a busy transport did not take wait
 * in the ordered outbox, whose size is one pump batch plus the bootstrap
 * frame. */

import {
  RELAY_CODEC,
  RELAY_EFFECT,
  RELAY_ERROR,
  RELAY_LIMITS,
  RELAY_OP,
  RELAY_STATUS,
  RELAY_TYPE,
  type RelayResourceRef,
  type RelayRxLimits,
  type RelayErrorBody,
  type RelayOperationEpochArgs,
  type RelayOperationEpochValue,
  type RelayOperationStatusArgs,
  type RelayOperationStatusValue,
} from "../../../contracts/spec/relay.ts";
import type { ResourceResult } from "../resource-cache.ts";
import { RelayChunkAssembler } from "./assembler.ts";
import {
  RELAY_P3_ERROR,
  RELAY_PRIORITY,
  RelayCreditTable,
  RelayReceiver,
  RelayRequestTable,
  RelaySender,
  RelaySideband,
  isSidebandFrame,
  type P3Result,
  type RelayReceived,
  type RelayRequestState,
  type RelayStreamAlloc,
} from "./credit.ts";
import { parseRelayJson, type RelayDecodedFrame } from "./frame.ts";
import { validateRelayMetadata } from "./metadata.ts";
import { validateRelaySchema } from "./metadata-schema.ts";
import {
  installPrivateOps, preparePrivateOp, privateDescriptors, privateOpAllows, samePrivateProfile,
  type RelayPrivateOp,
} from "./private-op.ts";
export type { RelayPrivateOp, RelayPrivateSchema } from "./private-op.ts";
import { RelayResourceForms, type RelayResourceForm } from "./resource-form.ts";
export type { RelayResourceForm } from "./resource-form.ts";
import {
  RelayMemoryOperationStore, RelayOperationAuthority, isOperationOp, prepareOperation,
  type RelayOperationIdentity, type RelayOperationOp,
} from "./operation.ts";
export { RelayMemoryOperationStore, RelayOperationAuthority, RelayOperationStoreError } from "./operation.ts";
export type { RelayOperationStore, RelayOperationScope, RelayOperationNamespace, RelayOperationIdentity } from "./operation.ts";
import {
  RelayResourceAuthority,
  RelayResourceClient,
  relayGetResponseMatchesRequest,
  relayKindNegotiated,
  type RelayGetOutcome,
  type RelayResourceEnvelope,
  type RelayResourceIncomingFrame,
  type RelayResourceWire,
  type RelaySubscriptionHandler,
} from "./resource.ts";
import {
  createRelaySession,
  type RelayControlAdmission,
  type RelayLocalCapabilities,
  type RelayNegotiation,
  type RelayOpenRequest,
  type RelayOpenResult,
  type RelayPeerContext,
  type RelayPhase,
  type RelayRandomBytes,
  type RelayScheduler,
  type RelaySendStatus,
  type RelaySession,
  type RelayTransportAdapter,
} from "./session.ts";

// --- public types --------------------------------------------------------------

/** A REQUEST either endpoint hands to the application. */
export interface RelayIncomingRequest {
  stream: number;
  correlation: number;
  op: string;
  metadata: Record<string, unknown>;
  /** View over the record's data region; copy to keep it past the call. */
  data: Uint8Array;
  codec: number;
  /** Session fence for delayed replies, including after a reconnect. */
  session: bigint;
  /** True once the peer sent request.cancel for this correlation. The
   * request still needs its one terminal (§3.6). */
  cancelRequested(): boolean;
  /** Present on epoch/durable mutations. Commit through this handle so
   * cancellation and the receipt share the side effect's transaction. */
  operation?: RelayIncomingOperation;
}

export interface RelayIncomingOperation {
  readonly identity: Readonly<RelayOperationIdentity>;
  /** Validate the result before applying the effect. The storage driver
   * must transact both; a thrown/async callback cannot count as a commit. */
  commit(value: unknown, apply: () => void): { ok: true } | { ok: false; code: string };
  /** Resolve an unknown outcome from external evidence; never runs an effect. */
  reconcile(result: { state: "committed"; value: unknown } | { state: "rejected"; code: string; message?: string }):
    { ok: true } | { ok: false; code: string };
}

export interface RelayEndpointHooks {
  onPhase?: (phase: RelayPhase, detail?: { reason?: string }) => void;
  /** Provider: return a RELAY_ERROR code to refuse an OPEN, or null. */
  authorizeOpen?: (req: RelayOpenRequest, peer: RelayPeerContext) => string | null;
  /** A stream binding and its window slice exist on this end. */
  onStreamOpened?: (result: RelayOpenResult) => void;
  /** A peer fault the endpoint dropped a frame for or ended the session
   * on; `code` is a RELAY_P3_ERROR / RELAY_ERROR / RELAY_FRAME_ERROR value. */
  onProtocolError?: (code: string, detail: string) => void;
  /** A business stream was reset (seq gap resync, peer reset, local reset). */
  onStreamReset?: (stream: number, reason: string) => void;
  /** Provider: a schema-valid resource.get. Answer with replyObject(),
   * replyNotModified() or replyError(); without the hook the endpoint
   * answers UNSUPPORTED. */
  onGet?: (request: RelayIncomingRequest) => void;
  /** Either role: a negotiated, schema-valid private REQUEST. Return
   * true when the application took it (and will answer through respond());
   * false answers UNSUPPORTED. */
  onRequest?: (request: RelayIncomingRequest) => boolean;
  /** Either role: an inbound CANCEL; the request is marked, the application
   * decides between the in-flight success terminal and CANCELLED/none. */
  onCancel?: (cancel: { targetStream: number; correlation: number; reason: string; request: RelayRequestState | undefined }) => void;
  /** Provider: a consumer cache.evict advisory; no ACK exists (R5 Q5). */
  onEvict?: (metadata: Record<string, unknown>) => void;
}

export interface RelayEndpointOptions {
  role: "guest" | "provider";
  transport: RelayTransportAdapter;
  local: RelayLocalCapabilities;
  /** Installed profile-owned REQUESTs; schemas remain on this endpoint. */
  privateOps?: readonly RelayPrivateOp[];
  /** Installed product resource forms: local args/value schemas bound to
   * (profile, kind) and the one args key each form owns. Nothing crosses
   * the wire. */
  resourceForms?: readonly RelayResourceForm[];
  /** Reuse across authenticated connections. Incoming durable definitions
   * require a durable transaction store. The default supports input epochs. */
  operations?: RelayOperationAuthority;
  hooks?: RelayEndpointHooks;
  scheduler?: RelayScheduler;
  randomBytes?: RelayRandomBytes;
  pingIntervalMs?: number;
  stallMs?: number;
  retryMs?: number;
  /** Normal frames one send pump selects (§3.9: a guest submits at most 2
   * per logical frame; the sender's default). flush() repeats pumps until
   * the window, the queues or the transport stop it. */
  framesPerPump?: number;
  bytesPerPump?: number;
  /** Request slots kept free for input/control (§3.9 recommends 2 of 8);
   * resource requests are refused BUSY inside the reserve. Default 0. */
  requestReserve?: number;
  /** Frames the ordered outbox holds for a busy transport before the
   * session's own bootstrap send is refused busy. Default 32. */
  outboxFrames?: number;
}

export type RelayPrivateResult<T = unknown> =
  | { ok: true; value: T; effect?: string }
  | { ok: false; error: RelayErrorBody; effect?: string };

/** Await the one terminal. A local refusal has correlation 0 and sends nothing. */
export interface RelayPrivateCall<T = unknown> extends Promise<RelayPrivateResult<T>> {
  readonly correlation: number;
  cancel(reason?: string): void;
}

export interface RelayPrivateRequestOptions {
  opEpoch?: string;
  opId?: string;
}

/** The per-session machines, for tests and diagnostics. */
export interface RelayEndpointInspection {
  session: bigint;
  negotiation: RelayNegotiation;
  sender: RelaySender;
  receiver: RelayReceiver;
  requests: RelayRequestTable;
  /** Separate correlation spaces for work originated on each end. */
  outgoingRequests: RelayRequestTable;
  incomingRequests: RelayRequestTable;
  creditTable: RelayCreditTable;
  allocations: ReadonlyMap<number, RelayStreamAlloc>;
  client?: RelayResourceClient;
  assembler?: RelayChunkAssembler;
  authority?: RelayResourceAuthority;
  /** Provider envelopes waiting for window credit, per stream. */
  demand: ReadonlyMap<number, readonly RelayResourceEnvelope[]>;
  outboxFrames: number;
}

// --- per-session state ----------------------------------------------------------

interface Bound {
  session: bigint;
  negotiation: RelayNegotiation;
  sideband: RelaySideband;
  creditTable: RelayCreditTable;
  sender: RelaySender;
  /** Inbound window grants: stream 0's control slice plus one slice per
   * opened stream. The receiver reads this map. */
  allocations: Map<number, RelayStreamAlloc>;
  receiver: RelayReceiver;
  requests: RelayRequestTable;
  outgoingRequests: RelayRequestTable;
  incomingRequests: RelayRequestTable;
  privatePending: Map<number, { stream: number; op: RelayPrivateOp; resolve: (result: RelayPrivateResult) => void }>;
  operationPending: Map<number, { stream: number; op: RelayOperationOp; resolve: (result: RelayPrivateResult) => void }>;
  privateIncoming: Map<number, { request: RelayIncomingRequest; op: RelayPrivateOp; terminalQueued: boolean; accepted: boolean;
    identity?: RelayOperationIdentity; owner?: boolean; detach?: () => void }>;
  earlyCancels: Map<number, { targetStream: number; correlation: number; reason: string }>;
  lastIncoming: Map<number, number>;
  assembler?: RelayChunkAssembler;
  client?: RelayResourceClient;
  authority?: RelayResourceAuthority;
  demand: Map<number, RelayResourceEnvelope[]>;
  /** Sideband controls the lane refused (SIDEBAND_FULL): retried on the next
   * flush. Bounded by pending requests (cancels) plus streams (resets). */
  pendingSideband: Array<() => P3Result>;
  streamsByNs: Map<string, number>;
}

/** Stream 0's slice of the attachment window: a quarter, capped by the §3.9
 * control proposal (the RelaySender default, written out so the receiver
 * side of the peer computes the same value). */
export function relayControlSlice(limits: RelayRxLimits): RelayStreamAlloc {
  return {
    frames: Math.max(1, Math.min(RELAY_LIMITS.controlWindowFrames, Math.floor(limits.windowFrames / 4))),
    bytes: Math.max(1, Math.min(RELAY_LIMITS.controlWindowBytes, Math.floor(limits.windowBytes / 4))),
  };
}

/** A newly opened stream takes the OPEN response's per-stream window,
 * capped by what the attachment window has left after stream 0 and the
 * live streams opened before it. Both ends see the same OPEN responses and
 * resets in the same order, so both compute the same slice; a reset stream
 * returns its slice (its id never reopens within a session). */
export function relayStreamSlice(
  attachment: RelayRxLimits,
  allocated: Iterable<RelayStreamAlloc>,
  opened: RelayRxLimits,
): RelayStreamAlloc {
  let frames = 0;
  let bytes = 0;
  for (const a of allocated) { frames += a.frames; bytes += a.bytes; }
  return {
    frames: Math.min(opened.windowFrames, attachment.windowFrames - frames),
    bytes: Math.min(opened.windowBytes, attachment.windowBytes - bytes),
  };
}

const priorityFor = (type: number) => type === RELAY_TYPE.INVALIDATE ? RELAY_PRIORITY.CONTROL : RELAY_PRIORITY.VISIBLE;

// --- the endpoint -----------------------------------------------------------------

export class RelayEndpoint {
  readonly session: RelaySession;
  readonly role: "guest" | "provider";
  private readonly transport: RelayTransportAdapter;
  private readonly hooks: RelayEndpointHooks;
  private readonly outbox: Uint8Array[] = [];
  private readonly outboxCap: number;
  private readonly requestReserve: number;
  private readonly privateOps: readonly RelayPrivateOp[];
  private readonly resourceForms: RelayResourceForms;
  private readonly operations: RelayOperationAuthority;
  private bound: Bound | null = null;
  private flushing = false;
  private drainingOutbox = false;
  private flushAgain = false;
  private flushScheduled = false;
  private protocolErrorCount = 0;

  /** The L2 seam the resource client calls; every call lands in the P3
   * sender, never on the transport. */
  private readonly wire: RelayResourceWire = {
    request: (stream, metadata, data, codec) => this.wireRequest(stream, metadata, data, codec),
    advise: (metadata) => this.wireAdvise(metadata),
    cancel: (stream, correlation, reason) => this.wireCancel(stream, correlation, reason ?? "cancel"),
  };

  constructor(private readonly options: RelayEndpointOptions) {
    this.role = options.role;
    this.transport = options.transport;
    this.hooks = options.hooks ?? {};
    this.outboxCap = options.outboxFrames ?? 32;
    this.requestReserve = options.requestReserve ?? 0;
    if (options.local.opExt?.length) throw new Error("RelayEndpoint derives opExt from privateOps");
    this.privateOps = installPrivateOps(options.privateOps ?? [], options.local.profiles, options.local.rxLimits);
    this.resourceForms = new RelayResourceForms(options.resourceForms ?? [], options.local.profiles);
    const inputEpoch = !options.operations && options.randomBytes
      ? Array.from(options.randomBytes(8), byte => byte.toString(16).padStart(2, "0")).join("") : undefined;
    this.operations = options.operations ?? new RelayOperationAuthority({ id: "session-input",
      store: new RelayMemoryOperationStore(64, inputEpoch) });
    const peerRole = this.role === "guest" ? "provider" : "guest";
    if (!this.operations.durable && this.privateOps.some(op => op.recovery === "durable" && privateOpAllows(op, peerRole))) {
      throw new Error("incoming durable ops require a durable operation store");
    }
    this.session = createRelaySession({
      role: options.role,
      local: { ...options.local, opExt: privateDescriptors(this.privateOps) },
      transport: { peer: options.transport.peer, trySend: (bytes) => this.trySendDirect(bytes) },
      scheduler: options.scheduler,
      randomBytes: options.randomBytes,
      pingIntervalMs: options.pingIntervalMs,
      stallMs: options.stallMs,
      retryMs: options.retryMs,
      authorizeOpen: this.hooks.authorizeOpen,
      onPhase: (phase, detail) => this.onPhase(phase, detail),
      onBusinessFrame: (frame, wireBytes) => this.onBusinessFrame(frame, wireBytes),
      onCredit: (metadata) => this.onCredit(metadata),
      onReset: (metadata) => this.onPeerReset(metadata),
      onStreamError: (stream, code) => this.onStreamError(stream, code),
      admitControl: (input) => this.admitControl(input),
      onControlFrame: (frame, wireBytes) => this.onControlFrame(frame, wireBytes),
      onCancel: (frame) => this.onPeerCancel(frame),
      onStreamOpened: (opened) => this.onStreamOpened(opened),
    });
  }

  get phase(): RelayPhase { return this.session.phase; }
  get peer(): RelayPeerContext { return this.transport.peer; }
  get negotiation(): RelayNegotiation | undefined { return this.session.negotiation; }
  /** The current session's resource client (guest); undefined before the
   * session is pinned and after it ends. */
  get client(): RelayResourceClient | undefined { return this.bound?.client; }
  /** The current session's authority (provider). */
  get authority(): RelayResourceAuthority | undefined { return this.bound?.authority; }
  get protocolErrors(): number { return this.protocolErrorCount; }

  inspect(): RelayEndpointInspection | undefined {
    const b = this.bound;
    if (!b) return undefined;
    return {
      session: b.session, negotiation: b.negotiation, sender: b.sender, receiver: b.receiver,
      requests: b.requests, creditTable: b.creditTable, allocations: b.allocations,
      outgoingRequests: b.outgoingRequests, incomingRequests: b.incomingRequests,
      client: b.client, assembler: b.assembler, authority: b.authority, demand: b.demand,
      outboxFrames: this.outbox.length,
    };
  }

  // --- L1 surface -------------------------------------------------------------------

  /** Guest: start the handshake. */
  hello(): { ok: true } | { ok: false; code: string } {
    const result = this.session.hello();
    this.flush();
    return result;
  }

  whenReady(): Promise<RelayNegotiation> { return this.session.whenReady(); }

  /** Guest: OPEN a stream; the window slice exists when the promise resolves. */
  open(request: RelayOpenRequest): Promise<RelayOpenResult> {
    const opened = this.session.open(request);
    this.flush();
    return opened;
  }

  /** One complete wire record from the transport: decode and session
   * checks, window accounting, delivery of everything staged, and a send
   * pump. A host with a per-frame delivery budget calls ingestRecord(),
   * pumpReceive(n) and flush() itself. */
  handleRecord(bytes: Uint8Array): void {
    this.ingestRecord(bytes);
    this.pumpReceive();
    this.flush();
  }

  /** Decode and stage one record without delivering business frames. */
  ingestRecord(bytes: Uint8Array): void {
    this.session.handleRecord(bytes);
  }

  /** The physical connection dropped: the session returns to idle and the
   * per-session machines are discarded. */
  handleDisconnect(reason: string): void {
    this.session.handleDisconnect(reason);
  }

  /** Protocol teardown from this end. */
  close(): void {
    this.session.close();
  }

  // --- profile-owned REQUESTs (both roles) ---------------------------------------------

  request(stream: number, name: string, args: unknown, options: RelayPrivateRequestOptions = {}): RelayPrivateCall {
    if (isOperationOp(name)) {
      if (Object.keys(options).length) return this.refuseOperation(RELAY_ERROR.INVALID);
      return this.requestOperation(stream, name, args);
    }
    const refused = (code: string): RelayPrivateCall => Object.assign(
      Promise.resolve<RelayPrivateResult>({ ok: false, error: { code, message: code } }),
      { correlation: 0, cancel: () => {} },
    );
    const b = this.bound;
    const op = this.privateOp(stream, name);
    if (!op || !privateOpAllows(op, this.role)) return refused(RELAY_ERROR.UNSUPPORTED);
    if (!b || this.phase !== "ready" || !b.allocations.has(stream)) return refused(RELAY_ERROR.BUSY);
    if (Object.keys(options).some(key => key !== "opEpoch" && key !== "opId")) return refused(RELAY_ERROR.INVALID);
    const prepared = preparePrivateOp(op, { type: RELAY_TYPE.REQUEST, stream,
      metadata: { op: name, args, ...options } }, this.session.streamInfo(stream)!.rxLimits);
    if (!prepared.ok) return refused(prepared.code);
    const correlation = this.session.allocateCorrelation();
    if (!correlation) return refused(RELAY_ERROR.RESYNC_REQUIRED);
    const slot = b.outgoingRequests.admitKnown(stream, correlation);
    if (!slot.ok) return refused(RELAY_ERROR.BUSY);
    const admitted = b.sender.admit({ type: RELAY_TYPE.REQUEST, stream, correlation, metadata: prepared.metadata,
      priority: RELAY_PRIORITY.CONTROL, association: { kind: "correlation", id: correlation } });
    if (!admitted.ok) { b.outgoingRequests.abandon(correlation); return refused(admitted.code); }
    // Register before flush: a synchronous transport can deliver the terminal inside it.
    const result = new Promise<RelayPrivateResult>(resolve => {
      b.privatePending.set(correlation, { stream, op, resolve });
    });
    const call = Object.assign(result, { correlation, cancel: (reason = "cancel") => {
      if (this.bound === b && b.privatePending.has(correlation)) { this.wireCancel(stream, correlation, reason); this.flush(); }
    } });
    this.flush();
    return call;
  }

  operationEpoch(stream: number, args: RelayOperationEpochArgs): RelayPrivateCall<RelayOperationEpochValue> {
    return this.requestOperation(stream, RELAY_OP.OPERATION_EPOCH, args) as RelayPrivateCall<RelayOperationEpochValue>;
  }

  operationStatus(stream: number, args: RelayOperationStatusArgs): RelayPrivateCall<RelayOperationStatusValue> {
    return this.requestOperation(stream, RELAY_OP.OPERATION_STATUS, args) as RelayPrivateCall<RelayOperationStatusValue>;
  }

  private refuseOperation(code: string): RelayPrivateCall {
    return Object.assign(Promise.resolve<RelayPrivateResult>({ ok: false, error: { code, message: code } }),
      { correlation: 0, cancel: () => {} });
  }

  private streamOps(stream: number): RelayPrivateOp[] {
    return (this.session.streamInfo(stream)?.opExt ?? []).map(op => this.privateOp(stream, op.name)!).filter(Boolean);
  }

  private requestOperation(stream: number, op: RelayOperationOp, args: unknown): RelayPrivateCall {
    const b = this.bound, binding = this.session.streamInfo(stream);
    if (!binding || stream === 0) return this.refuseOperation(RELAY_ERROR.UNSUPPORTED);
    const definitions = this.streamOps(stream);
    if (!definitions.some(op => op.recovery !== "idempotent" && privateOpAllows(op, this.role))) {
      return this.refuseOperation(RELAY_ERROR.UNSUPPORTED);
    }
    if (!b || this.phase !== "ready" || !b.allocations.has(stream)) return this.refuseOperation(RELAY_ERROR.BUSY);
    const prepared = prepareOperation(op, { type: RELAY_TYPE.REQUEST, stream, metadata: { op, args } }, binding.rxLimits, definitions);
    if (!prepared.ok) return this.refuseOperation(prepared.code);
    if ((prepared.metadata.args as { ns: string }).ns !== binding.namespace) return this.refuseOperation(RELAY_ERROR.UNAUTHORIZED);
    const correlation = this.session.allocateCorrelation();
    if (!correlation) return this.refuseOperation(RELAY_ERROR.RESYNC_REQUIRED);
    if (!b.outgoingRequests.admitKnown(stream, correlation).ok) return this.refuseOperation(RELAY_ERROR.BUSY);
    const admitted = b.sender.admit({ type: RELAY_TYPE.REQUEST, stream, correlation, metadata: prepared.metadata,
      priority: RELAY_PRIORITY.CONTROL, association: { kind: "correlation", id: correlation } });
    if (!admitted.ok) { b.outgoingRequests.abandon(correlation); return this.refuseOperation(admitted.code); }
    const result = new Promise<RelayPrivateResult>(resolve => b.operationPending.set(correlation, { stream, op, resolve }));
    const call = Object.assign(result, { correlation, cancel: (reason = "cancel") => {
      if (this.bound === b && b.operationPending.has(correlation)) { this.wireCancel(stream, correlation, reason); this.flush(); }
    } });
    this.flush();
    return call;
  }

  /** One successful idempotent terminal. Mutations commit through their
   * operation handle. Errors use replyError(); accepted uses respond(). */
  replyValue(request: RelayIncomingRequest, value: unknown): { ok: true } | { ok: false; code: string } {
    if (request.session !== this.bound?.session) return { ok: false, code: RELAY_ERROR.RESYNC_REQUIRED };
    const mutation = this.bound?.privateIncoming.get(request.correlation)?.op.recovery !== "idempotent"
      && this.bound?.privateIncoming.has(request.correlation);
    return this.respond({ type: RELAY_TYPE.RESPONSE, stream: request.stream, correlation: request.correlation,
      metadata: { op: request.op, status: RELAY_STATUS.OK, final: true, value, ...(mutation ? { effect: RELAY_EFFECT.COMMITTED } : {}) } });
  }

  private privateOp(stream: number, name: string): RelayPrivateOp | undefined {
    if (stream === 0) return undefined;
    const binding = this.session.streamInfo(stream);
    const selected = binding?.opExt?.find(op => op.name === name);
    if (!selected) return undefined;
    const local = this.privateOps.find(op => op.name === name && samePrivateProfile(op.profile, selected.profile));
    return local ? { ...local, ...selected } : undefined;
  }

  private privateError(request: { stream: number; correlation: number; op: string },
    code: string, message = code, effect?: string): RelayResourceEnvelope {
    let clipped = "", length = 0;
    for (const char of message) {
      length += new TextEncoder().encode(char).length;
      if (length > RELAY_LIMITS.errorMessageMaxBytes) break;
      clipped += char;
    }
    return { type: RELAY_TYPE.RESPONSE, stream: request.stream, correlation: request.correlation,
      metadata: { op: request.op, status: RELAY_STATUS.ERROR, final: true,
        error: { code, message: clipped || code }, ...(effect === undefined ? {} : { effect }) } };
  }

  private respondPrivate(b: Bound, envelope: RelayResourceEnvelope): { ok: true } | { ok: false; code: string } {
    const pending = b.privateIncoming.get(envelope.correlation);
    if (!pending || pending.request.stream !== envelope.stream || pending.request.op !== envelope.metadata.op
        || envelope.type !== RELAY_TYPE.RESPONSE) return { ok: false, code: RELAY_ERROR.UNSUPPORTED };
    if (pending.terminalQueued || (pending.accepted && envelope.metadata.status === RELAY_STATUS.ACCEPTED)) {
      return { ok: false, code: RELAY_P3_ERROR.ALREADY_TERMINAL };
    }
    const limits = this.session.streamInfo(envelope.stream)!.rxLimits;
    const prepared = preparePrivateOp(pending.op, envelope, limits);
    if (!prepared.ok) return prepared;
    if (pending.identity && prepared.metadata.final === true) {
      const stored = this.operations.finish(pending.identity, prepared.metadata);
      if (!stored.ok) return stored;
      // Store listeners publish to every correlation observing this operation.
      return { ok: true };
    }
    // Mark before enqueuing: one terminal (and at most one accepted) per admitted request.
    if (prepared.metadata.final === true) pending.terminalQueued = true;
    else pending.accepted = true;
    this.enqueue(b, { ...envelope, metadata: prepared.metadata });
    this.flush();
    return { ok: true };
  }

  private servePrivateRequest(b: Bound, request: RelayIncomingRequest, wireBytes: number): void {
    const op = this.privateOp(request.stream, request.op);
    const peerRole = this.role === "guest" ? "provider" : "guest";
    if (!op || !privateOpAllows(op, peerRole)) {
      this.enqueue(b, this.privateError(request, RELAY_ERROR.UNSUPPORTED)); return;
    }
    const noEffect = op.recovery === "idempotent" ? undefined : RELAY_EFFECT.NONE;
    if (wireBytes > op.maxWireBytes) { this.enqueue(b, this.privateError(request, RELAY_ERROR.TOO_LARGE, undefined, noEffect)); return; }
    const prepared = preparePrivateOp(op, { type: RELAY_TYPE.REQUEST, ...request },
      this.session.streamInfo(request.stream)!.rxLimits);
    if (!prepared.ok) { this.enqueue(b, this.privateError(request, prepared.code, undefined, noEffect)); return; }
    b.privateIncoming.set(request.correlation, { request, op, terminalQueued: false, accepted: false });
    if (op.recovery !== "idempotent") {
      const began = this.operations.begin(this.peer.id, this.session.streamInfo(request.stream)!.namespace, op,
        prepared.metadata.opEpoch as string, prepared.metadata.opId as string, prepared.metadata.args);
      if (!began.ok) {
        const refused = this.replyError(request, began.code, began.code,
          began.code === RELAY_ERROR.OUTCOME_UNKNOWN ? RELAY_EFFECT.UNKNOWN : RELAY_EFFECT.NONE);
        if (!refused.ok) this.resetStream(request.stream, `operation admission refused: ${refused.code}`);
        return;
      }
      const pending = b.privateIncoming.get(request.correlation)!;
      pending.identity = began.value.identity;
      pending.owner = began.value.fresh;
      const observed = this.operations.observing(began.value.identity);
      request.operation = this.operationHandle(op, began.value.identity, this.session.streamInfo(request.stream)!.rxLimits);
      pending.detach = this.operations.watch(began.value.identity, terminal => this.publishOperation(b, request, terminal));
      if (began.value.record.terminal) { this.publishOperation(b, request, began.value.record.terminal); return; }
      if (request.cancelRequested()) { this.cancelOperation(b, request.correlation); return; }
      if (!began.value.fresh) {
        if (!observed) {
          // Another authority process or its journal owns this pending work.
          // No local completion callback exists; finish this observer with
          // unknown so it can query, without altering the operation record.
          this.publishOperation(b, request, this.privateError(request, RELAY_ERROR.OUTCOME_UNKNOWN,
            "query pending operation", RELAY_EFFECT.UNKNOWN).metadata);
          return;
        }
        this.respondPrivate(b, { type: RELAY_TYPE.RESPONSE, stream: request.stream, correlation: request.correlation,
          metadata: { op: op.name, status: RELAY_STATUS.ACCEPTED, final: false } });
        return;
      }
    }
    let answered: { ok: true } | { ok: false; code: string };
    try {
      if (this.hooks.onRequest?.(request)) return;
      answered = this.replyError(request, RELAY_ERROR.UNSUPPORTED, "no private op handler", noEffect);
    } catch {
      // A product handler failure may follow a side effect. Never imply it was uncommitted.
      answered = this.replyError(request, RELAY_ERROR.OUTCOME_UNKNOWN, "private op handler failed", RELAY_EFFECT.UNKNOWN);
    }
    if (!answered.ok && b.privateIncoming.get(request.correlation)?.terminalQueued === false) {
      // A small op budget can fit args but not the automatic error envelope.
      // Reset owns the terminal outcome when no response can fit that budget.
      this.resetStream(request.stream, `private error refused: ${answered.code}`);
    }
  }

  private operationHandle(op: RelayPrivateOp, identity: RelayOperationIdentity, limits: RelayRxLimits): RelayIncomingOperation {
    const finish = (metadata: Record<string, unknown>, apply?: () => void, reconcile = false): { ok: true } | { ok: false; code: string } => {
      const prepared = preparePrivateOp(op, { type: RELAY_TYPE.RESPONSE, stream: 1, metadata }, limits);
      if (!prepared.ok) return prepared;
      const stored = this.operations.finish(identity, prepared.metadata, { apply, reconcile });
      if (!stored.ok) return stored;
      if (stored.value.effect === RELAY_EFFECT.UNKNOWN) return { ok: false, code: RELAY_ERROR.OUTCOME_UNKNOWN };
      if (metadata.status === RELAY_STATUS.OK && stored.value.status !== RELAY_STATUS.OK) {
        return { ok: false, code: (stored.value.error as { code: string }).code };
      }
      if (reconcile && metadata.effect !== stored.value.effect) return { ok: false, code: RELAY_ERROR.STALE_BASE };
      return { ok: true };
    };
    return Object.freeze({ identity,
      commit: (value: unknown, apply: () => void) => finish(
        { op: op.name, status: RELAY_STATUS.OK, final: true, effect: RELAY_EFFECT.COMMITTED, value }, apply),
      reconcile: (result: { state: "committed"; value: unknown } | { state: "rejected"; code: string; message?: string }) =>
        result.state === "committed"
          ? finish({ op: op.name, status: RELAY_STATUS.OK, final: true, effect: RELAY_EFFECT.COMMITTED, value: result.value }, undefined, true)
          : finish(this.privateError({ stream: 1, correlation: 1, op: op.name }, result.code, result.message, RELAY_EFFECT.NONE).metadata, undefined, true),
    });
  }

  private publishOperation(b: Bound, request: RelayIncomingRequest, metadata: Record<string, unknown>): void {
    const pending = b.privateIncoming.get(request.correlation);
    if (this.bound !== b || !pending || pending.request !== request || pending.terminalQueued) return;
    const prepared = preparePrivateOp(pending.op, { type: RELAY_TYPE.RESPONSE, stream: request.stream, metadata },
      this.session.streamInfo(request.stream)!.rxLimits);
    if (!prepared.ok) { this.resetStream(request.stream, `operation terminal refused: ${prepared.code}`); return; }
    pending.terminalQueued = true; pending.detach?.();
    this.enqueue(b, { type: RELAY_TYPE.RESPONSE, stream: request.stream, correlation: request.correlation, metadata: prepared.metadata });
    this.flush();
  }

  private cancelOperation(b: Bound, correlation: number): void {
    const pending = b.privateIncoming.get(correlation);
    if (!pending?.identity || pending.terminalQueued) return;
    const cancelled = this.operations.finish(pending.identity,
      this.privateError(pending.request, RELAY_ERROR.CANCELLED, "cancelled before commit", RELAY_EFFECT.NONE).metadata);
    if (!cancelled.ok) this.resetStream(pending.request.stream, `operation cancel refused: ${cancelled.code}`);
  }

  private deliverPrivateResponse(b: Bound, frame: RelayDecodedFrame, wireBytes: number): void {
    const pending = b.privatePending.get(frame.correlation);
    if (!pending) { this.protocolError(RELAY_P3_ERROR.UNKNOWN_REQUEST, "private response without a request"); return; }
    if (pending.stream !== frame.stream || pending.op.name !== frame.metadata.op) {
      this.protocolError(RELAY_P3_ERROR.BAD_CORRELATION, "private response stream/op mismatch"); return;
    }
    const prepared = wireBytes > pending.op.maxWireBytes
      ? { ok: false as const, code: RELAY_ERROR.TOO_LARGE }
      : preparePrivateOp(pending.op, frame, this.session.streamInfo(frame.stream)!.rxLimits);
    if (!prepared.ok) {
      this.protocolError(prepared.code, "private response schema or budget");
      if (frame.metadata.final === true) {
        this.completePrivate(b, frame.correlation, { ok: false, error: { code: prepared.code, message: prepared.code }, effect: RELAY_EFFECT.UNKNOWN });
      } else this.resetStream(frame.stream, "invalid private response");
      return;
    }
    if (frame.metadata.final !== true) return;
    const meta = prepared.metadata;
    this.completePrivate(b, frame.correlation, meta.status === RELAY_STATUS.OK
      ? { ok: true, value: meta.value, ...(meta.effect === undefined ? {} : { effect: meta.effect as string }) }
      : { ok: false, error: meta.error as RelayErrorBody, ...(meta.effect === undefined ? {} : { effect: meta.effect as string }) });
  }

  private completePrivate(b: Bound, correlation: number, result: RelayPrivateResult): void {
    const pending = b.privatePending.get(correlation);
    if (!pending) return;
    const recorded = b.outgoingRequests.terminal(correlation, { final: true, status: result.ok ? RELAY_STATUS.OK : RELAY_STATUS.ERROR,
      ...(!result.ok ? { errorCode: result.error.code, effect: result.effect } : {}) });
    if (!recorded.ok) { this.protocolError(recorded.code, "private terminal"); return; }
    const consumed = b.outgoingRequests.consumeTerminal(correlation);
    if (!consumed.ok) { this.protocolError(consumed.code, "private terminal consumption"); return; }
    b.privatePending.delete(correlation);
    pending.resolve(result);
  }

  private failPrivate(b: Bound, stream?: number): void {
    for (const [correlation, pending] of b.privatePending) {
      if (stream !== undefined && pending.stream !== stream) continue;
      b.privatePending.delete(correlation);
      const code = pending.op.recovery === "idempotent" ? RELAY_ERROR.RESYNC_REQUIRED : RELAY_ERROR.OUTCOME_UNKNOWN;
      pending.resolve({ ok: false, error: { code, message: code }, effect: RELAY_EFFECT.UNKNOWN });
    }
    for (const [correlation, pending] of b.operationPending) {
      if (stream !== undefined && pending.stream !== stream) continue;
      b.operationPending.delete(correlation);
      pending.resolve({ ok: false, error: { code: RELAY_ERROR.RESYNC_REQUIRED, message: RELAY_ERROR.RESYNC_REQUIRED } });
    }
    for (const [id, pending] of b.privateIncoming) if (stream === undefined || pending.request.stream === stream) {
      pending.detach?.(); b.privateIncoming.delete(id);
      if (pending.identity && pending.owner && !pending.terminalQueued) this.operations.finish(pending.identity,
        this.privateError(pending.request, RELAY_ERROR.OUTCOME_UNKNOWN, "session ended", RELAY_EFFECT.UNKNOWN).metadata);
    }
    for (const [id, cancel] of b.earlyCancels) if (stream === undefined || cancel.targetStream === stream) b.earlyCancels.delete(id);
  }

  private validateJsonValue(
    profile: { name: string; version: number } | undefined, kind: number, bytes: Uint8Array,
  ): string | null {
    let value: unknown;
    try {
      value = parseRelayJson(bytes);
    } catch {
      return "resource value is not one JSON value";
    }
    // Codec 1 is strict JSON for every kind. An installed value schema adds
    // product shape validation; without one, parsing is the full check.
    if (!this.resourceForms.formFor(profile, kind)?.value) return null;
    return this.resourceForms.validateValue(profile, kind, value);
  }

  /** Validate outbound product get args against the stream form. */
  private checkProductGet(stream: number, ref: RelayResourceRef,
    product: { key: string; value: unknown } | undefined): string | null {
    if (!product) return null;
    const form = this.resourceForms.formFor(this.session.streamInfo(stream)?.profile, ref.kind);
    if (!form?.argsKey || form.argsKey !== product.key) return `args key ${product.key} has no form`;
    return validateRelaySchema(form.args!, product.value, `args.${product.key}`);
  }

  /** Validate outbound product subscribe args for a ref or namespace target. */
  private checkProductSubscribe(stream: number, target: RelayResourceRef | { ns: string },
    product: { key: string; value: unknown } | undefined): string | null {
    if (!product) return null;
    const profile = this.session.streamInfo(stream)?.profile;
    const form = "kind" in target
      ? this.resourceForms.formFor(profile, target.kind)
      : this.resourceForms.subscribeFormForKey(profile, product.key);
    if (!form?.argsKey || form.argsKey !== product.key || form.onSubscribe !== true) {
      return `args key ${product.key} is not registered for subscribe`;
    }
    return validateRelaySchema(form.args!, product.value, `args.${product.key}`);
  }

  // --- L2 surface: guest ---------------------------------------------------------------

  get(
    stream: number,
    ref: RelayResourceRef,
    args: { accept: number[]; maxObjectBytes: number; ifRevision?: string; product?: { key: string; value: unknown } },
    complete: (result: ResourceResult<RelayGetOutcome>) => void,
  ): { correlation: number } | { ok: false; code: string } {
    const bound = this.bound;
    const client = bound?.client;
    if (!client) return { ok: false, code: RELAY_ERROR.BUSY };
    if (!relayKindNegotiated(bound.negotiation.kinds, ref.kind)) {
      return { ok: false, code: RELAY_ERROR.UNSUPPORTED };
    }
    const invalid = this.checkProductGet(stream, ref, args.product);
    if (invalid) return { ok: false, code: RELAY_ERROR.INVALID };
    const result = client.get(stream, ref, args, complete);
    this.flush();
    return result;
  }

  subscribe(
    stream: number,
    target: RelayResourceRef | { ns: string },
    delivery: string,
    handler: RelaySubscriptionHandler,
    complete: (result: ResourceResult<{ subscription?: number }>) => void,
    /** Push-channel scratch this subscriber reserves; defaults to the
     * negotiated maxObjectBytes. */
    options?: { maxObjectBytes?: number; product?: { key: string; value: unknown } },
  ): { correlation: number } | { ok: false; code: string } {
    const bound = this.bound;
    const client = bound?.client;
    if (!client) return { ok: false, code: RELAY_ERROR.BUSY };
    if ("kind" in target && !relayKindNegotiated(bound.negotiation.kinds, target.kind)) {
      return { ok: false, code: RELAY_ERROR.UNSUPPORTED };
    }
    const invalid = this.checkProductSubscribe(stream, target, options?.product);
    if (invalid) return { ok: false, code: RELAY_ERROR.INVALID };
    const result = client.subscribe(stream, target, delivery, handler, complete, options);
    this.flush();
    return result;
  }

  unsubscribe(subscription: number, complete?: (result: ResourceResult<{ subscription?: number }>) => void):
    { correlation: number } | { ok: false; code: string } {
    const client = this.bound?.client;
    if (!client) return { ok: false, code: RELAY_ERROR.BUSY };
    const result = client.unsubscribe(subscription, complete);
    this.flush();
    return result;
  }

  release(stream: number, ref: RelayResourceRef, lease: number,
    complete?: (result: ResourceResult<{ subscription?: number }>) => void):
    { correlation: number } | { ok: false; code: string } {
    const bound = this.bound;
    const client = bound?.client;
    if (!client) return { ok: false, code: RELAY_ERROR.BUSY };
    if (!relayKindNegotiated(bound.negotiation.kinds, ref.kind)) {
      return { ok: false, code: RELAY_ERROR.UNSUPPORTED };
    }
    const result = client.release(stream, ref, lease, complete);
    this.flush();
    return result;
  }

  reportEvict(ref: RelayResourceRef, reason: string): void {
    const bound = this.bound;
    if (!bound || !relayKindNegotiated(bound.negotiation.kinds, ref.kind)) return;
    bound.client?.reportEvict(ref, reason);
    this.flush();
  }

  /** Withdraw interest in an in-flight get: request.cancel on the
   * sideband; the slot frees when the one terminal is consumed. */
  cancel(correlation: number, reason = "cancel"): void {
    const pending = this.bound?.privatePending.get(correlation) ?? this.bound?.operationPending.get(correlation);
    if (pending) { this.wireCancel(pending.stream, correlation, reason); this.flush(); return; }
    this.bound?.client?.cancel(correlation, reason);
    this.flush();
  }

  // --- L2 surface: provider ------------------------------------------------------------

  /** Queue one prepared envelope (a terminal, a chunk, a push, an
   * invalidate) on its stream; credit admission happens in flush(). */
  respond(envelope: RelayResourceEnvelope): { ok: true } | { ok: false; code: string } {
    const b = this.bound;
    if (!b) return { ok: false, code: RELAY_ERROR.BUSY };
    if (String(envelope.metadata.op).startsWith("x.") || b.privateIncoming.has(envelope.correlation)) {
      return this.respondPrivate(b, envelope);
    }
    this.enqueue(b, envelope);
    this.flush();
    return { ok: true };
  }

  replyError(request: { stream: number; correlation: number; op: string; metadata?: Record<string, unknown>; session?: bigint },
    code: string, message = code, effect?: string): { ok: true } | { ok: false; code: string } {
    const b = this.bound;
    if (request.session !== undefined && request.session !== b?.session) return { ok: false, code: RELAY_ERROR.RESYNC_REQUIRED };
    if (b && (request.op.startsWith("x.") || b.privateIncoming.has(request.correlation))) {
      return this.respond(this.privateError(request, code, message, effect));
    }
    if (!b?.authority) return { ok: false, code: RELAY_ERROR.BUSY };
    const envelope = request.op === RELAY_OP.RESOURCE_GET
      ? b.authority.answerGetError(request, code, message)
      : b.authority.answerError(request, request.op, code, message);
    if (effect !== undefined) envelope.metadata.effect = effect;
    return this.respond(envelope);
  }

  replyNotModified(
    request: Pick<RelayIncomingRequest, "stream" | "correlation" | "metadata">,
    ref: RelayResourceRef,
  ): { ok: true } | { ok: false; code: string } {
    const b = this.bound;
    if (!b?.authority) return { ok: false, code: RELAY_ERROR.BUSY };
    const requested = request.metadata.resource as RelayResourceRef;
    if (!relayKindNegotiated(b.negotiation.kinds, requested.kind)
        || !relayKindNegotiated(b.negotiation.kinds, ref.kind)) {
      this.respond(b.authority.answerGetError(request, RELAY_ERROR.UNSUPPORTED,
        "resource kind was not negotiated"));
      return { ok: false, code: RELAY_ERROR.UNSUPPORTED };
    }
    if (!relayGetResponseMatchesRequest(requested, ref)) {
      this.respond(b.authority.answerGetError(request, RELAY_ERROR.INVALID,
        "response resource differs from request resource"));
      return { ok: false, code: RELAY_ERROR.INVALID };
    }
    return this.respond(b.authority.answerNotModified(request, ref));
  }

  /** Validate provider-produced content against the stream's form before
   * it is chunked or pushed: metadata `value` (any codec) and, for codec 1
   * (JSON), the data region itself. Binary codecs have no JSON schema. */
  private checkProductObject(
    stream: number, kind: number, codec: number, data: Uint8Array, value: unknown,
  ): string | null {
    const profile = this.session.streamInfo(stream)?.profile;
    if (codec === RELAY_CODEC.JSON && data.length && value !== undefined) {
      return "codec 1 data cannot carry metadata value";
    }
    if (value !== undefined) {
      const invalid = this.resourceForms.validateValue(profile, kind, value);
      if (invalid) return invalid;
    }
    if (codec === RELAY_CODEC.JSON && data.length) return this.validateJsonValue(profile, kind, data);
    // Codec 0 carries product content in metadata. A zero-byte codec-1 input
    // also has no content; chunking represents that absence as codec 0.
    return data.length === 0 && value === undefined
      ? this.resourceForms.validateValue(profile, kind, undefined)
      : null;
  }

  /** Answer a resource.get with one complete object: admission against the
   * request's accept/maxObjectBytes, chunking under the negotiated limits,
   * then the chunks enter the stream's demand FIFO. A refusal is answered
   * to the peer with the error terminal and reported to the caller. */
  replyObject(
    request: RelayIncomingRequest,
    object: { ref: RelayResourceRef; codec: number; data: Uint8Array; value?: Record<string, unknown> },
  ): { ok: true; frames: number } | { ok: false; code: string } {
    const b = this.bound;
    if (!b?.authority) return { ok: false, code: RELAY_ERROR.BUSY };
    const args = request.metadata.args as { accept: number[]; maxObjectBytes: number };
    const requested = request.metadata.resource as RelayResourceRef;
    if (!relayKindNegotiated(b.negotiation.kinds, requested.kind)
        || !relayKindNegotiated(b.negotiation.kinds, object.ref.kind)) {
      this.respond(b.authority.answerGetError(request, RELAY_ERROR.UNSUPPORTED,
        "resource kind was not negotiated"));
      return { ok: false, code: RELAY_ERROR.UNSUPPORTED };
    }
    if (!args.accept.includes(object.codec)) {
      this.respond(b.authority.answerGetError(request, RELAY_ERROR.UNSUPPORTED, `codec ${object.codec} not accepted`));
      return { ok: false, code: RELAY_ERROR.UNSUPPORTED };
    }
    const schemaError = !relayGetResponseMatchesRequest(requested, object.ref)
      ? "response resource differs from request resource"
      : this.checkProductObject(request.stream, requested.kind, object.codec, object.data, object.value);
    if (schemaError) {
      this.respond(b.authority.answerGetError(request, RELAY_ERROR.INVALID, schemaError));
      return { ok: false, code: RELAY_ERROR.INVALID };
    }
    const refused = b.authority.checkGet(object.data.length, args);
    if (refused) {
      this.respond(b.authority.answerGetError(request, refused.code, refused.message ?? refused.code));
      return { ok: false, code: refused.code };
    }
    const plan = b.authority.chunkObject({
      type: RELAY_TYPE.RESPONSE, stream: request.stream, correlation: request.correlation,
      ref: object.ref, codec: object.codec, data: object.data, value: object.value,
    });
    if (!plan.ok) {
      this.respond(b.authority.answerGetError(request, plan.code, plan.message));
      return { ok: false, code: plan.code };
    }
    for (const env of plan.frames) this.enqueue(b, env);
    this.flush();
    return { ok: true, frames: plan.frames.length };
  }

  /** Push one complete object to an active subscription. */
  pushObject(input: {
    stream: number; subscription: number; ref: RelayResourceRef; codec: number; data: Uint8Array;
    value?: Record<string, unknown>; baseRevision?: string;
  }): { ok: true; frames: number } | { ok: false; code: string } {
    const b = this.bound;
    if (!b?.authority) return { ok: false, code: RELAY_ERROR.BUSY };
    const sub = b.authority.subscriptionEntry(input.subscription);
    if (!sub || !sub.active || sub.stream !== input.stream) return { ok: false, code: RELAY_ERROR.NOT_FOUND };
    if (!relayKindNegotiated(b.negotiation.kinds, input.ref.kind)) {
      return { ok: false, code: RELAY_ERROR.UNSUPPORTED };
    }
    if (!b.authority.admitsPush(input.subscription, input.stream, input.ref)) {
      return { ok: false, code: RELAY_ERROR.INVALID };
    }
    const schemaError = this.checkProductObject(input.stream, input.ref.kind, input.codec, input.data, input.value);
    if (schemaError) return { ok: false, code: RELAY_ERROR.INVALID };
    const plan = b.authority.chunkObject({
      type: RELAY_TYPE.PUSH, stream: input.stream, correlation: 0, subscription: input.subscription,
      ref: input.ref, codec: input.codec, data: input.data, value: input.value, baseRevision: input.baseRevision,
    });
    if (!plan.ok) return { ok: false, code: plan.code };
    for (const env of plan.frames) this.enqueue(b, env);
    this.flush();
    return { ok: true, frames: plan.frames.length };
  }

  /** Authority invalidation on the stream bound to the namespace. */
  invalidate(input: Parameters<RelayResourceAuthority["buildInvalidate"]>[0]):
    { ok: true } | { ok: false; code: string } {
    const b = this.bound;
    if (!b?.authority) return { ok: false, code: RELAY_ERROR.BUSY };
    if ("ref" in input && !relayKindNegotiated(b.negotiation.kinds, input.ref.kind)) {
      return { ok: false, code: RELAY_ERROR.UNSUPPORTED };
    }
    return this.respond(b.authority.buildInvalidate(input));
  }

  /** relay.reset from this end: the peer's and this end's requests and
   * subscriptions on the stream fail; the id never reopens. */
  resetStream(stream: number, reason: string): void {
    const b = this.bound;
    if (!b || !b.allocations.has(stream) || stream === 0) return;
    const sent = b.sender.sendReset(stream, reason);
    if (!sent.ok && sent.code === RELAY_P3_ERROR.SIDEBAND_FULL) {
      b.pendingSideband.push(() => b.sender.sendReset(stream, reason));
    }
    this.session.forgetStream(stream);
    this.applyStreamReset(b, stream, reason);
    this.flush();
  }

  // --- send path ----------------------------------------------------------------------

  /** Drain the outbox, admit provider demand, pump the sender until the
   * window or the transport stops it. Re-entrant calls (a synchronous
   * transport delivering the peer's reply inside trySend) run once the
   * outer pass completes. */
  flush(): void {
    if (this.flushing) { this.flushAgain = true; return; }
    this.flushing = true;
    try {
      do {
        this.flushAgain = false;
        this.flushOnce();
      } while (this.flushAgain);
    } finally {
      this.flushing = false;
    }
  }

  private flushOnce(): void {
    const drained = this.drainOutbox();
    if (drained === "offline") { this.session.handleDisconnect("transport offline"); return; }
    if (drained === "busy") return;
    const b = this.bound;
    if (!b) return;
    this.retrySideband(b);
    this.admitDemand(b);
    for (let guard = 0; guard < 4096; guard++) {
      if (this.bound !== b) return;
      const pumped = b.sender.pump();
      this.outbox.push(...pumped.frames);
      if (!pumped.ok) { this.fatal(pumped.code ?? RELAY_P3_ERROR.BUSY, "send pump"); return; }
      if (pumped.frames.length === 0) break;
      const status = this.drainOutbox();
      if (status === "offline") { this.session.handleDisconnect("transport offline"); return; }
      if (status === "busy") return;
    }
  }

  private drainOutbox(): "drained" | "busy" | "offline" {
    // A synchronous adapter may deliver the peer's response from inside
    // trySend(). That response can enqueue another bootstrap frame and call
    // flush() before trySend() returns. Leave the current head in place for
    // busy retry, but let only its outer sender drain it; the outer loop will
    // see every frame appended by the nested delivery.
    if (this.drainingOutbox) return "busy";
    this.drainingOutbox = true;
    try {
      while (this.outbox.length > 0) {
        const status = this.transport.trySend(this.outbox[0]);
        if (status === "accepted") { this.outbox.shift(); continue; }
        if (status === "busy") return "busy";
        this.outbox.length = 0;
        return "offline";
      }
      return "drained";
    } finally {
      this.drainingOutbox = false;
    }
  }

  /** Bootstrap frames the session sends itself (HELLO, HELLO response)
   * join the ordered outbox; they never overtake a stamped frame. */
  private trySendDirect(bytes: Uint8Array): RelaySendStatus {
    if (this.outbox.length >= this.outboxCap) return "busy";
    this.outbox.push(bytes);
    return this.drainOutbox() === "offline" ? "offline" : "accepted";
  }

  private scheduleFlush(): void {
    if (this.flushScheduled) return;
    this.flushScheduled = true;
    Promise.resolve().then(() => {
      this.flushScheduled = false;
      this.flush();
    });
  }

  private retrySideband(b: Bound): void {
    while (b.pendingSideband.length > 0) {
      const result = b.pendingSideband[0]();
      if (!result.ok && result.code === RELAY_P3_ERROR.SIDEBAND_FULL) return;
      b.pendingSideband.shift();
    }
  }

  /** Provider demand FIFO -> sender queue, per stream in order, as far as
   * the window admits. BUSY keeps the head for the next credit; an
   * unadmittable envelope is dropped and counted. */
  private admitDemand(b: Bound): void {
    for (const [stream, queue] of b.demand) {
      while (queue.length > 0) {
        const env = queue[0];
        const admitted = b.sender.admit({
          type: env.type, stream, codec: env.codec ?? RELAY_CODEC.NONE,
          metadata: env.metadata, data: env.data, correlation: env.correlation,
          priority: priorityFor(env.type),
          association: env.type === RELAY_TYPE.RESPONSE
            ? { kind: "correlation", id: env.correlation }
            : typeof env.metadata.subscription === "number"
              ? { kind: "subscription", id: env.metadata.subscription }
              : undefined,
        });
        if (admitted.ok) {
          queue.shift();
          this.noteSentTerminal(b, env);
          continue;
        }
        if (admitted.code === RELAY_P3_ERROR.BUSY) break;
        queue.shift();
        this.protocolError(admitted.code, `envelope on stream ${stream} not admitted`);
        if (admitted.code === RELAY_P3_ERROR.STREAM_DEAD) queue.length = 0;
      }
      if (queue.length === 0) b.demand.delete(stream);
    }
  }

  /** A terminal RESPONSE the provider admitted to the queue frees its
   * request slot: the work is done and the frame is in the ordered send
   * stream (§3.9: the provider releases its execution slot on completion). */
  private noteSentTerminal(b: Bound, env: RelayResourceEnvelope): void {
    if (env.type !== RELAY_TYPE.RESPONSE || env.metadata.final !== true) return;
    if (b.incomingRequests.get(env.correlation)?.stream !== env.stream) return;
    const recorded = b.incomingRequests.terminal(env.correlation, {
      status: String(env.metadata.status), final: true,
      errorCode: (env.metadata.error as { code?: string } | undefined)?.code,
      effect: typeof env.metadata.effect === "string" ? env.metadata.effect : undefined,
    });
    if (recorded.ok) {
      b.incomingRequests.consumeTerminal(env.correlation);
      b.privateIncoming.get(env.correlation)?.detach?.();
      b.privateIncoming.delete(env.correlation);
    }
  }

  private enqueue(b: Bound, envelope: RelayResourceEnvelope): void {
    const queue = b.demand.get(envelope.stream);
    if (queue) queue.push(envelope);
    else b.demand.set(envelope.stream, [envelope]);
  }

  // --- session hooks --------------------------------------------------------------------

  private onPhase(phase: RelayPhase, detail?: { reason?: string }): void {
    if (phase === "ready-sent" || phase === "hello-received") this.bind();
    else if (phase === "closed" || phase === "idle") this.unbind();
    this.hooks.onPhase?.(phase, detail);
  }

  /** The session is pinned: build this session's machines from the
   * negotiated limits before the first frame on it (READY) is emitted. */
  private bind(): void {
    const negotiation = this.session.negotiation;
    if (!negotiation) return;
    const limits = negotiation.rxLimits;
    const session = this.session.sessionId;
    const control = relayControlSlice(limits);
    const sideband = new RelaySideband();
    const creditTable = new RelayCreditTable();
    const sender = new RelaySender(session, sideband, {
      windowFrames: limits.windowFrames,
      windowBytes: limits.windowBytes,
      controlSlice: control,
      maxWireBytes: limits.maxWireBytes,
      maxMetaBytes: limits.maxMetaBytes,
      codecs: negotiation.codecs,
      framesPerPump: this.options.framesPerPump,
      bytesPerPump: this.options.bytesPerPump ?? limits.windowBytes,
    }, creditTable);
    const allocations = new Map<number, RelayStreamAlloc>([[0, control]]);
    const receiver = new RelayReceiver(session, allocations, creditTable, RELAY_LIMITS.maxStreams, 1);
    const outgoingRequests = new RelayRequestTable(limits.maxPending);
    const incomingRequests = new RelayRequestTable(limits.maxPending);
    const bound: Bound = {
      session, negotiation, sideband, creditTable, sender, allocations, receiver,
      requests: this.role === "guest" ? outgoingRequests : incomingRequests,
      outgoingRequests, incomingRequests, privatePending: new Map(), operationPending: new Map(),
      privateIncoming: new Map(), lastIncoming: new Map(), earlyCancels: new Map(),
      demand: new Map(), pendingSideband: [], streamsByNs: new Map(),
    };
    if (this.role === "guest") {
      bound.assembler = new RelayChunkAssembler({
        maxAssemblies: limits.maxAssemblies, maxScratchBytes: limits.maxScratchBytes,
      });
      bound.client = new RelayResourceClient({
        wire: this.wire,
        negotiated: { maxObjectBytes: limits.maxObjectBytes, codecs: negotiation.codecs, kinds: negotiation.kinds },
        assembler: bound.assembler,
        productForms: {
          validateValue: (profile, kind, value) => this.resourceForms.validateValue(profile, kind, value),
          validateJson: (profile, kind, bytes) => this.validateJsonValue(profile, kind, bytes),
          streamProfile: (stream) => this.session.streamInfo(stream)?.profile,
        },
      });
    } else {
      bound.authority = new RelayResourceAuthority({
        maxWireBytes: limits.maxWireBytes, maxMetaBytes: limits.maxMetaBytes,
        validateLayeredRequest: (stream, op, metadata) => {
          const profile = this.session.streamInfo(stream)?.profile;
          return this.resourceForms.validateRequest(op, profile, metadata);
        },
        validGetRequest: (stream, metadata) =>
          this.resourceForms.validateRequest(RELAY_OP.RESOURCE_GET,
            this.session.streamInfo(stream)?.profile, metadata) === null,
      });
    }
    this.bound = bound;
  }

  /** The session ended: stamped-but-unsent frames are void, every pending
   * get and subscription fails (RESYNC_REQUIRED / onEnd), and the machines
   * are dropped. A reconnect binds a fresh set. */
  private unbind(): void {
    this.outbox.length = 0;
    const b = this.bound;
    if (!b) return;
    this.bound = null;
    this.failPrivate(b);
    for (const stream of b.allocations.keys()) {
      b.outgoingRequests.failStream(stream);
      b.incomingRequests.failStream(stream);
    }
    if (b.client) {
      for (const stream of b.allocations.keys()) if (stream !== 0) b.client.resetStream(stream);
    }
  }

  private onStreamOpened(opened: RelayOpenResult): void {
    const b = this.bound;
    if (!b) return;
    const slice = relayStreamSlice(b.negotiation.rxLimits, b.allocations.values(), opened.rxLimits);
    if (slice.frames < 1 || slice.bytes < 1) {
      this.protocolError(RELAY_P3_ERROR.STREAM_LIMIT, `stream ${opened.stream}: no attachment window left`);
    } else {
      const allocated = b.sender.openStream(opened.stream, slice);
      if (!allocated.ok) this.protocolError(allocated.code, `stream ${opened.stream}: slice refused`);
      else b.allocations.set(opened.stream, slice);
    }
    b.streamsByNs.set(opened.namespace, opened.stream);
    this.hooks.onStreamOpened?.(opened);
  }

  /** Post-bootstrap control frames: OPEN/READY take the control slice as
   * ordinary stream-0 work, ping and pong ride the sideband. */
  private admitControl(input: RelayControlAdmission): { ok: true } | { ok: false; code: string } {
    const b = this.bound;
    if (!b) return { ok: false, code: "NOT_READY" };
    let result: P3Result;
    if (input.metadata.op === RELAY_OP.PING) {
      const token = input.metadata.token as number;
      result = input.type === RELAY_TYPE.REQUEST
        ? b.sender.sendPing(input.correlation, token)
        : b.sender.sendPong(input.correlation, token);
    } else {
      result = b.sender.admit({
        type: input.type, stream: 0, metadata: input.metadata,
        correlation: input.correlation, priority: RELAY_PRIORITY.CONTROL,
      });
    }
    if (!result.ok) {
      return { ok: false, code: result.code === RELAY_P3_ERROR.SIDEBAND_FULL ? "BUSY" : result.code };
    }
    this.scheduleFlush();
    return { ok: true };
  }

  /** An inbound stream-0 record the session consumed held one slot of the
   * peer's control slice; it returns as relay.credit on the next pump.
   * Sideband records earn nothing. */
  private onControlFrame(frame: RelayDecodedFrame, wireBytes: number): void {
    const b = this.bound;
    if (!b || isSidebandFrame(frame)) return;
    const noted = b.creditTable.note(0, 1, wireBytes);
    if (!noted.ok) this.protocolError(noted.code, "control credit row");
  }

  private onBusinessFrame(frame: RelayDecodedFrame, wireBytes: number): void {
    const b = this.bound;
    if (!b) return;
    const association = frame.type === RELAY_TYPE.RESPONSE
      ? { kind: "correlation" as const, id: frame.correlation }
      : frame.type === RELAY_TYPE.PUSH && typeof frame.metadata.subscription === "number"
        ? { kind: "subscription" as const, id: frame.metadata.subscription }
        : undefined;
    const ingested = b.receiver.ingest(frame, wireBytes, association);
    if (ingested.ok) return;
    if (ingested.code === RELAY_P3_ERROR.WINDOW_OVERFLOW || ingested.code === RELAY_P3_ERROR.SESSION_FATAL) {
      // §3.9: the peer sent past the granted window; the attachment ends.
      this.fatal(ingested.code, `stream ${frame.stream} seq ${frame.seq}`);
    } else if (ingested.code === RELAY_P3_ERROR.SEQ_GAP) {
      this.onStreamError(frame.stream, RELAY_ERROR.RESYNC_REQUIRED);
    } else {
      this.protocolError(ingested.code, `stream ${frame.stream} seq ${frame.seq} not staged`);
    }
  }

  private onCredit(metadata: Record<string, unknown>): void {
    const b = this.bound;
    if (!b) return;
    const applied = b.sender.applyCredit(metadata as { targetStream: number; framesReleased: string; bytesReleased: string });
    if (!applied.ok) this.fatal(applied.code, `relay.credit for stream ${String(metadata.targetStream)}`);
  }

  private onPeerReset(metadata: Record<string, unknown>): void {
    const b = this.bound;
    if (!b) return;
    const stream = metadata.targetStream as number;
    this.applyStreamReset(b, stream, `peer: ${String(metadata.reason)}`);
  }

  private onPeerCancel(frame: RelayDecodedFrame): void {
    const b = this.bound;
    if (!b) return;
    const state = b.incomingRequests.get(frame.correlation);
    if (state && state.stream !== frame.metadata.targetStream) {
      this.protocolError(RELAY_P3_ERROR.BAD_CORRELATION, "CANCEL target stream mismatch"); return;
    }
    if (!state) {
      const stream = frame.metadata.targetStream as number;
      if (!b.allocations.has(stream) || stream === 0 || frame.correlation <= (b.lastIncoming.get(stream) ?? 0)) return;
      const old = b.earlyCancels.get(frame.correlation);
      if (old && old.targetStream !== stream) {
        this.protocolError(RELAY_P3_ERROR.BAD_CORRELATION, "early CANCEL stream mismatch"); return;
      }
      if (!old && b.earlyCancels.size >= b.negotiation.rxLimits.maxPending) {
        this.fatal(RELAY_ERROR.BUSY, "early CANCEL capacity exceeded"); return;
      }
      b.earlyCancels.set(frame.correlation, { targetStream: stream, correlation: frame.correlation,
        reason: typeof frame.metadata.reason === "string" ? frame.metadata.reason : "" });
      return;
    }
    if (state) b.incomingRequests.cancel(frame.correlation);
    this.cancelOperation(b, frame.correlation);
    this.hooks.onCancel?.({
      targetStream: frame.metadata.targetStream as number,
      correlation: frame.correlation,
      reason: typeof frame.metadata.reason === "string" ? frame.metadata.reason : "",
      request: state,
    });
  }

  private onStreamError(stream: number, code: string): void {
    const b = this.bound;
    if (!b) return;
    if (code === RELAY_ERROR.RESYNC_REQUIRED && b.allocations.has(stream)) {
      // A seq hole on a reliable stream: resync is a reset of that stream
      // on both ends (draft §3.3); new work needs a new stream id.
      this.resetStream(stream, "seq gap");
      return;
    }
    this.protocolError(code, `stream ${stream}`);
  }

  private applyStreamReset(b: Bound, stream: number, reason: string): void {
    b.receiver.applyReset(stream, reason);
    b.sender.applyReset(stream);
    b.outgoingRequests.failStream(stream);
    b.incomingRequests.failStream(stream);
    this.failPrivate(b, stream);
    b.lastIncoming.delete(stream);
    b.client?.resetStream(stream);
    b.authority?.resetStream(stream);
    b.demand.delete(stream);
    // RESET releases both directions. L1 drops the retired id's records;
    // late credit is ignored by the sender's high-water fence. Keeping
    // these rows until session end would turn namespace churn into a leak.
    b.sender.forgetStream(stream);
    b.receiver.forgetStream(stream);
    b.creditTable.forgetStream(stream);
    b.allocations.delete(stream);
    for (const [ns, s] of b.streamsByNs) if (s === stream) b.streamsByNs.delete(ns);
    this.hooks.onStreamReset?.(stream, reason);
  }

  // --- receive delivery ------------------------------------------------------------------

  /** Deliver staged business frames, one receiver pump at a time (§3.9
   * guest delivery ≤ 1 per pump), up to maxFrames. Each frame is handed
   * to the L2 layer and then released, which is where its wire credit
   * returns. Returns the number delivered. */
  pumpReceive(maxFrames = Number.POSITIVE_INFINITY): number {
    let delivered = 0;
    while (delivered < maxFrames) {
      const b = this.bound;
      if (!b) break;
      const batch = b.receiver.pump();
      if (batch.length === 0) break;
      for (const rx of batch) {
        delivered++;
        this.deliver(b, rx);
        if (this.bound === b && b.allocations.has(rx.stream)) {
          const released = b.receiver.release(rx.handle);
          if (!released.ok) this.protocolError(released.code, `release ${rx.handle}`);
        }
      }
    }
    return delivered;
  }

  private deliver(b: Bound, rx: RelayReceived): void {
    if (rx.frame.type === RELAY_TYPE.REQUEST) {
      this.serveRequest(b, rx.frame, rx.wireBytes);
      const cancel = b.earlyCancels.get(rx.frame.correlation);
      if (cancel && cancel.targetStream === rx.frame.stream) {
        b.earlyCancels.delete(rx.frame.correlation);
        const request = b.incomingRequests.get(rx.frame.correlation);
        if (request) this.hooks.onCancel?.({ ...cancel, request });
      }
      return;
    }
    if (rx.frame.type === RELAY_TYPE.RESPONSE
        && (b.operationPending.has(rx.frame.correlation) || isOperationOp(String(rx.frame.metadata.op)))) {
      this.deliverOperationResponse(b, rx.frame); return;
    }
    if (rx.frame.type === RELAY_TYPE.RESPONSE
        && (b.privatePending.has(rx.frame.correlation) || String(rx.frame.metadata.op).startsWith("x."))) {
      this.deliverPrivateResponse(b, rx.frame, rx.wireBytes); return;
    }
    if (this.role === "guest") this.deliverGuest(b, rx.frame);
    else this.deliverProvider(b, rx.frame);
  }

  private incoming(f: RelayDecodedFrame): RelayResourceIncomingFrame {
    return { type: f.type, codec: f.codec, stream: f.stream, correlation: f.correlation, metadata: f.metadata, data: f.data };
  }

  private deliverGuest(b: Bound, f: RelayDecodedFrame): void {
    const client = b.client!;
    if (f.type === RELAY_TYPE.RESPONSE) {
      const meta = f.metadata;
      const final = meta.final === true;
      const error = meta.error;
      // P3 first: one terminal per request; a response for an unknown or
      // finished request is a peer fault and drops with its credit.
      const recorded = b.requests.terminal(f.correlation, {
        status: typeof meta.status === "string" ? meta.status : "",
        final,
        errorCode: typeof error === "object" && error !== null && typeof (error as { code?: unknown }).code === "string"
          ? (error as { code: string }).code : undefined,
        effect: typeof meta.effect === "string" ? meta.effect : undefined,
      });
      if (!recorded.ok) { this.protocolError(recorded.code, `response for correlation ${f.correlation}`); return; }
      client.handleFrame(this.incoming(f));
      if (final) {
        const consumed = b.requests.consumeTerminal(f.correlation);
        if (!consumed.ok) this.protocolError(consumed.code, `terminal for correlation ${f.correlation}`);
      }
      return;
    }
    if (f.type === RELAY_TYPE.PUSH || f.type === RELAY_TYPE.INVALIDATE) {
      client.handleFrame(this.incoming(f));
      return;
    }
    this.protocolError(RELAY_ERROR.UNSUPPORTED, `guest received frame type ${f.type}`);
  }

  private deliverProvider(b: Bound, f: RelayDecodedFrame): void {
    if (f.type === RELAY_TYPE.INVALIDATE) {
      if (f.metadata.op === RELAY_OP.CACHE_EVICT && validateRelayMetadata(RELAY_OP.CACHE_EVICT, f.metadata) === null) {
        const ref = f.metadata.resource as RelayResourceRef;
        if (!relayKindNegotiated(b.negotiation.kinds, ref.kind)) {
          this.protocolError(RELAY_ERROR.UNSUPPORTED, `kind ${ref.kind} was not negotiated`);
          return;
        }
        this.hooks.onEvict?.(f.metadata);
      } else {
        this.protocolError(RELAY_ERROR.INVALID, `invalidate op ${String(f.metadata.op)} from a consumer`);
      }
      return;
    }
    this.protocolError(RELAY_ERROR.UNSUPPORTED, `provider received frame type ${f.type}`);
  }

  private serveRequest(b: Bound, f: RelayDecodedFrame, wireBytes: number): void {
    const op = f.metadata.op as string;
    if (f.correlation <= (b.lastIncoming.get(f.stream) ?? 0) || b.incomingRequests.get(f.correlation)) {
      this.protocolError(RELAY_P3_ERROR.BAD_CORRELATION, `request id ${f.correlation} reused`); return;
    }
    b.lastIncoming.set(f.stream, f.correlation);
    const admitted = b.incomingRequests.admitKnown(f.stream, f.correlation);
    if (!admitted.ok) {
      // The peer exceeded the negotiated maxPending: refused, not dropped.
      const refused = b.sender.admit(this.privateError({ ...f, op }, RELAY_ERROR.BUSY, "request window full"));
      if (!refused.ok) this.fatal(refused.code, "no capacity to refuse excess requests");
      return;
    }
    const early = b.earlyCancels.get(f.correlation);
    if (early?.targetStream === f.stream) b.incomingRequests.cancel(f.correlation);
    const request: RelayIncomingRequest = {
      stream: f.stream, correlation: f.correlation, op, metadata: f.metadata, data: f.data, codec: f.codec,
      session: b.session,
      cancelRequested: () => b.incomingRequests.get(f.correlation)?.cancelRequested ?? false,
    };
    if (op.startsWith("x.")) { this.servePrivateRequest(b, request, wireBytes); return; }
    if (isOperationOp(op)) { this.serveOperationRequest(b, request, op); return; }
    const authority = b.authority;
    if (!authority) { this.enqueue(b, this.privateError(request, RELAY_ERROR.UNSUPPORTED)); return; }
    const ref = f.metadata.resource as RelayResourceRef | undefined;
    if (typeof ref?.kind === "number" && !relayKindNegotiated(b.negotiation.kinds, ref.kind)) {
      this.respond(op === RELAY_OP.RESOURCE_GET
        ? authority.answerGetError(f, RELAY_ERROR.UNSUPPORTED, `kind ${ref.kind} was not negotiated`)
        : authority.answerError(f, op, RELAY_ERROR.UNSUPPORTED, `kind ${ref.kind} was not negotiated`, ref));
      return;
    }
    switch (op) {
      case RELAY_OP.RESOURCE_SUBSCRIBE: this.respond(authority.answerSubscribe(f)); return;
      case RELAY_OP.RESOURCE_UNSUBSCRIBE: this.respond(authority.answerUnsubscribe(f)); return;
      case RELAY_OP.RESOURCE_RELEASE: this.respond(authority.answerRelease(f)); return;
      case RELAY_OP.RESOURCE_GET: {
        const invalid = this.resourceForms.validateRequest(
          RELAY_OP.RESOURCE_GET, this.session.streamInfo(f.stream)?.profile, f.metadata);
        if (invalid) { this.respond(authority.answerGetError(f, RELAY_ERROR.INVALID, invalid)); return; }
        if (this.hooks.onGet) { this.hooks.onGet(request); return; }
        this.respond(authority.answerGetError(f, RELAY_ERROR.UNSUPPORTED, "no resource source"));
        return;
      }
      default:
        this.respond(authority.answerError(f, op, RELAY_ERROR.UNSUPPORTED, `unknown op ${op}`));
    }
  }

  private serveOperationRequest(b: Bound, request: RelayIncomingRequest, op: RelayOperationOp): void {
    const binding = this.session.streamInfo(request.stream)!;
    const definitions = this.streamOps(request.stream);
    const peerRole = this.role === "guest" ? "provider" : "guest";
    const prepared = prepareOperation(op, { type: RELAY_TYPE.REQUEST, ...request }, binding.rxLimits, definitions);
    let response: Record<string, unknown>;
    const args = prepared.ok ? prepared.metadata.args as RelayOperationEpochArgs & RelayOperationStatusArgs : undefined;
    let error = prepared.ok ? undefined : prepared.code;
    if (!error && !definitions.some(op => op.recovery !== "idempotent" && privateOpAllows(op, peerRole))) error = RELAY_ERROR.UNSUPPORTED;
    if (!error && args!.ns !== binding.namespace) error = RELAY_ERROR.UNAUTHORIZED;
    if (error) response = this.privateError(request, error).metadata;
    else {
      const result = op === RELAY_OP.OPERATION_EPOCH
        ? this.operations.epoch(this.peer.id, args!)
        : this.operations.status(this.peer.id, args!, binding.profile);
      response = result.ok ? { op, status: RELAY_STATUS.OK, final: true, value: result.value } : this.privateError(request, result.code).metadata;
    }
    const terminal = prepareOperation(op, { type: RELAY_TYPE.RESPONSE, stream: request.stream, metadata: response }, binding.rxLimits, definitions);
    if (!terminal.ok) { this.resetStream(request.stream, `operation response refused: ${terminal.code}`); return; }
    this.enqueue(b, { type: RELAY_TYPE.RESPONSE, stream: request.stream, correlation: request.correlation, metadata: terminal.metadata });
  }

  private deliverOperationResponse(b: Bound, frame: RelayDecodedFrame): void {
    const pending = b.operationPending.get(frame.correlation);
    if (!pending) { this.protocolError(RELAY_P3_ERROR.UNKNOWN_REQUEST, "operation response without a request"); return; }
    if (pending.stream !== frame.stream || pending.op !== frame.metadata.op) {
      this.protocolError(RELAY_P3_ERROR.BAD_CORRELATION, "operation response stream/op mismatch"); return;
    }
    const prepared = prepareOperation(pending.op, frame, this.session.streamInfo(frame.stream)!.rxLimits, this.streamOps(frame.stream));
    if (!prepared.ok) { this.protocolError(prepared.code, "operation response schema"); this.resetStream(frame.stream, "invalid operation response"); return; }
    const meta = prepared.metadata;
    const recorded = b.outgoingRequests.terminal(frame.correlation, { final: true, status: meta.status as string });
    if (!recorded.ok) { this.protocolError(recorded.code, "operation terminal"); return; }
    b.outgoingRequests.consumeTerminal(frame.correlation); b.operationPending.delete(frame.correlation);
    pending.resolve(meta.status === RELAY_STATUS.OK ? { ok: true, value: meta.value } : { ok: false, error: meta.error as RelayErrorBody });
  }

  // --- L2 wire seam (guest) ------------------------------------------------------------

  private wireRequest(stream: number, metadata: Record<string, unknown>, data?: Uint8Array, codec?: number): number {
    const b = this.bound;
    if (!b || this.session.phase !== "ready" || !b.allocations.has(stream)) return 0;
    const correlation = this.session.allocateCorrelation();
    if (correlation === 0) return 0;
    const slot = b.outgoingRequests.admitKnown(stream, correlation, this.requestReserve);
    if (!slot.ok) return 0;
    const admitted = b.sender.admit({
      type: RELAY_TYPE.REQUEST, stream, metadata, data,
      codec: codec ?? (data && data.length ? RELAY_CODEC.JSON : RELAY_CODEC.NONE),
      correlation, association: { kind: "correlation", id: correlation },
    });
    if (!admitted.ok) {
      // No frame left: the slot returns; the correlation stays consumed.
      b.outgoingRequests.abandon(correlation);
      return 0;
    }
    // The client registers its pending entry after this call returns; the
    // frame leaves on the next flush, never inside this call.
    this.scheduleFlush();
    return correlation;
  }

  private wireAdvise(metadata: Record<string, unknown>): void {
    const b = this.bound;
    if (!b || this.session.phase !== "ready") return;
    const ref = metadata.resource as RelayResourceRef | undefined;
    const stream = ref ? b.streamsByNs.get(ref.ns) : undefined;
    if (stream === undefined) return; // advisory: no stream for the namespace, nothing to say
    b.sender.admit({
      type: RELAY_TYPE.INVALIDATE, stream, metadata, correlation: 0, priority: RELAY_PRIORITY.CONTROL,
    });
    this.scheduleFlush();
  }

  private wireCancel(stream: number, correlation: number, reason: string): void {
    const b = this.bound;
    if (!b) return;
    const state = b.outgoingRequests.get(correlation);
    if (!state || state.stream !== stream || state.cancelRequested) return;
    b.outgoingRequests.cancel(correlation);
    const sent = b.sender.cancel(stream, correlation, reason);
    if (!sent.ok && sent.code === RELAY_P3_ERROR.SIDEBAND_FULL) {
      b.pendingSideband.push(() => b.outgoingRequests.get(correlation)?.stream === stream
        ? b.sender.cancel(stream, correlation, reason) : { ok: true });
    }
    this.scheduleFlush();
  }

  // --- faults ----------------------------------------------------------------------------

  private protocolError(code: string, detail: string): void {
    this.protocolErrorCount++;
    this.hooks.onProtocolError?.(code, detail);
  }

  /** A fault the attachment cannot continue after (window overflow,
   * out-of-range credit, a dead send pump): counted, reported, and the
   * session closes. */
  private fatal(code: string, detail: string): void {
    this.protocolError(code, detail);
    this.session.close();
  }
}
