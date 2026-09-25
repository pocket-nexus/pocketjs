/** Relay L1/L2 contract — single source of truth for the R5 wire protocol.
 *
 * Every numeric value here is a proposal copied from the R5 draft
 * (/var/tmp/oss/relay-survey/findings/relay-protocol-draft.md); bracketed
 * tags cite the draft clause ([R5-P02] = §3.2, [R5-P03] = §3.3, …).
 * Do not invent a second set of encodings: C and Rust frame layers consume
 * the same constants through tests/fixtures/relay/constants.json and the
 * generated engine/core/src/spec.rs relay module.
 *
 * Scope of P1: framing constants, message/error/codec enums, the control
 * metadata TypeScript types and their strict JSON Schemas. Session state
 * machines and resource delivery are later layers built on these. */

// --- 3.3 fixed frame header -------------------------------------------------

/** ASCII "PRLY": [0x50, 0x52, 0x4c, 0x59]. [R5-P03] */
export const RELAY_MAGIC = Object.freeze([0x50, 0x52, 0x4c, 0x59]);
export const RELAY_MAGIC_TEXT = "PRLY";

/** [R5-P03] v1 fixed header is exactly 48 bytes including the 4-byte length
 * prefix; frameBytes counts everything except that prefix. */
export const RELAY_FRAME = Object.freeze({
  major: 1,
  minor: 0,
  headerBytes: 48,
  /** frameBytes == 44 + metaBytes + dataBytes; wire length == frameBytes + 4. */
  lengthPrefixBytes: 4,
  headerBodyBytes: 44,
});

/** Byte offset and width of every fixed-header field, little-endian. [R5-P03] */
export const RELAY_HEADER = Object.freeze({
  frameBytes: { offset: 0, width: 4 },
  magic: { offset: 4, width: 4 },
  major: { offset: 8, width: 1 },
  minor: { offset: 9, width: 1 },
  type: { offset: 10, width: 1 },
  flags: { offset: 11, width: 1 },
  headerBytes: { offset: 12, width: 2 },
  codec: { offset: 14, width: 2 },
  session: { offset: 16, width: 8 },
  seq: { offset: 24, width: 4 },
  stream: { offset: 28, width: 4 },
  correlation: { offset: 32, width: 4 },
  metaBytes: { offset: 36, width: 4 },
  dataBytes: { offset: 40, width: 4 },
  reserved: { offset: 44, width: 4 },
} as const);

/** The five message types occupy header `type`, not metadata. [R5-P06] */
export const RELAY_TYPE = Object.freeze({
  REQUEST: 1,
  RESPONSE: 2,
  PUSH: 3,
  CANCEL: 4,
  INVALIDATE: 5,
} as const);

/** Frame-layer violation codes returned by encode/decode. These describe why
 * a wire record was rejected before any metadata handler runs; they are not
 * the §3.6 application error.code strings (RELAY_ERROR). [R5-P03/P06] */
export const RELAY_FRAME_ERROR = Object.freeze({
  /** Fewer than 4 bytes/48 bytes available to read the prefix/header. */
  SHORT_HEADER: "SHORT_HEADER",
  /** Length prefix below the fixed header or above u32. */
  BAD_PREFIX: "BAD_PREFIX",
  /** Magic is not ASCII "PRLY". */
  BAD_MAGIC: "BAD_MAGIC",
  /** major is not 1, or minor is not the negotiated 0 for v1. */
  BAD_VERSION: "BAD_VERSION",
  /** type is outside 1..5. */
  BAD_TYPE: "BAD_TYPE",
  /** flags is nonzero; v1 reserves every flag bit. */
  BAD_FLAGS: "BAD_FLAGS",
  /** headerBytes is not exactly 48. */
  BAD_HEADER_SIZE: "BAD_HEADER_SIZE",
  /** The trailing reserved u32 is nonzero. */
  BAD_RESERVED: "BAD_RESERVED",
  /** frameBytes+4 != 48+metaBytes+dataBytes, or fields exceed u32. */
  BAD_LENGTH: "BAD_LENGTH",
  /** The buffer ends before the declared frame completes. */
  TRUNCATED: "TRUNCATED",
  /** Declared wire size exceeds the receiver maxWireBytes guarantee. */
  WIRE_TOO_LARGE: "WIRE_TOO_LARGE",
  /** Declared metadata exceeds the receiver maxMetaBytes guarantee. */
  META_TOO_LARGE: "META_TOO_LARGE",
  /** Codec is not in the negotiated set, or codec 0 carries data. */
  BAD_CODEC: "BAD_CODEC",
  /** session is zero outside the bootstrap HELLO exchange, or does not
   * match the pinned session. */
  BAD_SESSION: "BAD_SESSION",
  /** seq is zero. */
  BAD_SEQ: "BAD_SEQ",
  /** correlation violates the rule for this type (REQUEST/RESPONSE/CANCEL
   * must be >0; PUSH/INVALIDATE must be 0; CANCEL must ride stream 0). */
  BAD_CORRELATION: "BAD_CORRELATION",
  /** Metadata is not strict UTF-8 JSON: invalid bytes, not an object,
   * duplicate keys, lone surrogate, NaN/Infinity, non-integer or unsafe
   * integer, nesting past the depth cap. */
  BAD_METADATA: "BAD_METADATA",
  /** Metadata is strict JSON but breaks an envelope rule (missing/malformed
   * op, RESPONSE status/final, CANCEL targetStream). */
  BAD_ENVELOPE: "BAD_ENVELOPE",
} as const);

export type RelayFrameErrorCode = (typeof RELAY_FRAME_ERROR)[keyof typeof RELAY_FRAME_ERROR];

/** Stable error.code strings carried in RESPONSE metadata. [R5-P06]
 * The action a peer may take is keyed off these codes, never off message. */
export const RELAY_ERROR = Object.freeze({
  UNSUPPORTED: "UNSUPPORTED",
  INVALID: "INVALID",
  UNAUTHORIZED: "UNAUTHORIZED",
  BUSY: "BUSY",
  TOO_LARGE: "TOO_LARGE",
  STALE_BASE: "STALE_BASE",
  NOT_FOUND: "NOT_FOUND",
  CANCELLED: "CANCELLED",
  DEADLINE: "DEADLINE",
  OUTCOME_UNKNOWN: "OUTCOME_UNKNOWN",
  RESYNC_REQUIRED: "RESYNC_REQUIRED",
} as const);

export const RELAY_STATUS = Object.freeze({ OK: "ok", ACCEPTED: "accepted", ERROR: "error" } as const);
export const RELAY_EFFECT = Object.freeze({ NONE: "none", COMMITTED: "committed", UNKNOWN: "unknown" } as const);

/** Operation identities outlive a transport session. [R5-P06/P10] */
export interface RelayOperationEpochArgs {
  ns: string;
  action: "query" | "advance";
  /** Required for advance; compare against the provider's current epoch. */
  expectedEpoch?: string;
}
export interface RelayOperationEpochValue { opEpoch: string }
export interface RelayOperationStatusArgs {
  authority: string;
  ns: string;
  opEpoch: string;
  opId: string;
}
export type RelayOperationState = "pending" | "committed" | "rejected" | "unknown";
export interface RelayOperationStatusValue {
  state: RelayOperationState;
  /** Checked against the profile's installed mutation receipt schemas. */
  receipt?: unknown;
}

/** Management and resource op names. Encoded as metadata ASCII names; they
 * are not new frame types. [R5-P06] */
export const RELAY_OP = Object.freeze({
  HELLO: "relay.hello",
  READY: "relay.ready",
  OPEN: "relay.open",
  CLOSE: "relay.close",
  PING: "relay.ping",
  CREDIT: "relay.credit",
  RESET: "relay.reset",
  RESOURCE_GET: "resource.get",
  RESOURCE_SUBSCRIBE: "resource.subscribe",
  RESOURCE_RELEASE: "resource.release",
  RESOURCE_UNSUBSCRIBE: "resource.unsubscribe",
  REQUEST_CANCEL: "request.cancel",
  RESOURCE_INVALIDATE: "resource.invalidate",
  CACHE_EVICT: "cache.evict",
  OPERATION_STATUS: "operation.status",
  OPERATION_EPOCH: "operation.epoch",
} as const);

/** Data codecs identify the encoding of the trailing data region; codec is
 * not a resource kind and not a HostOp number. [R5-P04] */
export const RELAY_CODEC = Object.freeze({
  NONE: 0, // no data; dataBytes must be 0; args/value stay in metadata
  JSON: 1, // one strict UTF-8 JSON value; metadata carries no `value`
  R5G6B5LE: 0x0101, // r5g6b5le@1: u16LE pixels r5|(g6<<5)|(b5<<11), packed rows
  PMH1: 0x0102, // pocket-map.pmh1@1: PMH1 mesh entry bytes
  COVERAGE2_LSB: 0x0103, // coverage2-lsb@1: four 2-bit samples per byte, low bit first, 4-aligned rows
  INDEXED8_ABGR: 0x0104, // indexed8-abgr@1: 1024B u32LE ABGR palette then row-major indices
  FONT3: 0x0201, // pocket-font3@1: complete FONT v3 blob
  OPAQUE_BYTES: 0x0301, // opaque-bytes@1: declared length/digest, never a host file path
  EXTENSION_MIN: 0x8000, // extension codecs require negotiated name/version
  EXTENSION_MAX: 0xffff,
} as const);

/** Codecs defined by this v1 specification; extension range 0x8000..0xffff
 * is accepted only when the caller enables the negotiated value. [R5-P04] */
export const RELAY_DEFINED_CODECS: readonly number[] = Object.freeze([
  RELAY_CODEC.NONE,
  RELAY_CODEC.JSON,
  RELAY_CODEC.R5G6B5LE,
  RELAY_CODEC.PMH1,
  RELAY_CODEC.COVERAGE2_LSB,
  RELAY_CODEC.INDEXED8_ABGR,
  RELAY_CODEC.FONT3,
  RELAY_CODEC.OPAQUE_BYTES,
]);

/** Resource kinds select semantics; they do not select the wire codec. [R5-P05] */
export const RELAY_KIND = Object.freeze({
  TILE: 1,
  TEXTURE: 2,
  GLYPH_RUN: 3,
  TEXT_LAYOUT: 4,
  MEDIA_CHUNK: 5,
  TERMINAL_CELLS: 6,
  FILE: 7,
  EVENT: 8,
} as const);

// --- 3.5 resource identity --------------------------------------------------

/** UTF-8 byte bounds and shape of ResourceRef. [R5-P05] */
export const RELAY_RESOURCE = Object.freeze({
  nsMaxBytes: 128,
  keyMaxBytes: 256,
  revisionMaxBytes: 128,
  renditionMaxBytes: 128,
});

export interface RelayResourceRef {
  kind: number; // u8 RELAY_KIND
  ns: string; // authenticated authority namespace, <= 128 UTF-8 bytes
  key: string; // profile-defined canonical key, <= 256 UTF-8 bytes
  /** Opaque token <= 128 bytes; get may omit it (current revision),
   * every response/push carries the concrete value. */
  revision?: string;
  rendition: string; // binds codec/dimensions/density/style/font/renderer, <= 128 bytes
}

// --- 3.6 resource op delivery modes, scopes and advisory reasons -------------

/** resource.subscribe delivery modes. [R5-P07] */
export const RELAY_DELIVERY = Object.freeze({
  /** Revision-ordered deltas; a gap stops application and requires resync. */
  RELIABLE_DELTA: "reliable-delta",
  /** Complete snapshots; only the newest unrevised snapshot is applied. */
  LATEST_SNAPSHOT: "latest-snapshot",
} as const);

/** resource.invalidate scope. [R5-P06/P08] */
export const RELAY_INVALIDATE_SCOPE = Object.freeze({
  /** One concrete (ref, revision). */
  REVISION: "revision",
  /** Every revision of ns/kind/key/rendition. */
  KEY: "key",
  /** Every resource in the namespace. */
  NAMESPACE: "namespace",
} as const);

/** cache.evict advisory reason; consumer-side only. [R5-P08, Q5] */
export const RELAY_EVICT_REASON = Object.freeze({
  BUDGET: "budget",
  VIEW_CLOSE: "view-close",
} as const);

/** resource.get args. [R5-P06] */
export interface RelayResourceGetArgs {
  accept: number[]; // u16 RELAY_CODEC values the consumer can decode
  maxObjectBytes: number; // u32 assembled-object ceiling the consumer reserves
  /** Conditional fetch: the revision the consumer already holds. A match
   * comes back status=ok with value.notModified=true and the concrete
   * revision still named at the top level. */
  ifRevision?: string; // <= 128 UTF-8 bytes
}

/** resource.get notModified value; no data region accompanies it. [R5-P06] */
export interface RelayNotModifiedValue {
  notModified: true;
}

export interface RelayResourceSubscribeArgs {
  delivery: string; // one of RELAY_DELIVERY
  /** Authorized-namespace subscription; when present `resource` may be
   * omitted. The filter is still ns/kind/key/rendition. [R5-P06] */
  namespace?: string; // <= 128 UTF-8 bytes
}

export interface RelaySubscribeValue {
  subscription: number; // u32, session-scoped, never reused
}

export interface RelayUnsubscribeArgs {
  subscription: number; // u32
}

export interface RelayResourceReleaseArgs {
  lease: number; // u32 provider-allocated remote-residence lease
}

export interface RelayInvalidateArgs {
  scope: string; // one of RELAY_INVALIDATE_SCOPE
  /** Required for scope=namespace when no resource.ns is supplied. */
  namespace?: string; // <= 128 UTF-8 bytes
  reason?: string; // diagnostics only; the draft sets no byte cap
}

export interface RelayEvictArgs {
  reason: string; // one of RELAY_EVICT_REASON
}

// --- 3.2 handshake and negotiation bounds -----------------------------------

export const RELAY_HANDSHAKE = Object.freeze({
  nonceBytes: 16, // bootNonce/peerNonce: 16 random bytes as 32 lowercase hex chars
  sessionHexLength: 16, // session u64 rendered as 16 lowercase hex chars
  appMaxBytes: 64,
  namespaceMaxBytes: 128,
  versionsMax: 8,
  profilesMax: 16,
  profileNameMaxBytes: 64,
  transportMaxBytes: 64,
});

export type RelayProtocolVersion = readonly [number, number]; // [major:u8, minor:u8]
export interface RelayProfileEntry { name: string; version: number } // name <= 64B, version u16

/** Private REQUEST capabilities live above the byte-only frame layer. */
export type RelayPrivateOpDirection = "guest-to-provider" | "provider-to-guest" | "bidirectional";
export type RelayPrivateOpRecovery = "idempotent" | "epoch" | "durable";
export interface RelayPrivateOpDescriptor {
  profile: RelayProfileEntry;
  name: string; // x.<profile.name>.<local name>, within the 64-byte op grammar
  direction: RelayPrivateOpDirection;
  recovery: RelayPrivateOpRecovery;
  maxWireBytes: number;
  maxObjectBytes: number;
  /** Durable writes use operation.status or a registered idempotent query. */
  recoveryOp?: string;
}
export const RELAY_PRIVATE_OP = Object.freeze({ maxEntries: 16, maxSchemaBytes: 65536 });

export interface RelayTransportDesc {
  id: string; // adapter/profile ASCII id <= 64 bytes
  /** Bulk attachment endpoint: host/port or path, plus a one-use ticket and
   * expiry, bound to session/stream by the selected profile. */
  endpoint?: string;
  ticket?: string;
  expiresAtMs?: number;
}

/** Per-direction receiver guarantees; all fields u32. A peer advertises only
 * limits it can itself honour; negotiation takes min(local, peer). [R5-P02] */
export interface RelayRxLimits {
  maxWireBytes: number;
  maxMetaBytes: number;
  windowFrames: number;
  windowBytes: number;
  maxPending: number;
  maxObjectBytes: number;
  maxAssemblies: number;
  maxScratchBytes: number;
}

/** Decode/materialization ceilings for one codec set. [R5-P02] */
export interface RelayMaterializeLimits {
  residentRamBytes: number; // u32
  gpuBytes: number; // u32
  transientBytes: number; // u32
  maxWidth: number; // u16
  maxHeight: number; // u16
  maxDecodedBytes: number; // u32
}

// --- 3.4 common metadata envelope -------------------------------------------

export interface RelayErrorBody {
  code: string; // one of RELAY_ERROR
  message: string; // diagnostics only, <= 160 UTF-8 bytes
  retryAfterMs?: number;
}

export interface RelayTransfer {
  id: number; // u32, session-scoped, never reused
  offset: string; // u64 as 16 lowercase hex chars
  total: string; // u64 as 16 lowercase hex chars
}

/** Public metadata fields from [R5-P04]. Management/domain method inputs
 * live under args, results under value; resource/status/final/digest stay at
 * the top level. */
export interface RelayFrameMetadata {
  op: string;
  resource?: RelayResourceRef;
  args?: Record<string, unknown> | unknown[];
  value?: unknown;
  status?: string;
  final?: boolean;
  error?: RelayErrorBody;
  effect?: string;
  baseRevision?: string; // <= 128 bytes
  opId?: string; // 16 random bytes as 32 lowercase hex chars
  opEpoch?: string; // provider u64 as 16 lowercase hex chars
  budgetMs?: number; // u32 hard ceiling including provider queueing
  subscription?: number; // session u32 id
  transfer?: RelayTransfer;
  digest?: string; // "sha256:" + 64 lowercase hex chars
  depends?: RelayResourceRef[]; // <= 8 entries, must be ready before publish
}

// --- 3.2 control message metadata types -------------------------------------

/** Device -> companion bootstrap request on session 0. [R5-P02] */
export interface RelayHelloRequestMetadata extends RelayFrameMetadata {
  op: typeof RELAY_OP.HELLO;
  versions: RelayProtocolVersion[]; // <= 8 exact [major,minor] pairs
  bootNonce: string; // 32 lowercase hex chars
  app: string; // <= 64 UTF-8 bytes, must be inside adapter grants
  profiles: RelayProfileEntry[]; // <= 16 entries
  opExt?: RelayPrivateOpDescriptor[]; // installed private REQUEST capabilities
  codecs: number[]; // u16 RELAY_CODEC values supported
  kinds: number[]; // u8 RELAY_KIND values supported
  rxLimits: RelayRxLimits;
  materialize?: RelayMaterializeLimits;
  transport?: RelayTransportDesc;
}

/** Companion -> device selection, still on session 0. [R5-P02]
 * `codecs` is the exact negotiated intersection (peer order); the §3.2
 * field table selects codecs "按双方交集选择" but the response field list
 * in step 3 omitted it — see RELAY-P2-VERIFY erratum E2. */
export interface RelayHelloResponseMetadata extends RelayFrameMetadata {
  op: typeof RELAY_OP.HELLO;
  status: typeof RELAY_STATUS.OK | typeof RELAY_STATUS.ERROR;
  final: true;
  bootNonce: string; // echoed client nonce
  peerNonce: string; // 32 lowercase hex chars
  session: string; // 16 lowercase hex chars, nonzero
  selected: RelayProtocolVersion;
  profiles: RelayProfileEntry[]; // the exact selected subset
  opExt?: RelayPrivateOpDescriptor[]; // private op intersection under selected profiles
  codecs?: number[]; // the exact negotiated codec intersection
  grants: string[]; // authorized app namespaces
  rxLimits: RelayRxLimits;
  transport?: RelayTransportDesc;
}

/** Final error response on the bootstrap/control stream; carries a stable
 * RELAY_ERROR code and never the selection fields. [R5-P02/P06] */
export interface RelayControlErrorMetadata extends RelayFrameMetadata {
  op: string;
  status: typeof RELAY_STATUS.ERROR;
  final: true;
  bootNonce?: string; // hello errors echo the client nonce
  error: RelayErrorBody;
}

/** Device confirms the selected parameters on the new session. [R5-P02] */
export interface RelayReadyRequestMetadata extends RelayFrameMetadata {
  op: typeof RELAY_OP.READY;
  selected: RelayProtocolVersion;
}
export interface RelayReadyResponseMetadata extends RelayFrameMetadata {
  op: typeof RELAY_OP.READY;
  status: typeof RELAY_STATUS.OK;
  final: true;
}

/** Allocate a non-zero stream id for an app/profile binding. [R5-P02] */
export interface RelayOpenRequestMetadata extends RelayFrameMetadata {
  op: typeof RELAY_OP.OPEN;
  app: string;
  namespace: string;
  profile: RelayProfileEntry;
  codecs?: number[];
  rxLimits?: RelayRxLimits;
}
export interface RelayOpenResponseMetadata extends RelayFrameMetadata {
  op: typeof RELAY_OP.OPEN;
  status: typeof RELAY_STATUS.OK;
  final: true;
  stream: number; // companion-allocated, never reused within the session
  namespace: string; // long-lived authority namespace
  profile: RelayProfileEntry;
  rxLimits: RelayRxLimits;
}

/** Liveness only; the u32 token is echoed without clock interpretation. [R5-P06] */
export interface RelayPingRequestMetadata extends RelayFrameMetadata {
  op: typeof RELAY_OP.PING;
  token: number;
}
export interface RelayPingResponseMetadata extends RelayFrameMetadata {
  op: typeof RELAY_OP.PING;
  status: typeof RELAY_STATUS.OK;
  final: true;
  token: number;
}

/** Cumulative release counters on stream 0; u64 counters as hex. [R5-P06/P09] */
export interface RelayCreditMetadata extends RelayFrameMetadata {
  op: typeof RELAY_OP.CREDIT;
  targetStream: number;
  framesReleased: string; // cumulative u64 hex
  bytesReleased: string; // cumulative u64 hex
}

/** Fail every old request/subscription on targetStream. [R5-P06] */
export interface RelayResetMetadata extends RelayFrameMetadata {
  op: typeof RELAY_OP.RESET;
  targetStream: number;
  reason: string; // <= 64 UTF-8 bytes
}

// --- strict JSON Schemas (additionalProperties:false everywhere) ------------

type JsonSchema = Record<string, unknown>;

const u32 = { type: "integer", minimum: 0, maximum: 0xffffffff } as const;
const u16 = { type: "integer", minimum: 0, maximum: 0xffff } as const;
const u8 = { type: "integer", minimum: 0, maximum: 0xff } as const;
const hex16 = { type: "string", pattern: "^[0-9a-f]{16}$" } as const;
const hex32 = { type: "string", pattern: "^[0-9a-f]{32}$" } as const;

const resourceRefSchema: JsonSchema = {
  type: "object",
  additionalProperties: false,
  required: ["kind", "ns", "key", "rendition"],
  properties: {
    kind: u8,
    ns: { type: "string", minLength: 1, maxBytes: RELAY_RESOURCE.nsMaxBytes },
    key: { type: "string", minLength: 1, maxBytes: RELAY_RESOURCE.keyMaxBytes },
    revision: { type: "string", minLength: 1, maxBytes: RELAY_RESOURCE.revisionMaxBytes },
    rendition: { type: "string", minLength: 1, maxBytes: RELAY_RESOURCE.renditionMaxBytes },
  },
};

const rxLimitsSchema: JsonSchema = {
  type: "object",
  additionalProperties: false,
  required: ["maxWireBytes", "maxMetaBytes", "windowFrames", "windowBytes",
    "maxPending", "maxObjectBytes", "maxAssemblies", "maxScratchBytes"],
  properties: {
    maxWireBytes: u32, maxMetaBytes: u32, windowFrames: u32, windowBytes: u32,
    maxPending: u32, maxObjectBytes: u32, maxAssemblies: u32, maxScratchBytes: u32,
  },
};

const materializeSchema: JsonSchema = {
  type: "object",
  additionalProperties: false,
  required: ["residentRamBytes", "gpuBytes", "transientBytes", "maxWidth", "maxHeight", "maxDecodedBytes"],
  properties: {
    residentRamBytes: u32, gpuBytes: u32, transientBytes: u32,
    maxWidth: u16, maxHeight: u16, maxDecodedBytes: u32,
  },
};

const profileEntrySchema: JsonSchema = {
  type: "object",
  additionalProperties: false,
  required: ["name", "version"],
  properties: { name: { type: "string", minLength: 1, maxBytes: RELAY_HANDSHAKE.profileNameMaxBytes }, version: u16 },
};

/** Only descriptors cross HELLO. Product schemas remain local. */
export const RELAY_PRIVATE_OPS_SCHEMA: JsonSchema = {
  type: "array", maxItems: RELAY_PRIVATE_OP.maxEntries,
  items: {
    type: "object", additionalProperties: false,
    required: ["profile", "name", "direction", "recovery", "maxWireBytes", "maxObjectBytes"],
    properties: {
      profile: profileEntrySchema,
      name: { type: "string", pattern: "^x\\.[a-z][a-z0-9_.-]{0,61}$", maxBytes: 64 },
      direction: { enum: ["guest-to-provider", "provider-to-guest", "bidirectional"] },
      recovery: { enum: ["idempotent", "epoch", "durable"] },
      maxWireBytes: { ...u32, minimum: RELAY_FRAME.headerBytes },
      maxObjectBytes: { ...u32, minimum: 1 },
      recoveryOp: { type: "string", pattern: "^(operation\\.status|x\\.[a-z][a-z0-9_.-]{0,61})$", maxBytes: 64 },
    },
  },
};

const transportSchema: JsonSchema = {
  type: "object",
  additionalProperties: false,
  required: ["id"],
  properties: {
    id: { type: "string", minLength: 1, maxBytes: RELAY_HANDSHAKE.transportMaxBytes },
    endpoint: { type: "string", minLength: 1 },
    ticket: { type: "string", minLength: 1 },
    expiresAtMs: u32,
  },
};

const versionSchema: JsonSchema = {
  type: "array",
  minItems: 2,
  maxItems: 2,
  items: [u8, u8],
  additionalItems: false,
};

const errorBodySchema: JsonSchema = {
  type: "object",
  additionalProperties: false,
  required: ["code", "message"],
  properties: {
    code: { type: "string", minLength: 1, maxLength: 32 },
    // 160 matches RELAY_LIMITS.errorMessageMaxBytes (declared below with
    // the other numeric limits); keep the two in sync.
    message: { type: "string", minLength: 1, maxBytes: 160 },
    retryAfterMs: u32,
  },
};

/** Final error RESPONSE for a control op: op + error body only. */
function controlErrorSchema(op: string): JsonSchema {
  return {
    type: "object",
    additionalProperties: false,
    required: ["op", "status", "final", "error"],
    properties: {
      op: { const: op },
      status: { const: RELAY_STATUS.ERROR },
      final: { const: true },
      error: errorBodySchema,
    },
  };
}

/** Final error RESPONSE for a resource op: op + error body, plus the
 * resource when the authority could identify it (a malformed request
 * carries none) and `effect` on a CANCELLED terminal (§3.4: a cancel
 * terminal states none/committed/unknown). The success shape is the op's
 * `.response` schema; an error never repeats `value`. [R5-P06] */
function resourceErrorSchema(op: string): JsonSchema {
  return {
    type: "object",
    additionalProperties: false,
    required: ["op", "status", "final", "error"],
    properties: {
      op: { const: op },
      resource: resourceRefSchema,
      status: { const: RELAY_STATUS.ERROR },
      final: { const: true },
      error: errorBodySchema,
      effect: { type: "string", enum: [RELAY_EFFECT.NONE, RELAY_EFFECT.COMMITTED, RELAY_EFFECT.UNKNOWN] },
    },
  };
}

/** Schemas for the §3.2/§3.6 control messages. All are strict: unknown
 * properties reject. Session-layer code applies the schema matching
 * metadata.op before acting on the message. */
export const RELAY_METADATA_SCHEMAS: Readonly<Record<string, JsonSchema>> = Object.freeze({
  [`${RELAY_OP.OPERATION_EPOCH}.request`]: {
    type: "object", additionalProperties: false, required: ["op", "args"],
    properties: {
      op: { const: RELAY_OP.OPERATION_EPOCH },
      args: {
        type: "object", additionalProperties: false, required: ["ns", "action"],
        properties: {
          ns: { type: "string", minLength: 1, maxBytes: RELAY_RESOURCE.nsMaxBytes },
          action: { enum: ["query", "advance"] }, expectedEpoch: hex16,
        },
      },
    },
  },
  [`${RELAY_OP.OPERATION_EPOCH}.response`]: {
    type: "object", additionalProperties: false, required: ["op", "status", "final", "value"],
    properties: {
      op: { const: RELAY_OP.OPERATION_EPOCH }, status: { const: RELAY_STATUS.OK }, final: { const: true },
      value: { type: "object", additionalProperties: false, required: ["opEpoch"], properties: { opEpoch: hex16 } },
    },
  },
  [`${RELAY_OP.OPERATION_STATUS}.request`]: {
    type: "object", additionalProperties: false, required: ["op", "args"],
    properties: {
      op: { const: RELAY_OP.OPERATION_STATUS },
      args: {
        type: "object", additionalProperties: false, required: ["authority", "ns", "opEpoch", "opId"],
        properties: {
          authority: { type: "string", minLength: 1, maxBytes: 128 },
          ns: { type: "string", minLength: 1, maxBytes: RELAY_RESOURCE.nsMaxBytes },
          opEpoch: hex16, opId: hex32,
        },
      },
    },
  },
  [`${RELAY_OP.OPERATION_STATUS}.response`]: {
    type: "object", additionalProperties: false, required: ["op", "status", "final", "value"],
    properties: {
      op: { const: RELAY_OP.OPERATION_STATUS }, status: { const: RELAY_STATUS.OK }, final: { const: true },
      value: {
        type: "object", additionalProperties: false, required: ["state"],
        properties: {
          state: { enum: ["pending", "committed", "rejected", "unknown"] },
          // prepareOperation applies the installed product receipt schema.
          receipt: {},
        },
      },
    },
  },
  [`${RELAY_OP.OPERATION_EPOCH}.error`]: controlErrorSchema(RELAY_OP.OPERATION_EPOCH),
  [`${RELAY_OP.OPERATION_STATUS}.error`]: controlErrorSchema(RELAY_OP.OPERATION_STATUS),
  [`${RELAY_OP.HELLO}.request`]: {
    type: "object",
    additionalProperties: false,
    required: ["op", "versions", "bootNonce", "app", "profiles", "codecs", "kinds", "rxLimits"],
    properties: {
      op: { const: RELAY_OP.HELLO },
      versions: { type: "array", maxItems: RELAY_HANDSHAKE.versionsMax, items: versionSchema },
      bootNonce: hex32,
      app: { type: "string", minLength: 1, maxBytes: RELAY_HANDSHAKE.appMaxBytes },
      profiles: { type: "array", maxItems: RELAY_HANDSHAKE.profilesMax, items: profileEntrySchema },
      opExt: RELAY_PRIVATE_OPS_SCHEMA,
      codecs: { type: "array", items: u16 },
      kinds: { type: "array", items: u8 },
      rxLimits: rxLimitsSchema,
      materialize: materializeSchema,
      transport: transportSchema,
    },
  },
  [`${RELAY_OP.HELLO}.response`]: {
    type: "object",
    additionalProperties: false,
    // `kinds` is required: the §3.2 field table selects it by mutual
    // intersection, so a response without it cannot confirm any set and the
    // guest would fall back to its own offer (Review 988 B-4). `codecs` stays
    // optional because its fallback is codec 0 alone, which never over-claims.
    required: ["op", "status", "final", "bootNonce", "peerNonce", "session", "selected", "profiles", "kinds", "grants", "rxLimits"],
    properties: {
      op: { const: RELAY_OP.HELLO },
      status: { const: RELAY_STATUS.OK },
      final: { const: true },
      bootNonce: hex32,
      peerNonce: hex32,
      session: { ...hex16, not: { const: "0000000000000000" } },
      selected: versionSchema,
      profiles: { type: "array", items: profileEntrySchema },
      opExt: RELAY_PRIVATE_OPS_SCHEMA,
      codecs: { type: "array", items: u16 },
      kinds: { type: "array", items: u8 },
      grants: { type: "array", items: { type: "string", minLength: 1 } },
      rxLimits: rxLimitsSchema,
      transport: transportSchema,
    },
  },
  [`${RELAY_OP.HELLO}.error`]: {
    type: "object",
    additionalProperties: false,
    required: ["op", "status", "final", "error"],
    properties: {
      op: { const: RELAY_OP.HELLO },
      status: { const: RELAY_STATUS.ERROR },
      final: { const: true },
      bootNonce: hex32,
      error: errorBodySchema,
    },
  },
  [`${RELAY_OP.READY}.error`]: controlErrorSchema(RELAY_OP.READY),
  [`${RELAY_OP.OPEN}.error`]: controlErrorSchema(RELAY_OP.OPEN),
  [`${RELAY_OP.PING}.error`]: controlErrorSchema(RELAY_OP.PING),
  [`${RELAY_OP.READY}.request`]: {
    type: "object",
    additionalProperties: false,
    required: ["op", "selected"],
    properties: { op: { const: RELAY_OP.READY }, selected: versionSchema },
  },
  [`${RELAY_OP.READY}.response`]: {
    type: "object",
    additionalProperties: false,
    required: ["op", "status", "final"],
    properties: {
      op: { const: RELAY_OP.READY },
      status: { const: RELAY_STATUS.OK },
      final: { const: true },
    },
  },
  [`${RELAY_OP.OPEN}.request`]: {
    type: "object",
    additionalProperties: false,
    required: ["op", "app", "namespace", "profile"],
    properties: {
      op: { const: RELAY_OP.OPEN },
      app: { type: "string", minLength: 1, maxBytes: RELAY_HANDSHAKE.appMaxBytes },
      namespace: { type: "string", minLength: 1, maxBytes: RELAY_HANDSHAKE.namespaceMaxBytes },
      profile: profileEntrySchema,
      codecs: { type: "array", items: u16 },
      rxLimits: rxLimitsSchema,
    },
  },
  [`${RELAY_OP.OPEN}.response`]: {
    type: "object",
    additionalProperties: false,
    required: ["op", "status", "final", "stream", "namespace", "profile", "rxLimits"],
    properties: {
      op: { const: RELAY_OP.OPEN },
      status: { const: RELAY_STATUS.OK },
      final: { const: true },
      stream: u32,
      namespace: { type: "string", minLength: 1, maxBytes: RELAY_HANDSHAKE.namespaceMaxBytes },
      profile: profileEntrySchema,
      rxLimits: rxLimitsSchema,
    },
  },
  [`${RELAY_OP.PING}.request`]: {
    type: "object",
    additionalProperties: false,
    required: ["op", "token"],
    properties: { op: { const: RELAY_OP.PING }, token: u32 },
  },
  [`${RELAY_OP.PING}.response`]: {
    type: "object",
    additionalProperties: false,
    required: ["op", "status", "final", "token"],
    properties: {
      op: { const: RELAY_OP.PING },
      status: { const: RELAY_STATUS.OK },
      final: { const: true },
      token: u32,
    },
  },
  [RELAY_OP.CREDIT]: {
    type: "object",
    additionalProperties: false,
    required: ["op", "targetStream", "framesReleased", "bytesReleased"],
    properties: {
      op: { const: RELAY_OP.CREDIT },
      targetStream: u32,
      framesReleased: hex16,
      bytesReleased: hex16,
    },
  },
  [RELAY_OP.RESET]: {
    type: "object",
    additionalProperties: false,
    required: ["op", "targetStream", "reason"],
    properties: {
      op: { const: RELAY_OP.RESET },
      // §3.6 resets a business stream; stream 0 is the reserved control
      // stream and its seq space must survive a forged reset.
      targetStream: { type: "integer", minimum: 1, maximum: 0xffffffff },
      reason: { type: "string", minLength: 1, maxBytes: 64 },
    },
  },

  // --- L2 resource op metadata schemas [R5-P05/P06/P07/P08] ------------------

  [`${RELAY_OP.RESOURCE_GET}.request`]: {
    type: "object",
    additionalProperties: false,
    required: ["op", "resource", "args"],
    properties: {
      op: { const: RELAY_OP.RESOURCE_GET },
      resource: resourceRefSchema,
      args: {
        type: "object",
        additionalProperties: false,
        required: ["accept", "maxObjectBytes"],
        properties: {
          accept: { type: "array", minItems: 1, items: u16 },
          maxObjectBytes: u32,
          ifRevision: { type: "string", minLength: 1, maxBytes: RELAY_RESOURCE.revisionMaxBytes },
        },
      },
      budgetMs: u32,
    },
  },
  [`${RELAY_OP.RESOURCE_GET}.response`]: {
    type: "object",
    additionalProperties: false,
    required: ["op", "resource", "status", "final"],
    properties: {
      op: { const: RELAY_OP.RESOURCE_GET },
      resource: resourceRefSchema,
      status: { type: "string", enum: [RELAY_STATUS.OK, RELAY_STATUS.ERROR] },
      final: { type: "boolean" },
      // Chunked deliveries carry codec-1.. data in the data region; small
      // unchunked results and notModified use value.
      value: { type: "object" },
      transfer: {
        type: "object",
        additionalProperties: false,
        required: ["id", "offset", "total"],
        properties: { id: u32, offset: hex16, total: hex16 },
      },
      digest: { type: "string", pattern: "^sha256:[0-9a-f]{64}$" },
      error: { type: "object" },
    },
  },
  [`${RELAY_OP.RESOURCE_SUBSCRIBE}.request`]: {
    type: "object",
    additionalProperties: false,
    required: ["op", "args"],
    properties: {
      op: { const: RELAY_OP.RESOURCE_SUBSCRIBE },
      resource: resourceRefSchema,
      args: {
        type: "object",
        additionalProperties: false,
        required: ["delivery"],
        properties: {
          delivery: { type: "string", enum: [RELAY_DELIVERY.RELIABLE_DELTA, RELAY_DELIVERY.LATEST_SNAPSHOT] },
          namespace: { type: "string", minLength: 1, maxBytes: RELAY_RESOURCE.nsMaxBytes },
        },
      },
      budgetMs: u32,
    },
  },
  [`${RELAY_OP.RESOURCE_SUBSCRIBE}.response`]: {
    type: "object",
    additionalProperties: false,
    required: ["op", "status", "final", "value"],
    properties: {
      op: { const: RELAY_OP.RESOURCE_SUBSCRIBE },
      resource: resourceRefSchema,
      status: { type: "string", enum: [RELAY_STATUS.OK, RELAY_STATUS.ERROR] },
      final: { const: true },
      value: {
        type: "object",
        additionalProperties: false,
        required: ["subscription"],
        properties: { subscription: u32 },
      },
      error: { type: "object" },
    },
  },
  [`${RELAY_OP.RESOURCE_UNSUBSCRIBE}.request`]: {
    type: "object",
    additionalProperties: false,
    required: ["op", "args"],
    properties: {
      op: { const: RELAY_OP.RESOURCE_UNSUBSCRIBE },
      args: {
        type: "object",
        additionalProperties: false,
        required: ["subscription"],
        properties: { subscription: u32 },
      },
    },
  },
  [`${RELAY_OP.RESOURCE_UNSUBSCRIBE}.response`]: {
    type: "object",
    additionalProperties: false,
    required: ["op", "status", "final"],
    properties: {
      op: { const: RELAY_OP.RESOURCE_UNSUBSCRIBE },
      status: { const: RELAY_STATUS.OK },
      final: { const: true },
      error: { type: "object" },
    },
  },
  [`${RELAY_OP.RESOURCE_RELEASE}.request`]: {
    type: "object",
    additionalProperties: false,
    required: ["op", "resource", "args"],
    properties: {
      op: { const: RELAY_OP.RESOURCE_RELEASE },
      resource: resourceRefSchema,
      args: {
        type: "object",
        additionalProperties: false,
        required: ["lease"],
        properties: { lease: u32 },
      },
    },
  },
  [`${RELAY_OP.RESOURCE_RELEASE}.response`]: {
    type: "object",
    additionalProperties: false,
    required: ["op", "status", "final"],
    properties: {
      op: { const: RELAY_OP.RESOURCE_RELEASE },
      status: { type: "string", enum: [RELAY_STATUS.OK, RELAY_STATUS.ERROR] },
      final: { const: true },
      error: { type: "object" },
    },
  },
  [`${RELAY_OP.RESOURCE_GET}.error`]: resourceErrorSchema(RELAY_OP.RESOURCE_GET),
  [`${RELAY_OP.RESOURCE_SUBSCRIBE}.error`]: resourceErrorSchema(RELAY_OP.RESOURCE_SUBSCRIBE),
  [`${RELAY_OP.RESOURCE_UNSUBSCRIBE}.error`]: resourceErrorSchema(RELAY_OP.RESOURCE_UNSUBSCRIBE),
  [`${RELAY_OP.RESOURCE_RELEASE}.error`]: resourceErrorSchema(RELAY_OP.RESOURCE_RELEASE),
  /** PUSH content for an established subscription. Chunked pushes repeat
   * transfer/digest exactly like get responses. `final` is required on PUSH. */
  "resource.push": {
    type: "object",
    additionalProperties: false,
    required: ["op", "resource", "subscription", "final"],
    properties: {
      op: { type: "string", minLength: 1, maxLength: 64, pattern: "^[a-z][a-z0-9_.-]{0,63}$" },
      resource: resourceRefSchema,
      subscription: u32,
      final: { type: "boolean" },
      value: { type: "object" },
      baseRevision: { type: "string", minLength: 1, maxBytes: RELAY_RESOURCE.revisionMaxBytes },
      transfer: {
        type: "object",
        additionalProperties: false,
        required: ["id", "offset", "total"],
        properties: { id: u32, offset: hex16, total: hex16 },
      },
      digest: { type: "string", pattern: "^sha256:[0-9a-f]{64}$" },
    },
  },
  /** Authority -> consumers. Exactly one of resource (revision/key scope)
   * or args.namespace (namespace scope) identifies the blast radius. */
  [RELAY_OP.RESOURCE_INVALIDATE]: {
    type: "object",
    additionalProperties: false,
    required: ["op", "args"],
    properties: {
      op: { const: RELAY_OP.RESOURCE_INVALIDATE },
      resource: resourceRefSchema,
      args: {
        type: "object",
        additionalProperties: false,
        required: ["scope"],
        properties: {
          scope: { type: "string", enum: [RELAY_INVALIDATE_SCOPE.REVISION, RELAY_INVALIDATE_SCOPE.KEY, RELAY_INVALIDATE_SCOPE.NAMESPACE] },
          namespace: { type: "string", minLength: 1, maxBytes: RELAY_RESOURCE.nsMaxBytes },
          reason: { type: "string", minLength: 1, maxBytes: 160 },
        },
      },
    },
  },
  /** Consumer -> provider advisory. Never an ACK; the provider may ignore it. */
  [RELAY_OP.CACHE_EVICT]: {
    type: "object",
    additionalProperties: false,
    required: ["op", "resource", "args"],
    properties: {
      op: { const: RELAY_OP.CACHE_EVICT },
      resource: resourceRefSchema,
      args: {
        type: "object",
        additionalProperties: false,
        required: ["reason"],
        properties: { reason: { type: "string", enum: [RELAY_EVICT_REASON.BUDGET, RELAY_EVICT_REASON.VIEW_CLOSE] } },
      },
    },
  },
});

// --- 3.7/3.9 proposed limits and timing defaults -----------------------------

/** All values are R5 proposals, not measurements. [R5-P02/P07/P09] */
export const RELAY_LIMITS = Object.freeze({
  /** Bootstrap HELLO/error frames are bounded. [R5-P02] */
  bootstrapMaxWireBytes: 4096,
  /** Control attachment: every frame fits 4096B including the 48B header. [R5-P09] */
  controlMaxWireBytes: 4096,
  controlWindowFrames: 8,
  controlWindowBytes: 32768,
  /** Two 256B sideband slots per direction, reserved for credit/ping/reset/cancel. [R5-P09] */
  sidebandSlots: 2,
  sidebandSlotBytes: 256,
  sidebandCreditTable: 9,
  /** Total admitted in-flight requests per attachment. [R5-P09] */
  maxPending: 8,
  /** Bulk attachment recommendations. [R5-P07/P09] */
  bulkMaxWireBytes: 65536,
  bulkMaxMetaBytes: 2048,
  bulkWindowFrames: 2,
  bulkWindowBytes: 131072,
  bulkMaxAssemblies: 2,
  /** Decoder defaults when the caller passes no limits. [R5-P07] */
  defaultMaxWireBytes: 65536,
  defaultMaxMetaBytes: 2048,
  /** One bulk attachment and at most eight live non-zero streams. [R5-P02]
   * Stream ids are monotonic u32 values, never reused within a session. */
  maxBulkAttachments: 1,
  maxStreams: 8,
  /** Heartbeat/stall/retry are existing-magnitude proposals, not recovery latency. [R5-P02] */
  pingIntervalMs: 2000,
  stallMs: 15000,
  retryMs: 1500,
  /** Metadata JSON rules. [R5-P04/P06] */
  jsonMaxDepth: 16,
  opMaxLength: 64,
  errorMessageMaxBytes: 160,
  cancelReasonMaxBytes: 64,
  dependsMax: 8,
});

/** `op` grammar shared by every frame type. [R5-P04] */
export const RELAY_OP_PATTERN = "^[a-z][a-z0-9_.-]{0,63}$";

// --- deterministic snapshot for cross-language drift guards -----------------

export interface RelayConstantsSnapshot {
  version: number;
  magic: number[];
  magicText: string;
  frame: typeof RELAY_FRAME;
  header: typeof RELAY_HEADER;
  types: typeof RELAY_TYPE;
  frameErrors: typeof RELAY_FRAME_ERROR;
  errors: typeof RELAY_ERROR;
  status: typeof RELAY_STATUS;
  effect: typeof RELAY_EFFECT;
  ops: typeof RELAY_OP;
  codecs: typeof RELAY_CODEC;
  kinds: typeof RELAY_KIND;
  /** L2 string enums: subscribe delivery modes, invalidate scopes and
   * cache.evict reasons (review 1070 N2). */
  delivery: typeof RELAY_DELIVERY;
  invalidateScope: typeof RELAY_INVALIDATE_SCOPE;
  evictReason: typeof RELAY_EVICT_REASON;
  resource: typeof RELAY_RESOURCE;
  handshake: typeof RELAY_HANDSHAKE;
  limits: typeof RELAY_LIMITS;
  opPattern: string;
}

/** Plain JSON value consumed by tests/contract.ts (constants.json drift
 * guard) and by the relay block of generated engine/core/src/spec.rs. */
export function relayConstantsSnapshot(): RelayConstantsSnapshot {
  return {
    version: RELAY_FRAME.major,
    magic: [...RELAY_MAGIC],
    magicText: RELAY_MAGIC_TEXT,
    frame: RELAY_FRAME,
    header: RELAY_HEADER,
    types: RELAY_TYPE,
    frameErrors: RELAY_FRAME_ERROR,
    errors: RELAY_ERROR,
    status: RELAY_STATUS,
    effect: RELAY_EFFECT,
    ops: RELAY_OP,
    codecs: RELAY_CODEC,
    kinds: RELAY_KIND,
    delivery: RELAY_DELIVERY,
    invalidateScope: RELAY_INVALIDATE_SCOPE,
    evictReason: RELAY_EVICT_REASON,
    resource: RELAY_RESOURCE,
    handshake: RELAY_HANDSHAKE,
    limits: RELAY_LIMITS,
    opPattern: RELAY_OP_PATTERN,
  };
}
